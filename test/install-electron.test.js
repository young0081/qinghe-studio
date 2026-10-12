import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureElectronRuntime, verifyArchive } from '../scripts/install-electron.js';

const version = '44.5.0';
const relativeExecutable = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';

function runtimeFiles() {
  const files = { 'path.txt': relativeExecutable, 'dist/version': version, [`dist/${relativeExecutable}`]: 'test executable' };
  if (process.platform === 'win32') {
    for (const filename of ['icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'ffmpeg.dll']) files[`dist/${filename}`] = 'test resource';
  }
  return files;
}

async function packageDirectory(context) {
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'harness-electron-test-'));
  context.after(async () => {
    const relative = path.relative(parent, path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'electron', version, type: 'commonjs' }));
  return directory;
}

async function writeRuntime(directory) {
  for (const [filename, content] of Object.entries(runtimeFiles())) {
    const target = path.join(directory, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function successfulInstaller() {
  return `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
assert.equal(process.env.ELECTRON_INSTALL_PLATFORM, process.platform);
assert.equal(process.env.ELECTRON_INSTALL_ARCH, process.arch);
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_OVERRIDE_DIST_PATH', 'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums']) assert.equal(process.env[name], undefined);
fs.appendFileSync(path.join(__dirname, 'installer-runs.txt'), 'run\\n');
for (const [filename, content] of Object.entries(${JSON.stringify(runtimeFiles())})) {
  const target = path.join(__dirname, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
`;
}

test('existing complete Electron runtime skips installation', async context => {
  const directory = await packageDirectory(context);
  await writeRuntime(directory);
  await writeFile(path.join(directory, 'install.js'), "throw new Error('installer must not run');");
  const messages = [];
  const executable = await ensureElectronRuntime({ electronDirectory: directory, log: message => messages.push(message) });
  assert.equal(executable, path.join(directory, 'dist', relativeExecutable));
  assert.deepEqual(messages, []);
});

test('official installer prepares a missing runtime and concurrent callers share one installation', async context => {
  const directory = await packageDirectory(context);
  await writeFile(path.join(directory, 'install.js'), successfulInstaller());
  const messages = [];
  const options = { electronDirectory: directory, log: message => messages.push(message) };
  const results = await Promise.all([ensureElectronRuntime(options), ensureElectronRuntime(options)]);
  assert.deepEqual(results, [path.join(directory, 'dist', relativeExecutable), path.join(directory, 'dist', relativeExecutable)]);
  assert.equal(await readFile(path.join(directory, 'installer-runs.txt'), 'utf8'), 'run\n');
  assert.equal(messages.length, 1);
});

test('stale runtime is reinstalled instead of launching the wrong version', async context => {
  const directory = await packageDirectory(context);
  await writeRuntime(directory);
  await writeFile(path.join(directory, 'dist', 'version'), '1.0.0');
  await writeFile(path.join(directory, 'install.js'), successfulInstaller());
  await ensureElectronRuntime({ electronDirectory: directory, log: () => {} });
  assert.equal(await readFile(path.join(directory, 'dist', 'version'), 'utf8'), version);
  assert.equal(await readFile(path.join(directory, 'installer-runs.txt'), 'utf8'), 'run\n');
});

test('non-native installer failures report the original error without extraction fallback', async context => {
  const directory = await packageDirectory(context);
  await writeFile(path.join(directory, 'install.js'), "process.stderr.write('Network error ETIMEDOUT'); process.exitCode = 1;");
  await assert.rejects(ensureElectronRuntime({ electronDirectory: directory, log: () => {} }), /安装失败[\s\S]*ETIMEDOUT/);
  assert.deepEqual((await readdir(directory)).sort(), ['install.js', 'package.json']);
  await writeFile(path.join(directory, 'install.js'), successfulInstaller());
  assert.equal(await ensureElectronRuntime({ electronDirectory: directory, log: () => {} }), path.join(directory, 'dist', relativeExecutable));
});

test('invalid Electron package metadata is rejected before starting installer', async context => {
  const directory = await packageDirectory(context);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'not-electron', version }));
  await assert.rejects(ensureElectronRuntime({ electronDirectory: directory, log: () => {} }), /包元数据无效/);
});

test('Windows recognizes the native extractor wrapper error and requires official checksums', { skip: process.platform !== 'win32' }, async context => {
  const directory = await packageDirectory(context);
  await writeFile(path.join(directory, 'install.js'), "process.stderr.write('Error: Cannot find native binding\\n at @electron-internal/extract-zip/binding.js'); process.exitCode = 1;");
  await assert.rejects(ensureElectronRuntime({ electronDirectory: directory, log: () => {} }), /checksums\.json/);
  await writeFile(path.join(directory, 'checksums.json'), JSON.stringify({}));
  await assert.rejects(ensureElectronRuntime({ electronDirectory: directory, log: () => {} }), /未提供[\s\S]*官方校验值/);
});

test('incomplete symlink distribution is rejected without changing the linked directory', async context => {
  const directory = await packageDirectory(context);
  const destination = path.join(directory, 'outside-dist');
  await mkdir(destination);
  await writeFile(path.join(destination, 'preserve.txt'), 'keep');
  await symlink(destination, path.join(directory, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureElectronRuntime({ electronDirectory: directory, log: () => {} }), /不能是符号链接/);
  assert.equal(await readFile(path.join(destination, 'preserve.txt'), 'utf8'), 'keep');
});

test('official archive SHA-256 is required and corrupt ZIP data is rejected', async context => {
  const directory = await packageDirectory(context);
  const archive = path.join(directory, 'electron.zip');
  const contents = Buffer.from('verified archive bytes');
  await writeFile(archive, contents);
  const checksum = createHash('sha256').update(contents).digest('hex');
  await verifyArchive(archive, checksum.toUpperCase());
  await assert.rejects(verifyArchive(archive, undefined), /官方 SHA-256 校验值缺失/);
  await assert.rejects(verifyArchive(archive, '0'.repeat(64)), /SHA-256 与官方校验值不匹配/);
  await writeFile(archive, Buffer.from('corrupt archive bytes'));
  await assert.rejects(verifyArchive(archive, checksum), /SHA-256 与官方校验值不匹配/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInstallerAssets, pixelBitmap, removalManifest } from '../scripts/installer-assets.js';
import { payloadInfo } from '../scripts/installer-frontend.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-installer-test-'));
  context.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('harness-installer-test-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5 });
  });
  return directory;
}

test('installer pixel artwork is deterministic, padded 24-bit BMP with bounded drawing', async context => {
  const bitmap = pixelBitmap(3, 2, [[-1, -1, 2, 2, '#75ac45']]);
  assert.equal(bitmap.subarray(0, 2).toString(), 'BM');
  assert.equal(bitmap.length, 54 + 12 * 2);
  assert.equal(bitmap.readUInt16LE(28), 24);
  assert.deepEqual([...bitmap.subarray(66, 69)], [69, 172, 117]);
  const directory = await fixture(context);
  await createInstallerAssets(directory);
  const first = await readFile(path.join(directory, 'scene.bmp'));
  await createInstallerAssets(directory);
  assert.deepEqual(await readFile(path.join(directory, 'scene.bmp')), first);
  assert.equal((await readFile(path.join(directory, 'header.bmp'))).readInt32LE(18), 150);
});

test('uninstall manifest only deletes explicit payload files and removes empty directories', async context => {
  const directory = await fixture(context);
  await mkdir(path.join(directory, 'resources', 'nested'), { recursive: true });
  await writeFile(path.join(directory, 'Harness Studio.exe'), 'fixture');
  await writeFile(path.join(directory, 'resources', 'app.asar'), 'fixture');
  await writeFile(path.join(directory, 'resources', 'nested', 'asset.txt'), 'fixture');
  const manifest = await removalManifest(directory);
  assert.match(manifest, /Delete "\$INSTDIR\\Harness Studio\.exe"/);
  assert.match(manifest, /Call un.HarnessCheckReparse/);
  assert.doesNotMatch(manifest, /RMDir \/r|\*|\.harness|\$APPDATA|\$PROFILE/);
  assert.ok(manifest.indexOf('RMDir "$INSTDIR\\resources\\nested"') < manifest.indexOf('RMDir "$INSTDIR\\resources"'));
});

test('installer manifest rejects incomplete payloads, preprocessor injection and directory links', async context => {
  const directory = await fixture(context);
  await assert.rejects(removalManifest(directory), /payload must contain/);
  await writeFile(path.join(directory, '$danger.txt'), 'fixture');
  await assert.rejects(removalManifest(directory), /Unsafe installer payload/);
  await rm(path.join(directory, '$danger.txt'));
  const target = path.join(directory, 'real');
  await mkdir(target);
  await symlink(target, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removalManifest(directory), /Unsafe installer payload/);
});

test('self-drawn Windows installer validates command lines, safe paths, ownership and XAML templates', { skip: process.platform !== 'win32', timeout: 30000 }, async context => {
  const directory = await fixture(context);
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const configuration = path.join(directory, 'BuildInfo.cs');
  await writeFile(configuration, `namespace HarnessSetup { internal static class BuildInfo { public const string AppGuid = "qinghe-installer-unit-${randomUUID()}"; public const string Version = "1.15.2"; public const string EngineHash = "unused"; public const long PayloadBytes = 0; } }`);
  const executable = path.join(directory, 'validation.exe');
  await execute(path.join(framework, 'csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/codepage:65001', '/main:InstallerValidationTests', `/out:${executable}`,
    ...['WindowsBase', 'PresentationCore', 'PresentationFramework', 'System.Xaml'].map(name => `/reference:${path.join(framework, name === 'System.Xaml' ? '' : 'WPF', `${name}.dll`)}`),
    path.join(root, 'desktop', 'installer', 'Setup.cs'), path.join(root, 'desktop', 'installer', 'FolderPicker.cs'),
    path.join(root, 'test', 'installer-validation.cs'), configuration,
  ], { windowsHide: true });
  const { stdout } = await execute(executable, [directory, path.join(root, 'desktop', 'installer', 'Setup.xaml')], { windowsHide: true });
  assert.match(stdout, /Installer validation passed/);
});

test('installer engine cache fingerprints payload content rather than only filenames and sizes', async context => {
  const directory = await fixture(context);
  await mkdir(path.join(directory, 'resources'));
  const filename = path.join(directory, 'resources', 'app.asar');
  await writeFile(filename, 'first');
  const first = await payloadInfo(directory);
  assert.equal(first.bytes, 5);
  assert.deepEqual(await payloadInfo(directory), first);
  await writeFile(filename, 'other');
  assert.notEqual((await payloadInfo(directory)).digest, first.digest);
});

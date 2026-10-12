import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const inProgress = new Map();

function executableName(platform) {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  if (['linux', 'freebsd', 'openbsd'].includes(platform)) return 'electron';
  throw new Error(`不支持此桌面平台：${platform}`);
}

function containedPath(directory, filename) {
  const resolved = path.resolve(filename);
  const relative = path.relative(directory, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Electron 安装路径超出包目录');
  return resolved;
}

async function distributionExecutable(distribution, version, relativeExecutable, platform) {
  try {
    if ((await readFile(path.join(distribution, 'version'), 'utf8')).trim().replace(/^v/, '') !== version) return null;
    const executable = path.join(distribution, relativeExecutable);
    if (!(await stat(executable)).isFile()) return null;
    if (platform === 'win32') {
      for (const filename of ['icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'ffmpeg.dll']) {
        if (!(await stat(path.join(distribution, filename))).isFile()) return null;
      }
    }
    return executable;
  } catch { return null; }
}

async function installedExecutable(directory, version, relativeExecutable, platform) {
  try {
    if ((await readFile(path.join(directory, 'path.txt'), 'utf8')).trim() !== relativeExecutable) return null;
    return await distributionExecutable(path.join(directory, 'dist'), version, relativeExecutable, platform);
  } catch { return null; }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    const capture = chunk => { output = `${output}${chunk}`.slice(-32000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', rejectRun);
    child.once('close', code => resolveRun({ code, output }));
  });
}

export async function verifyArchive(filename, expectedHash) {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? '')) throw new Error('Electron 官方 SHA-256 校验值缺失');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  if (digest.digest('hex').toLowerCase() !== expectedHash.toLowerCase()) throw new Error('Electron ZIP 的 SHA-256 与官方校验值不匹配，已停止安装');
}

async function ensurePlainDirectory(directory) {
  try {
    const information = await lstat(directory);
    if (information.isSymbolicLink() || !information.isDirectory()) throw new Error('Electron dist 必须是普通目录，不能是符号链接');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function installWindowsFallback(directory, version, architecture, log) {
  const checksums = JSON.parse(await readFile(path.join(directory, 'checksums.json'), 'utf8'));
  const filename = `electron-v${version}-win32-${architecture}.zip`;
  const checksum = checksums[filename];
  if (!/^[a-f0-9]{64}$/i.test(checksum ?? '')) throw new Error(`当前 Electron 包未提供 ${filename} 的官方校验值`);
  const electronRequire = createRequire(path.join(directory, 'package.json'));
  const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve('@electron/get')).href);
  log('Windows 原生解压组件不可用，改用系统解压已校验的 Electron 安装包。');
  const archive = await downloadArtifact({ version, artifactName: 'electron', platform: 'win32', arch: architecture, checksums, unsafelyDisableChecksums: false });
  await verifyArchive(archive, checksum);
  const staging = containedPath(directory, await mkdtemp(path.join(directory, '.harness-extract-')));
  const distribution = containedPath(directory, path.join(directory, 'dist'));
  const backup = containedPath(directory, path.join(directory, `.harness-backup-${randomUUID()}`));
  const marker = containedPath(directory, path.join(directory, `.harness-path-${randomUUID()}.tmp`));
  let backedUp = false;
  let replaced = false;
  try {
    const extracted = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psd1') -Force; Expand-Archive -LiteralPath $env:HARNESS_ELECTRON_ARCHIVE -DestinationPath $env:HARNESS_ELECTRON_STAGE -Force"], { env: { ...process.env, HARNESS_ELECTRON_ARCHIVE: archive, HARNESS_ELECTRON_STAGE: staging } });
    if (extracted.code !== 0) throw new Error(`系统解压 Electron 失败：${extracted.output.trim().slice(-1200)}`);
    if (!await distributionExecutable(staging, version, 'electron.exe', 'win32')) throw new Error('Electron 解压内容不完整或版本不匹配');
    await ensurePlainDirectory(distribution);
    try { await rename(distribution, backup); backedUp = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(staging, distribution);
    replaced = true;
    await writeFile(marker, 'electron.exe', 'utf8');
    await rename(marker, path.join(directory, 'path.txt'));
  } catch (error) {
    if (replaced) await rm(containedPath(directory, distribution), { recursive: true, force: true });
    if (backedUp) await rename(backup, distribution);
    throw error;
  } finally {
    await rm(containedPath(directory, staging), { recursive: true, force: true });
    await rm(containedPath(directory, marker), { force: true });
  }
  if (backedUp) await rm(containedPath(directory, backup), { recursive: true, force: true });
}

async function ensureInstalled(directory, log) {
  const information = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (information.name !== 'electron' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(information.version)) throw new Error('Electron 包元数据无效，请重新运行 npm install');
  const relativeExecutable = executableName(process.platform);
  await ensurePlainDirectory(path.join(directory, 'dist'));
  const existing = await installedExecutable(directory, information.version, relativeExecutable, process.platform);
  if (existing) return existing;
  log(`正在准备 Electron ${information.version} 桌面运行时…`);
  const environment = { ...process.env, ELECTRON_INSTALL_PLATFORM: process.platform, ELECTRON_INSTALL_ARCH: process.arch };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_OVERRIDE_DIST_PATH', 'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums']) delete environment[key];
  const installed = await run(process.execPath, [path.join(directory, 'install.js')], { cwd: directory, env: environment });
  const executable = await installedExecutable(directory, information.version, relativeExecutable, process.platform);
  if (installed.code === 0 && executable) return executable;
  const nativeFailure = /ERR_DLOPEN_FAILED|Cannot find native binding/.test(installed.output) && /extract-zip/.test(installed.output);
  if (process.platform !== 'win32' || (installed.code !== 0 && !nativeFailure)) throw new Error(`Electron 安装失败。请检查网络后重新运行 node scripts/install-electron.js。\n${installed.output.trim().slice(-1500)}`);
  await installWindowsFallback(directory, information.version, process.arch, log);
  const recovered = await installedExecutable(directory, information.version, relativeExecutable, process.platform);
  if (!recovered) throw new Error('Electron 安装验证失败，请重新运行 node scripts/install-electron.js');
  return recovered;
}

export async function ensureElectronRuntime({ electronDirectory, log = message => process.stderr.write(`${message}\n`) } = {}) {
  let directory;
  try { directory = await realpath(electronDirectory ?? path.dirname(require.resolve('electron/package.json'))); }
  catch { throw new Error('Electron 依赖尚未安装，请先运行 npm install'); }
  if (!inProgress.has(directory)) inProgress.set(directory, ensureInstalled(directory, log).finally(() => inProgress.delete(directory)));
  return inProgress.get(directory);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const executable = await ensureElectronRuntime();
    process.stdout.write(`Electron 运行时已就绪：${executable}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

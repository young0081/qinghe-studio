import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import { VERSION } from '../src/version.js';
import { createHarness } from '../src/core/harness.js';
import { docx, documentText } from '../test/fixtures/attachments.js';

if (process.platform !== 'win32') throw new Error('Installer smoke verification requires Windows');
const root = fileURLToPath(new URL('../', import.meta.url));
const prepackaged = path.resolve(process.argv[2] || path.join(root, 'release', `runtime-${VERSION}`, 'win-unpacked'));
const production = path.join(root, 'release', `Qinghe-Studio-Setup-${VERSION}-win-x64.exe`);
await access(production);
const testId = process.env.HARNESS_INSTALLER_TEST_ID || randomUUID();
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(testId) || testId === '7c01eafb-feec-5b68-a6eb-d4308d7c38bf') throw new Error('Use a unique, non-production installer test UUID');
const temporaryRoot = await realpath(os.tmpdir());
const temporary = await mkdtemp(path.join(temporaryRoot, 'harness-installer-test-'));
const installed = path.join(temporary, 'Harness Studio');
const workspace = path.join(temporary, 'user-workspace');
const userData = path.join(temporary, 'desktop-preferences');
const testInstaller = path.join(root, 'release', 'installer-tests', testId, path.basename(production));
const screenshots = path.resolve(process.env.HARNESS_INSTALLER_SCREENSHOTS || path.join(temporary, 'screenshots'));
let application;
let completed = false;

function command(executable, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    const { expectedExit = 0, ...spawnOptions } = options;
    const child = spawn(executable, argumentsList, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Command timed out: ${executable}`)); }, 300000);
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === expectedExit ? resolve(output) : reject(new Error(`Command exited ${code}, expected ${expectedExit}: ${output.slice(-3000)}`)); });
  });
}

async function gui(executable, mode, rejectedDirectory, noDesktopShortcut = false, expectedDirectory) {
  await command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'installer-ui.ps1'), '-Executable', executable, '-TargetDirectory', installed, '-Mode', mode, ...(['install', 'uninstall', 'preview'].includes(mode) ? ['-Screenshots', expectedDirectory ? path.join(screenshots, expectedDirectory === installed ? 'upgrade-default' : 'fresh-default') : screenshots] : []), ...(rejectedDirectory ? ['-RejectedDirectory', rejectedDirectory] : []), ...(noDesktopShortcut ? ['-NoDesktopShortcut'] : []), ...(expectedDirectory ? ['-UseDefaultDirectory', '-ExpectedDirectory', expectedDirectory] : [])]);
}

async function registry(present) {
  const installKey = ['Registry::HKEY_CURRENT_USER', 'Software', testId].join('\\');
  const uninstallKey = ['Registry::HKEY_CURRENT_USER', 'Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall', testId].join('\\');
  const check = present ? "if (-not (Test-Path -LiteralPath $env:HARNESS_INSTALL_TEST_UNINSTALL_KEY)) { throw 'Missing uninstall registration' }; if ((Get-ItemProperty -LiteralPath $env:HARNESS_INSTALL_TEST_UNINSTALL_KEY).DisplayName -ne $env:HARNESS_INSTALL_TEST_NAME) { throw 'Unexpected installer registration' }; if ((Get-ItemProperty -LiteralPath $env:HARNESS_INSTALL_TEST_KEY).InstallLocation -ne $env:HARNESS_INSTALL_TEST_TARGET) { throw 'Install location mismatch' }" : "if (Test-Path -LiteralPath $env:HARNESS_INSTALL_TEST_UNINSTALL_KEY) { throw 'Uninstall registration remains' }";
  await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + check], { env: { ...process.env, HARNESS_INSTALL_TEST_NAME: `Qinghe Studio Setup Test ${testId}`, HARNESS_INSTALL_TEST_TARGET: installed, HARNESS_INSTALL_TEST_KEY: installKey, HARNESS_INSTALL_TEST_UNINSTALL_KEY: uninstallKey } });
}

async function shortcuts(present, desktop = present) {
  await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; $shell = New-Object -ComObject WScript.Shell; foreach ($kind in @('Desktop', 'Programs')) { $folder = [Environment]::GetFolderPath($kind); $file = Join-Path $folder ($env:HARNESS_INSTALL_TEST_NAME + '.lnk'); $required = if ($kind -eq 'Desktop') { $env:HARNESS_INSTALL_TEST_DESKTOP } else { $env:HARNESS_INSTALL_TEST_PRESENT }; if ($required -eq '1') { if (-not (Test-Path -LiteralPath $file)) { throw 'Missing test shortcut' }; if ($shell.CreateShortcut($file).TargetPath -ne $env:HARNESS_INSTALL_TEST_TARGET) { throw 'Wrong shortcut target' } } elseif (Test-Path -LiteralPath $file) { throw 'Unexpected test shortcut' } }"], { env: { ...process.env, HARNESS_INSTALL_TEST_NAME: `Qinghe Studio Setup Test ${testId}`, HARNESS_INSTALL_TEST_TARGET: path.join(installed, 'Harness Studio.exe'), HARNESS_INSTALL_TEST_PRESENT: present ? '1' : '0', HARNESS_INSTALL_TEST_DESKTOP: desktop ? '1' : '0' } });
}

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

try {
  await registry(false);
  process.stdout.write('Inspecting the actual release installer without installing it…\n');
  await gui(production, 'preview');
  process.stdout.write(`Building an isolated registration/shortcut identity: ${testId}\n`);
  await command(process.execPath, [path.join(root, 'scripts', 'build-installer.js'), '--prepackaged', prepackaged, '--test-id', testId, ...(process.env.HARNESS_INSTALLER_REUSE_ENGINE === '1' ? ['--reuse-engine'] : [])], { env: { ...process.env, ELECTRON_BUILDER_COMPRESSION_LEVEL: '5' } });
  await gui(testInstaller, 'preview', undefined, false, path.join(process.env.LOCALAPPDATA, 'Programs', '青禾 Studio'));
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'keep.txt'), 'User project must survive installation and uninstall');
  await gui(testInstaller, 'reject', workspace);
  const junction = path.join(temporary, 'redirected-install');
  await symlink(workspace, junction, 'junction');
  await gui(testInstaller, 'reject', junction);
  await gui(testInstaller, 'reject', path.parse(installed).root);
  const engine = path.join(path.dirname(testInstaller), 'installer-engine', `Qinghe-Studio-Engine-${VERSION}-win-x64.exe`);
  for (const candidate of [workspace, junction, path.parse(installed).root]) {
    await command(engine, ['/S', '/currentuser', `/D=${candidate}`], { windowsVerbatimArguments: true, expectedExit: 2 });
  }
  await gui(testInstaller, 'install');
  await registry(true);
  await shortcuts(true);
  await gui(testInstaller, 'preview', undefined, false, installed);
  assert.equal(await digest(path.join(installed, 'resources', 'app.asar')), await digest(path.join(prepackaged, 'resources', 'app.asar')));
  const harness = await createHarness({ workspace, settings: { provider: 'responses', model: 'installer-test-model', apiKey: 'installer-test-key', baseUrl: 'http://127.0.0.1:9/v1' } });
  await harness.close();
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: path.join(installed, 'Harness Studio.exe'), cwd: temporary, args: ['--workspace', workspace, '--user-data', userData], env: environment, timeout: 30000 });
  const page = await application.firstWindow();
  await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.harnessDesktop.getState()).version)).toBe(VERSION);
  await page.getByLabel('导入附件文件', { exact: true }).setInputFiles({ name: '安装验证.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
  await page.getByRole('button', { name: '预览附件 安装验证.docx', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(documentText);
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await gui(testInstaller, 'busy');
  await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toBeVisible();
  await application.close();
  application = null;
  await mkdir(path.join(installed, 'resources', 'user-project', '.harness'), { recursive: true });
  const extra = path.join(installed, 'resources', 'user-project', '.harness', 'keep.txt');
  await writeFile(extra, 'Unlisted user files must survive upgrades and uninstall');
  process.stdout.write('Reinstalling through the real upgrade path…\n');
  await gui(testInstaller, 'install', undefined, true);
  assert.equal(await readFile(extra, 'utf8'), 'Unlisted user files must survive upgrades and uninstall');
  await registry(true);
  await shortcuts(true, false);
  process.stdout.write('Verifying the silent frontend and persisted shortcut preference…\n');
  await command(testInstaller, ['/S']);
  await shortcuts(true, false);
  assert.equal(await readFile(extra, 'utf8'), 'Unlisted user files must survive upgrades and uninstall');
  await gui(path.join(installed, 'Uninstall Harness Studio.exe'), 'uninstall');
  await registry(false);
  await shortcuts(false);
  assert.equal(await readFile(extra, 'utf8'), 'Unlisted user files must survive upgrades and uninstall');
  assert.equal(await readFile(path.join(workspace, 'keep.txt'), 'utf8'), 'User project must survive installation and uninstall');
  await access(path.join(workspace, '.harness', 'settings.json'));
  await access(userData);
  completed = true;
  process.stdout.write('Installer passed: release GUI, path safety, real installation, shortcuts/registration, installed Electron/Office import, upgrade, uninstall and data preservation.\n');
} finally {
  await application?.close().catch(() => {});
  if (completed) {
    const resolved = await realpath(temporary);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('harness-installer-test-')) throw new Error('Refusing to remove an unexpected test directory');
    await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  } else process.stderr.write(`Isolated test files retained for diagnosis: ${temporary}\nTest registration ID: ${testId}\n`);
}

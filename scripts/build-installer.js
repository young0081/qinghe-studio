import { build, Platform, Arch } from 'electron-builder';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstallerAssets, removalManifest } from './installer-assets.js';
import { compileFrontend, ensureNotRunning, hashFile, payloadInfo } from './installer-frontend.js';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const argumentsList = process.argv.slice(2);
let prepackaged;
let testId;
let reuseEngine = false;
for (let index = 0; index < argumentsList.length; index++) {
  const argument = argumentsList[index];
  if (argument === '--reuse-engine') { reuseEngine = true; continue; }
  if (!['--prepackaged', '--test-id'].includes(argument) || !argumentsList[index + 1]) throw new Error('Usage: node scripts/build-installer.js [--prepackaged PATH] [--test-id UUID] [--reuse-engine]');
  if (argument === '--prepackaged') prepackaged = path.resolve(argumentsList[++index]);
  else testId = argumentsList[++index];
}
if (process.platform !== 'win32') throw new Error('Windows installer builds require Windows');
if (testId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(testId)) throw new Error('Installer test ID must be a UUID');
if (testId?.toLowerCase() === '7c01eafb-feec-5b68-a6eb-d4308d7c38bf') throw new Error('Installer test identity must not match the production GUID');
if (reuseEngine && !prepackaged) throw new Error('--reuse-engine requires an explicit --prepackaged directory');
const generated = path.join(root, 'desktop', 'installer', 'generated');
await createInstallerAssets(generated);

async function run(script, argumentsList = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...argumentsList], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  });
}

if (!prepackaged) {
  await run('scripts/create-icon.js');
  await run('node_modules/vite/bin/vite.js', ['build']);
  const output = path.join(root, 'release', `installer-stage-${VERSION}`);
  await new Promise((resolve, reject) => {
    const check = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'if (@(Get-Process | Where-Object { $_.Path -eq $env:HARNESS_INSTALLER_BUILD_TARGET }).Count) { exit 2 }'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, HARNESS_INSTALLER_BUILD_TARGET: path.join(output, 'win-unpacked', 'Harness Studio.exe') } });
    check.once('error', reject);
    check.once('exit', code => code === 0 ? resolve() : reject(new Error('Installer staging application is running; close it before rebuilding.')));
  });
  const marker = path.join(output, '.harness-build');
  await mkdir(output, { recursive: true });
  await writeFile(marker, 'Dedicated installer build output');
  await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64), config: { directories: { output }, electronDist: path.join(root, 'node_modules', 'electron', 'dist') } });
  prepackaged = path.join(output, 'win-unpacked');
}
prepackaged = await realpath(prepackaged);
await access(path.join(prepackaged, 'Harness Studio.exe'));
await writeFile(path.join(generated, 'remove-files.nsh'), await removalManifest(prepackaged));
const output = path.join(root, 'release', ...(testId ? ['installer-tests', testId] : []));
const frontend = path.join(output, `Qinghe-Studio-Setup-${VERSION}-win-x64.exe`);
const engineOutput = path.join(output, 'installer-engine');
const engine = path.join(engineOutput, `Qinghe-Studio-Engine-${VERSION}-win-x64.exe`);
const appGuid = testId || '7c01eafb-feec-5b68-a6eb-d4308d7c38bf';
await ensureNotRunning(frontend);
await ensureNotRunning(engine);
const nsis = {
  oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: false,
  installerLanguages: ['zh_CN'], displayLanguageSelector: false,
  include: 'desktop/installer/installer.nsh', installerHeader: 'desktop/installer/generated/header.bmp',
  installerSidebar: 'desktop/installer/generated/sidebar.bmp', uninstallerSidebar: 'desktop/installer/generated/sidebar.bmp',
  createDesktopShortcut: false, createStartMenuShortcut: true, deleteAppDataOnUninstall: false,
  shortcutName: '青禾 Studio', uninstallDisplayName: '青禾 Studio ${version}',
  runAfterFinish: false, artifactName: 'Qinghe-Studio-Engine-${version}-win-${arch}.${ext}', guid: appGuid,
  ...(testId ? { guid: testId, shortcutName: `Qinghe Studio Setup Test ${testId}`, uninstallDisplayName: `Qinghe Studio Setup Test ${testId}` } : {}),
};
const payload = await payloadInfo(prepackaged);
const fingerprint = createHash('sha256').update(JSON.stringify({ version: VERSION, appGuid, payload, nsis }));
for (const filename of ['desktop/installer/installer.nsh', 'scripts/installer-assets.js', 'desktop/installer/generated/remove-files.nsh', 'package.json']) fingerprint.update(await readFile(path.join(root, filename)));
const cacheKey = fingerprint.digest('hex');
const cacheMetadata = path.join(engineOutput, 'engine-build.json');
if (reuseEngine) {
  const cached = JSON.parse(await readFile(cacheMetadata, 'utf8'));
  if (cached.cacheKey !== cacheKey || cached.engineHash !== await hashFile(engine)) throw new Error('Installer engine is stale or damaged; rebuild without --reuse-engine');
} else {
  await build({ projectDir: root, prepackaged, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config: { directories: { output: engineOutput }, nsis, ...(testId ? { appId: `dev.harness.studio.installer-test.${testId}` } : {}) } });
  await writeFile(cacheMetadata, JSON.stringify({ cacheKey, engineHash: await hashFile(engine) }));
}
await compileFrontend({ root, engine, output: frontend, appGuid, version: VERSION, size: payload.bytes });
process.stdout.write(`Self-drawn installer ready: ${frontend}\n`);

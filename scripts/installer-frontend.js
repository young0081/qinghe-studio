import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureNotRunning(filename) {
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'if (@(Get-Process | Where-Object { $_.Path -eq $env:HARNESS_INSTALLER_BUILD_TARGET }).Count) { exit 2 }'], { ...process.env, HARNESS_INSTALLER_BUILD_TARGET: filename });
}

export function execute(executable, argumentsList, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, { windowsHide: true, stdio: 'inherit', env: environment });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}; close any running build target before rebuilding.`)));
  });
}

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function payloadInfo(directory) {
  let bytes = 0;
  const hash = createHash('sha256');
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((first, second) => first.name.localeCompare(second.name))) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected payload link: ${filename}`);
    const info = entry.isDirectory() ? await payloadInfo(filename) : { bytes: (await stat(filename)).size, digest: await hashFile(filename) };
    bytes += info.bytes;
    hash.update(`${entry.name}\0${info.digest}\0`);
  }
  return { bytes, digest: hash.digest('hex') };
}

export async function compileFrontend({ root, engine, output, appGuid, version, size }) {
  await ensureNotRunning(output);
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  await access(compiler);
  const engineHash = await hashFile(engine);
  const source = path.join(root, 'desktop', 'installer');
  const info = path.join(path.dirname(engine), 'BuildInfo.cs');
  await writeFile(info, `using System.Reflection;\n[assembly: AssemblyTitle("青禾 Studio 安装器")]\n[assembly: AssemblyProduct("青禾 Studio")]\n[assembly: AssemblyCompany("Qn")]\n[assembly: AssemblyCopyright("Copyright © Qn")]\n[assembly: AssemblyVersion(${JSON.stringify(version + '.0')})]\nnamespace HarnessSetup { internal static class BuildInfo { public const string Version = ${JSON.stringify(version)}; public const string AppGuid = ${JSON.stringify(appGuid)}; public const string EngineHash = "${engineHash}"; public const long PayloadBytes = ${size}L; } }\n`);
  const pending = output.replace(/\.exe$/i, '.pending.exe');
  await execute(compiler, [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', `/out:${pending}`,
    `/win32icon:${path.join(root, 'desktop', 'assets', 'icon.ico')}`, `/win32manifest:${path.join(source, 'setup.manifest')}`,
    ...['WindowsBase', 'PresentationCore', 'PresentationFramework', 'System.Xaml'].map(name => `/reference:${path.join(framework, name === 'System.Xaml' ? '' : 'WPF', `${name}.dll`)}`),
    `/resource:${engine},Harness.Engine`, `/resource:${path.join(source, 'Setup.xaml')},Harness.Setup.xaml`,
    `/resource:${path.join(source, 'generated', 'scene.bmp')},Harness.Scene`, `/resource:${path.join(root, 'desktop', 'assets', 'icon.ico')},Harness.Icon`,
    path.join(source, 'Setup.cs'), path.join(source, 'FolderPicker.cs'), info,
  ]);
  await ensureNotRunning(output);
  await rename(pending, output);
  await writeFile(`${output}.sha256`, `${await hashFile(output)}  ${path.basename(output)}\n`);
}

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureElectronRuntime } from './install-electron.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

export async function launchGui({ workspace, args = [], stdio = 'inherit' } = {}) {
  try { await access(path.join(projectRoot, 'dist', 'index.html')); }
  catch { throw new Error('请先运行 npm run build 构建 GUI 界面。'); }
  const executable = await ensureElectronRuntime();
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [projectRoot, ...(workspace ? ['--workspace', path.resolve(workspace)] : []), ...args], { stdio, env: environment, windowsHide: false });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await launchGui({ args: process.argv.slice(2) }); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

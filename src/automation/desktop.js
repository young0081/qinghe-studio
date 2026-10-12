import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function desktopOperation(args, signal) {
  if (process.platform !== 'win32') throw new Error('桌面操作目前仅支持 Windows；其他平台可以使用 Browser');
  signal.throwIfAborted();
  const script = await readFile(new URL('./windows.ps1', import.meta.url), 'utf8');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let errorText = '';
    let failure;
    const stop = error => { failure ||= error; child.kill(); };
    const cancel = () => stop(signal.reason || new Error('桌面操作已取消'));
    const timer = setTimeout(() => stop(new Error('桌面操作超时，已停止')), 15000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop(new Error('桌面截图超过大小限制')); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(0, 1000); });
    child.stdin.on('error', () => {});
    child.on('error', error => { failure ||= error; });
    child.on('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(errorText || 'Windows 桌面操作失败')); return; }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ ...args, forbiddenPid: process.pid }));
  });
}

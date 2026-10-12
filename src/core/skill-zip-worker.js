import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync } from 'fflate';

try {
  let entries = 0;
  let expanded = 0;
  const names = new Set();
  const archive = unzipSync(workerData, { filter: entry => {
    if (++entries > 512 || entry.originalSize > 2 * 1024 * 1024 || (expanded += entry.originalSize) > 8 * 1024 * 1024) throw new Error('技能 ZIP 解压后超过 8 MiB 或文件过多');
    if (names.has(entry.name.toLowerCase())) throw new Error('技能 ZIP 存在重复路径');
    names.add(entry.name.toLowerCase());
    return !entry.name.endsWith('/');
  } });
  parentPort.postMessage({ files: Object.entries(archive).map(([name, data]) => ({ path: name, data: Buffer.from(data).toString('base64') })) });
} catch (error) { parentPort.postMessage({ error: error.message }); }

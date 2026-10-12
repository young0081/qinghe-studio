import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(filename);
    else if (/\.(?:js|cjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
      if (result.status !== 0) process.exitCode = 1;
    }
  }
}

await checkDirectory('src');
await checkDirectory('scripts');
await checkDirectory('desktop');
if (!process.exitCode) process.stdout.write('JavaScript syntax checks passed.\n');

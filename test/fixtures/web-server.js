import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHarness } from '../../src/core/harness.js';
import { startServer } from '../../src/server.js';
import { startModelServer } from './model-server.js';

const workspace = await mkdtemp(path.join(tmpdir(), 'harness-browser-'));
const globalConfigDir = await mkdtemp(path.join(tmpdir(), 'harness-browser-global-'));
await writeFile(path.join(workspace, 'README.md'), '# Browser verification\n\nThis is a real isolated test workspace.\n');
const model = await startModelServer({ port: 3418 });
const harness = await createHarness({ workspace, globalConfigDir, settings: { provider: 'responses', baseUrl: model.url, model: 'test-model', apiKey: 'test-key' } });
const server = await startServer({ harness, port: 3417 });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await harness.close();
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(globalConfigDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
process.stdout.write(`${server.url}\n`);

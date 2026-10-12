import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness, resolveGlobalConfigDir } from '../src/core/harness.js';
import { GlobalProviders } from '../src/core/global-providers.js';
import { validateSettings } from '../src/core/settings.js';
import { prepareProviderSettings } from '../src/core/catalog.js';

const completed = content => ({ content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' });

async function fixture(context) {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'harness-provider-scopes-'));
  const globalConfigDir = path.join(directory, 'shared');
  const harnesses = [];
  const keys = ['HARNESS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  context.after(async () => {
    for (const harness of harnesses.reverse()) await harness.close();
    const target = await realpath(directory);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('harness-provider-scopes-'));
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  });
  const open = async (name = 'workspace', options = {}) => {
    const harness = await createHarness({ workspace: path.join(directory, name), globalConfigDir, ...options });
    harnesses.push(harness);
    return harness;
  };
  return { directory, globalConfigDir, open, readGlobal: async () => JSON.parse(await readFile(path.join(globalConfigDir, 'providers.json'), 'utf8')) };
}

async function profile(harness, scope, name = scope, overrides = {}) {
  const catalog = await harness.createProvider({ name, protocol: 'responses', apiKey: `${name}-fixture-key-123456`, models: [{ id: `${name}-model` }], ...overrides }, scope);
  return catalog.providers.find(item => item.name === name);
}

async function run(harness, sessionId) {
  await harness.run(sessionId, 'Complete the task');
  await harness.activeRuns.get(sessionId).done;
  return harness.getSession(sessionId);
}

function event(harness, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harness.off('event', listener); reject(new Error(`Missing ${type} event`)); }, timeout);
    const listener = value => { if (value.type === type) { clearTimeout(timer); harness.off('event', listener); resolve(value); } };
    harness.on('event', listener);
  });
}

function child(context, directory, globalConfigDir, code) {
  const program = `import { createHarness } from ${JSON.stringify(new URL('../src/core/harness.js', import.meta.url).href)};\nconst harness = await createHarness({ workspace: ${JSON.stringify(directory)}, globalConfigDir: ${JSON.stringify(globalConfigDir)} });\n${code}`;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errorOutput = '';
  worker.stderr.on('data', value => { errorOutput += value; });
  worker.stdout.resume();
  const messages = [];
  const listeners = new Map();
  worker.on('message', value => {
    const listener = listeners.get(value.type);
    if (listener) { listeners.delete(value.type); listener(value); } else messages.push(value);
  });
  const exit = new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', (code, signal) => { if (code === 0 || signal) resolve({ code, signal }); else reject(new Error(`Child exited ${code}: ${errorOutput}`)); });
  });
  exit.catch(() => {});
  context.after(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); await exit.catch(() => {}); });
  return {
    worker, exit,
    message: type => new Promise((resolve, reject) => {
      const found = messages.findIndex(value => value.type === type);
      if (found >= 0) { resolve(messages.splice(found, 1)[0]); return; }
      const timer = setTimeout(() => { listeners.delete(type); reject(new Error(`Missing child message ${type}: ${errorOutput}`)); }, 10000);
      listeners.set(type, value => { clearTimeout(timer); resolve(value); });
      exit.then(() => { clearTimeout(timer); if (listeners.delete(type)) reject(new Error(`Child exited before ${type}: ${errorOutput}`)); }, reject);
    }),
  };
}

test('explicit global directories override the environment and defaults resolve without reading configuration', () => {
  const original = process.env.HARNESS_CONFIG_DIR;
  try {
    process.env.HARNESS_CONFIG_DIR = path.join(os.tmpdir(), 'harness-environment-config');
    assert.equal(resolveGlobalConfigDir(), path.resolve(process.env.HARNESS_CONFIG_DIR));
    assert.equal(resolveGlobalConfigDir('explicit-fixture-config'), path.resolve('explicit-fixture-config'));
    assert.throws(() => resolveGlobalConfigDir(''), /目录无效/);
    delete process.env.HARNESS_CONFIG_DIR;
    const expected = process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Harness', 'shared') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'harness');
    assert.equal(resolveGlobalConfigDir(), path.resolve(expected));
  } finally { if (original === undefined) delete process.env.HARNESS_CONFIG_DIR; else process.env.HARNESS_CONFIG_DIR = original; }
});

test('empty scopes remain independent, validate names and preserve local configuration across restarts', async context => {
  const isolated = await fixture(context);
  const harness = await isolated.open();
  assert.deepEqual(harness.getProviderScopes(), { activeScope: 'workspace', global: { providers: [], active: null }, workspace: { providers: [], active: null } });
  assert.throws(() => harness.getProviderCatalog('invalid'), /scope/);
  await assert.rejects(async () => harness.setProviderScope('invalid'), /scope/);
  const local = await profile(harness, 'workspace');
  await harness.activateModel(local.id, 'workspace-model', 'workspace');
  await harness.setProviderScope('global');
  assert.equal(harness.getSettings().configured, false);
  assert.equal(harness.getSettings().model, '');
  assert.equal(harness.getProviderCatalog('workspace').active.modelId, 'workspace-model');
  const global = await profile(harness, 'global');
  await harness.activateModel(global.id, 'global-model', 'global');
  await harness.close();
  const reopened = await isolated.open();
  assert.equal(reopened.getSettings().providerScope, 'global');
  assert.equal(reopened.getSettings().model, 'global-model');
  await reopened.setProviderScope('workspace');
  assert.equal(reopened.getSettings().model, 'workspace-model');
  assert.equal(reopened.getSettings().hasApiKey, true);
});

test('global legacy updates keep secrets out of workspace files and runtime policy remains local', async context => {
  const isolated = await fixture(context);
  const first = await isolated.open('first');
  const second = await isolated.open('second');
  await first.updateSettings({ model: 'local-model', apiKey: 'local-only-secret-123456' });
  const local = first.getProviderCatalog();
  await first.setProviderScope('global');
  await second.setProviderScope('global');
  await first.updateSettings({ provider: 'anthropic', model: 'shared-model', apiKey: 'shared-only-secret-123456', approval: 'auto', systemPrompt: 'local runtime policy', maxTokens: 1234 });
  assert.equal(first.getSettings().model, 'shared-model');
  assert.equal(first.getSettings().approval, 'auto');
  assert.equal(second.getSettings().model, 'shared-model');
  assert.equal(second.getSettings().approval, 'ask');
  assert.equal(second.getSettings().systemPrompt, '');
  assert.equal(second.getSettings().maxTokens, 4096);
  assert.deepEqual(first.getProviderCatalog('workspace'), local);
  const persisted = await readFile(path.join(first.dataDir, 'settings.json'), 'utf8');
  assert.ok(persisted.includes('local-only-secret-123456'));
  assert.ok(!persisted.includes('shared-only-secret-123456'));
  const global = JSON.stringify(await isolated.readGlobal());
  assert.ok(global.includes('shared-only-secret-123456'));
  assert.ok(!global.includes('local-only-secret-123456'));
  assert.ok(!global.includes('local runtime policy'));
  assert.ok(!JSON.stringify(first.getProviderScopes()).includes('only-secret'));
  await first.setProviderScope('workspace');
  assert.equal(first.getSettings().model, 'local-model');
});

test('scope persistence stays compatible with legacy flat settings readers and migrates the earlier scope field', async context => {
  const isolated = await fixture(context);
  const harness = await isolated.open();
  await harness.updateSettings({ model: 'local-model', apiKey: 'local-only-secret-123456' });
  await harness.setProviderScope('global');
  const saved = JSON.parse(await readFile(path.join(harness.dataDir, 'settings.json'), 'utf8'));
  assert.equal(saved.providerCatalog.scope, 'global');
  assert.equal(Object.hasOwn(saved, 'providerScope'), false);
  const { providerCatalog, ...legacyFlat } = saved;
  assert.doesNotThrow(() => validateSettings(legacyFlat));
  assert.equal(legacyFlat.model, 'local-model');
  assert.equal(legacyFlat.apiKey, 'local-only-secret-123456');
  const interim = { ...saved, providerScope: 'global', providerCatalog: { ...providerCatalog } };
  delete interim.providerCatalog.scope;
  const migrated = prepareProviderSettings(interim);
  assert.equal(migrated.providerScope, 'global');
  assert.equal(migrated.migrated, true);
  assert.equal(Object.hasOwn(migrated.persisted, 'providerScope'), false);
  assert.equal(migrated.persisted.providerCatalog.scope, 'global');
  assert.equal(prepareProviderSettings({ ...interim, providerCatalog: { ...interim.providerCatalog, scope: 'workspace' } }).providerScope, 'workspace');
});

test('global polling publishes settings changes to another workspace without a read request', async context => {
  const isolated = await fixture(context);
  const first = await isolated.open('first');
  const second = await isolated.open('second');
  second.getProviderScopes();
  const notification = event(second, 'settings.updated');
  const shared = await profile(first, 'global');
  await notification;
  assert.equal(second.getProviderCatalog('global').providers[0].id, shared.id);
  await second.setProviderScope('global');
  await first.activateModel(shared.id, 'global-model', 'global');
  assert.equal(second.getSettings().model, 'global-model');
});

test('simultaneous in-process and independent-process global writes never replace one another', async context => {
  const isolated = await fixture(context);
  const first = await isolated.open('first');
  const second = await isolated.open('second');
  await Promise.all(Array.from({ length: 8 }, (_, index) => profile(index % 2 ? first : second, 'global', `concurrent-${index}`)));
  const children = Array.from({ length: 3 }, (_, index) => child(context, path.join(isolated.directory, `process-${index}`), isolated.globalConfigDir, `for (let count = 0; count < 4; count++) await harness.createProvider({ name: 'process-${index}-' + count }, 'global'); await harness.close(); process.disconnect();`));
  await Promise.all(children.map(value => value.exit));
  const catalog = first.getProviderCatalog('global');
  assert.equal(catalog.providers.length, 20);
  assert.equal(new Set(catalog.providers.map(value => value.name)).size, 20);
  assert.equal(new Set(catalog.providers.map(value => value.id)).size, 20);
});

test('a running shared provider cannot be removed, disabled or renamed by another process', async context => {
  const isolated = await fixture(context);
  const harness = await isolated.open();
  const running = await profile(harness, 'global', 'running');
  const next = await profile(harness, 'global', 'next');
  await harness.activateModel(running.id, 'running-model', 'global');
  const worker = child(context, path.join(isolated.directory, 'runner'), isolated.globalConfigDir, `
    await harness.setProviderScope('global');
    harness.completion = async settings => {
      process.send({ type: 'running', model: settings.model });
      await new Promise(resolve => process.once('message', resolve));
      return { content: 'Done', toolCalls: [], usage: {}, finishReason: 'stop' };
    };
    const session = await harness.createSession();
    await harness.run(session.id, 'Hold this run');
    await harness.activeRuns.get(session.id).done;
    await harness.close();
    process.disconnect();
  `);
  assert.equal((await worker.message('running')).model, 'running-model');
  await harness.activateModel(next.id, 'next-model', 'global');
  for (const mutate of [() => harness.deleteProvider(running.id, 'global'), () => harness.updateProvider(running.id, { enabled: false }, 'global'), () => harness.deleteModel(running.id, 'running-model', 'global'), () => harness.updateModel(running.id, 'running-model', { enabled: false }, 'global'), () => harness.updateModel(running.id, 'running-model', { id: 'renamed' }, 'global')]) await assert.rejects(mutate(), { statusCode: 409 });
  worker.worker.send('finish');
  await worker.exit;
  assert.deepEqual((await isolated.readGlobal()).runLeases, []);
  await harness.deleteProvider(running.id, 'global');
  assert.equal(harness.getProviderCatalog('global').providers.length, 1);
});

test('dead process leases and interrupted lock files are recovered before the next shared mutation', async context => {
  const isolated = await fixture(context);
  const harness = await isolated.open();
  const running = await profile(harness, 'global', 'running');
  await harness.activateModel(running.id, 'running-model', 'global');
  const worker = child(context, path.join(isolated.directory, 'runner'), isolated.globalConfigDir, `
    await harness.setProviderScope('global');
    harness.completion = async () => { process.send({ type: 'running' }); return new Promise(() => {}); };
    await harness.run((await harness.createSession()).id, 'Wait');
    setInterval(() => {}, 1000);
  `);
  await worker.message('running');
  worker.worker.kill();
  await worker.exit;
  await writeFile(path.join(isolated.globalConfigDir, 'providers.lock'), JSON.stringify({ pid: worker.worker.pid, token: 'dead-worker-lock' }));
  await harness.activateModel(null, null, 'global');
  await harness.deleteProvider(running.id, 'global');
  assert.deepEqual((await isolated.readGlobal()).runLeases, []);
});

test('scope changes preserve in-flight credentials and cancellation and close release shared leases', async context => {
  const isolated = await fixture(context);
  const snapshots = [];
  const harness = await isolated.open('first', { completion: async (settings, request) => {
    snapshots.push(settings);
    await new Promise((resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); });
    return completed('Done');
  } });
  const shared = await profile(harness, 'global');
  await harness.activateModel(shared.id, 'global-model', 'global');
  await harness.setProviderScope('global');
  await harness.updateSettings({ model: 'local-model', apiKey: 'local-fixture-secret-123456' });
  const session = await harness.createSession();
  const step = event(harness, 'run.step');
  await harness.run(session.id, 'Wait for cancellation');
  await step;
  await harness.setProviderScope('workspace');
  assert.equal(snapshots[0].apiKey, 'local-fixture-secret-123456');
  assert.equal(harness.activeRuns.get(session.id).scope, 'global');
  assert.equal((await isolated.readGlobal()).runLeases.length, 1);
  await harness.cancelRun(session.id);
  assert.equal(harness.getSession(session.id).run.status, 'cancelled');
  assert.deepEqual((await isolated.readGlobal()).runLeases, []);
  await harness.setProviderScope('global');
  await harness.run((await harness.createSession()).id, 'Close this run');
  await harness.close();
  assert.deepEqual((await isolated.readGlobal()).runLeases, []);
});

test('native provider history remains scoped even when both catalogs contain identical provider and model IDs', async context => {
  const isolated = await fixture(context);
  const requests = [];
  const harness = await isolated.open('workspace', { completion: async (settings, request) => {
    requests.push(request.messages);
    return { ...completed('Portable answer'), providerItems: [{ type: 'reasoning', id: `opaque-${requests.length}`, encrypted_content: 'native-private-item' }] };
  } });
  const local = await profile(harness, 'workspace');
  await harness.activateModel(local.id, 'workspace-model', 'workspace');
  const stored = JSON.parse(await readFile(path.join(harness.dataDir, 'settings.json'), 'utf8'));
  await new GlobalProviders(isolated.globalConfigDir).transaction(record => { record.providerCatalog = stored.providerCatalog; });
  const session = await harness.createSession();
  assert.equal((await run(harness, session.id)).run.status, 'completed');
  delete harness.session(session.id).messages.find(message => message.role === 'assistant').providerContext.scope;
  await run(harness, session.id);
  assert.ok(requests[1].some(message => message.providerItems?.length));
  await harness.setProviderScope('global');
  await run(harness, session.id);
  assert.ok(requests[2].every(message => !message.providerItems));
  assert.equal(harness.getSession(session.id).messages.at(-1).providerContext.scope, 'global');
});

test('global launch overrides remain temporary and never persist credentials to the workspace', async context => {
  const isolated = await fixture(context);
  const harness = await isolated.open();
  const saved = await profile(harness, 'global', 'saved');
  await harness.activateModel(saved.id, 'saved-model', 'global');
  await harness.setProviderScope('global');
  await harness.close();
  const launch = await isolated.open('workspace', { settings: { model: 'temporary-model', apiKey: 'temporary-global-secret-123456' } });
  assert.equal(launch.getSettings().model, 'temporary-model');
  assert.ok(!(await readFile(path.join(launch.dataDir, 'settings.json'), 'utf8')).includes('temporary-global-secret-123456'));
  assert.equal((await isolated.readGlobal()).providerCatalog.active.modelId, 'saved-model');
  await launch.close();
  const restored = await isolated.open();
  assert.equal(restored.getSettings().model, 'saved-model');
});

test('invalid shared mutations preserve both files and malformed global data never replaces local settings', async context => {
  const isolated = await fixture(context);
  const harness = await isolated.open();
  await profile(harness, 'global');
  const before = await readFile(path.join(isolated.globalConfigDir, 'providers.json'), 'utf8');
  const local = await readFile(path.join(harness.dataDir, 'settings.json'), 'utf8');
  await assert.rejects(harness.createProvider({ name: 'invalid', models: [{ id: 'duplicate' }, { id: 'duplicate' }] }, 'global'), { statusCode: 409 });
  assert.equal(await readFile(path.join(isolated.globalConfigDir, 'providers.json'), 'utf8'), before);
  assert.equal(await readFile(path.join(harness.dataDir, 'settings.json'), 'utf8'), local);
  await writeFile(path.join(isolated.globalConfigDir, 'providers.json'), '{ invalid json');
  await assert.rejects(harness.setProviderScope('global'), /JSON/);
  assert.equal(harness.getSettings().providerScope, 'workspace');
  assert.equal(await readFile(path.join(harness.dataDir, 'settings.json'), 'utf8'), local);
});

test('a failed workspace policy commit rolls back its accompanying shared provider changes', async context => {
  const isolated = await fixture(context);
  const harness = await isolated.open();
  const shared = await profile(harness, 'global');
  await harness.activateModel(shared.id, 'global-model', 'global');
  await harness.setProviderScope('global');
  const filename = path.join(harness.dataDir, 'settings.json');
  const local = await readFile(filename, 'utf8');
  const global = await isolated.readGlobal();
  await rm(filename);
  await mkdir(filename);
  await assert.rejects(harness.updateSettings({ apiKey: 'rejected-global-key-123456', approval: 'readonly' }));
  assert.deepEqual(await isolated.readGlobal(), global);
  assert.equal(harness.getSettings().approval, 'ask');
  assert.equal(harness.settings.apiKey, 'global-fixture-key-123456');
  await rmdir(filename);
  await writeFile(filename, local);
  await harness.updateSettings({ approval: 'readonly' });
  assert.deepEqual(await isolated.readGlobal(), global);
  assert.equal(harness.getSettings().approval, 'readonly');
});

test('concurrent processes recover the same dead-owner lock without deleting a replacement lock', async context => {
  const isolated = await fixture(context);
  const harness = await isolated.open();
  const dead = child(context, path.join(isolated.directory, 'dead'), isolated.globalConfigDir, 'await harness.close(); process.disconnect();');
  await dead.exit;
  await mkdir(isolated.globalConfigDir, { recursive: true });
  await writeFile(path.join(isolated.globalConfigDir, 'providers.lock'), JSON.stringify({ pid: dead.worker.pid, token: 'dead-lock-concurrent-recovery' }));
  const workers = Array.from({ length: 3 }, (_, index) => child(context, path.join(isolated.directory, `recover-${index}`), isolated.globalConfigDir, `
    process.send({ type: 'ready' });
    await new Promise(resolve => process.once('message', resolve));
    for (let count = 0; count < 4; count++) await harness.createProvider({ name: 'recovered-${index}-' + count }, 'global');
    await harness.close();
    process.disconnect();
  `));
  await Promise.all(workers.map(worker => worker.message('ready')));
  for (const worker of workers) worker.worker.send('start');
  await Promise.all(workers.map(worker => worker.exit));
  assert.equal(harness.getProviderCatalog('global').providers.length, 12);
});

test('scope enums remain valid when dummy API keys match global or workspace', async context => {
  const isolated = await fixture(context);
  const harness = await isolated.open('workspace', { completion: async () => completed('global workspace') });
  await profile(harness, 'workspace', 'local', { apiKey: 'workspace' });
  const shared = await profile(harness, 'global', 'shared', { apiKey: 'global' });
  await harness.activateModel(shared.id, 'shared-model', 'global');
  await harness.setProviderScope('global');
  assert.equal(harness.getSettings().providerScope, 'global');
  const session = await run(harness, (await harness.createSession()).id);
  assert.equal(session.run.providerScope, 'global');
  assert.equal(session.messages.at(-1).providerContext.scope, 'global');
  assert.equal(session.messages.at(-1).content, '[REDACTED] [REDACTED]');
  await harness.setProviderScope('workspace');
  assert.equal(harness.getSettings().providerScope, 'workspace');
});

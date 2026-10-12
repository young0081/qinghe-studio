import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopRuntime, isTrustedRenderer, parseLaunchArguments, sanitizeWindowBounds, visibleWindowBounds } from '../desktop/runtime.js';
import { createHarness } from '../src/core/harness.js';
import { testCompletion } from './fixtures/completion.js';

async function fixture(context, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-desktop-'));
  const userData = path.join(directory, 'preferences');
  const first = path.join(directory, 'first-project');
  const second = path.join(directory, 'second-project');
  await mkdir(first);
  await mkdir(second);
  const runtime = await createDesktopRuntime({ userData, ...options });
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { directory, userData, first: await realpath(first), second: await realpath(second), runtime };
}

function eventOnce(emitter, name, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(name, listener); reject(new Error('等待桌面事件超时')); }, 10000);
    const listener = event => { if (predicate(event)) { clearTimeout(timer); emitter.off(name, listener); resolve(event); } };
    emitter.on(name, listener);
  });
}

test('desktop starts without a workspace and never creates a missing project directory', async context => {
  const { runtime, directory } = await fixture(context);
  assert.equal(runtime.getState().status, 'idle');
  assert.equal(runtime.getState().workspace, null);
  assert.equal(runtime.workspace, null);
  assert.throws(() => runtime.getSettings(), { statusCode: 409 });
  assert.throws(() => runtime.getProviderCatalog(), { statusCode: 409 });
  assert.throws(() => runtime.listSessions(), { statusCode: 409 });
  assert.throws(() => runtime.getTools(), { statusCode: 409 });
  assert.throws(() => runtime.extensions, { statusCode: 409 });
  const missing = path.join(directory, 'not-created');
  const state = await runtime.openWorkspace(missing);
  assert.equal(state.status, 'error');
  assert.match(state.error, /目录不存在/);
  await assert.rejects(stat(missing), { code: 'ENOENT' });
});

test('desktop catalog delegates to the selected workspace and remains isolated across switches', async context => {
  const { runtime, first, second } = await fixture(context);
  await runtime.openWorkspace(first);
  const created = await runtime.createProvider({ name: '项目专属供应商', protocol: 'openai', apiKey: 'desktop-catalog-private-key' });
  const provider = created.providers.find(item => item.name === '项目专属供应商');
  await runtime.addProviderModels(provider.id, { models: [{ id: 'workspace-model', name: '工作区模型' }] });
  await runtime.updateProvider(provider.id, { name: '项目专属供应商（已保存）' });
  await runtime.updateModel(provider.id, 'workspace-model', { name: '主力模型' });
  await runtime.activateModel(provider.id, 'workspace-model');
  assert.equal(runtime.getSettings().activeProviderId, provider.id);
  assert.equal(runtime.getSettings().model, 'workspace-model');
  assert.ok(!JSON.stringify(runtime.getProviderCatalog()).includes('desktop-catalog-private-key'));
  await runtime.openWorkspace(second);
  assert.ok(!runtime.getProviderCatalog().providers.some(item => item.id === provider.id));
  await runtime.openWorkspace(first);
  assert.equal(runtime.getProviderCatalog().active.providerId, provider.id);
  await runtime.activateModel(null, null);
  await runtime.deleteModel(provider.id, 'workspace-model');
  await runtime.deleteProvider(provider.id);
  assert.ok(!runtime.getProviderCatalog().providers.some(item => item.id === provider.id));
});

test('real workspace switch retains previous backend on lock failure and shares persisted config and sessions', async context => {
  const { runtime, first, second } = await fixture(context);
  const states = [];
  runtime.on('state', state => states.push(state.status));
  assert.equal((await runtime.openWorkspace(first)).status, 'ready');
  await runtime.updateSettings({ contextCompactionThreshold: 0.75 });
  const session = await runtime.createSession({ title: '保留的项目会话' });
  const locked = await createHarness({ workspace: second });
  context.after(() => locked.close());
  const failed = await runtime.openWorkspace(second);
  assert.equal(failed.status, 'ready');
  assert.equal(failed.workspace, first);
  assert.match(failed.error, /进程|工作区/);
  assert.equal(runtime.getSession(session.id).title, '保留的项目会话');
  assert.equal(runtime.getSettings().contextCompactionThreshold, 0.75);
  const created = eventOnce(runtime, 'event', event => event.type === 'session.created');
  await runtime.createSession({ title: '失败后仍可使用' });
  assert.equal((await created).type, 'session.created');
  await locked.close();
  const opened = await runtime.openWorkspace(second);
  assert.equal(opened.workspace, second);
  assert.equal(opened.error, undefined);
  assert.deepEqual(opened.recentWorkspaces, [second, first]);
  const reopened = await createHarness({ workspace: first });
  assert.equal(reopened.getSettings().contextCompactionThreshold, 0.75);
  assert.equal(reopened.getSession(session.id).title, '保留的项目会话');
  await reopened.close();
  assert.ok(states.includes('loading'));
  assert.throws(() => runtime.openRecentWorkspace(path.join(first, 'unrecorded')), { statusCode: 403 });
  assert.equal((await runtime.openRecentWorkspace(first)).workspace, first);
});

test('active task confirmation can decline switch or close, and accepted switch cancels and releases old lock', async context => {
  const factory = options => createHarness({ ...options, completion: testCompletion, settings: { provider: 'responses', model: 'test-model', apiKey: 'test-key' } });
  const { runtime, first, second } = await fixture(context, { createHarness: factory });
  await runtime.openWorkspace(first);
  const session = await runtime.createSession();
  const approval = eventOnce(runtime, 'event', event => event.type === 'approval.required');
  await runtime.run(session.id, '[test:write]');
  await approval;
  const confirmations = [];
  const confirmStop = async details => { confirmations.push(details); return false; };
  const declined = await runtime.openWorkspace(second, { confirmStop });
  assert.equal(declined.workspace, first);
  assert.equal(runtime.getSession(session.id).run.status, 'waiting_approval');
  assert.equal(await runtime.shutdown({ confirmStop }), false);
  assert.equal(runtime.closed, false);
  assert.equal(runtime.getState().status, 'ready');
  assert.deepEqual(confirmations.map(item => item.reason), ['switch', 'close']);
  assert.ok(confirmations.every(item => item.count === 1));
  const cancelled = eventOnce(runtime, 'event', event => event.type === 'run.cancelled');
  assert.equal((await runtime.openWorkspace(second, { confirmStop: async () => true })).workspace, second);
  await cancelled;
  const previous = await createHarness({ workspace: first });
  assert.equal(previous.getSession(session.id).run.status, 'cancelled');
  await previous.close();
  await assert.rejects(readFile(path.join(first, 'harness-test.txt')), { code: 'ENOENT' });
});

test('workspace operations serialize with shutdown and reject API access during transitions', async context => {
  const calls = [];
  let releaseFirst;
  let firstCreated;
  const started = new Promise(resolve => { firstCreated = resolve; });
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const factory = async ({ workspace }) => {
    calls.push(`open:${path.basename(workspace)}`);
    if (calls.length === 1) { firstCreated(); await gate; }
    const harness = new EventEmitter();
    harness.workspace = workspace;
    harness.closed = false;
    harness.listSessions = () => [];
    harness.close = async () => { harness.closed = true; calls.push(`close:${path.basename(workspace)}`); };
    return harness;
  };
  const { runtime, first, second } = await fixture(context, { createHarness: factory });
  const openingFirst = runtime.openWorkspace(first);
  await started;
  assert.equal(runtime.getState().status, 'loading');
  assert.throws(() => runtime.listSessions(), { statusCode: 409 });
  const openingSecond = runtime.openWorkspace(second);
  const shuttingDown = runtime.shutdown();
  releaseFirst();
  assert.equal((await openingFirst).workspace, first);
  assert.equal((await openingSecond).workspace, second);
  assert.equal(await shuttingDown, true);
  assert.deepEqual(calls, ['open:first-project', 'open:second-project', 'close:first-project', 'close:second-project']);
  assert.equal(runtime.workspace, null);
  assert.equal(runtime.closed, true);
  await assert.rejects(runtime.openWorkspace(first), { statusCode: 503 });
});

test('workspace switch reports persistence failure but still releases the previous core lock and resources', async context => {
  const opened = [];
  const factory = async options => { const harness = await createHarness(options); opened.push(harness); return harness; };
  const { runtime, first, second } = await fixture(context, { createHarness: factory });
  await runtime.openWorkspace(first);
  let cleaned = false;
  opened[0].registerCleanup(async () => { cleaned = true; });
  opened[0].flush = async () => { throw new Error('simulated storage failure'); };
  const switched = await runtime.openWorkspace(second);
  assert.equal(switched.status, 'ready');
  assert.equal(switched.workspace, second);
  assert.match(switched.error, /关闭旧工作区失败/);
  assert.equal(cleaned, true);
  const recovered = await createHarness({ workspace: first });
  await recovered.close();
});

test('recent workspace, last workspace and normal window bounds persist independently of project data', async context => {
  const { runtime, first, second, userData } = await fixture(context);
  await runtime.openWorkspace(first);
  await runtime.openWorkspace(second);
  const bounds = { x: 32, y: 48, width: 1100, height: 720 };
  await runtime.updateWindowState(bounds, true);
  const state = runtime.getState();
  state.recentWorkspaces.push('untrusted mutation');
  assert.equal(runtime.getState().recentWorkspaces.length, 2);
  await runtime.close();
  const restored = await createDesktopRuntime({ userData });
  context.after(() => restored.close());
  assert.equal(restored.getState().status, 'idle');
  assert.equal(restored.workspace, null);
  assert.equal(restored.getLastWorkspace(), second);
  assert.deepEqual(restored.getState().recentWorkspaces, [second, first]);
  assert.deepEqual(restored.getWindowBounds(), bounds);
  assert.equal(restored.getState().maximized, true);
  assert.equal((await restored.openWorkspace(restored.getLastWorkspace())).workspace, second);
  await restored.close();
});

test('corrupt desktop preferences leave a usable workspace launcher', async context => {
  const { runtime, userData, first } = await fixture(context);
  await runtime.close();
  await writeFile(path.join(userData, 'desktop-settings.json'), '{invalid');
  const restored = await createDesktopRuntime({ userData });
  context.after(() => restored.close());
  assert.equal(restored.getState().status, 'error');
  assert.equal(restored.getState().workspace, null);
  assert.equal((await restored.openWorkspace(first)).status, 'ready');
  await restored.close();
});

test('launch arguments resolve against launch directory and reject ambiguous values', () => {
  const directory = path.resolve('launch-directory');
  assert.deepEqual(parseLaunchArguments(['main.js', '--workspace', 'project', '--user-data=data'], directory), { workspace: path.join(directory, 'project'), userData: path.join(directory, 'data') });
  assert.throws(() => parseLaunchArguments(['--workspace']), /需要目录路径/);
  assert.throws(() => parseLaunchArguments(['--workspace', '--user-data', 'data']), /需要目录路径/);
  assert.throws(() => parseLaunchArguments(['--workspace=a', '--workspace=b']), /只能指定一次/);
  assert.deepEqual(parseLaunchArguments(['--no-sandbox', 'main.js']), {});
});

test('IPC trust requires exact main frame, window, origin and app document path', () => {
  const frame = { routingId: 4, processId: 7, url: 'http://127.0.0.1:54321/' };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  const origin = 'http://127.0.0.1:54321';
  assert.equal(isTrustedRenderer(event, window, origin), true);
  assert.equal(isTrustedRenderer({ ...event, senderFrame: { ...frame } }, window, origin), false);
  assert.equal(isTrustedRenderer({ ...event, sender: {} }, window, origin), false);
  frame.url = 'http://localhost:54321/';
  assert.equal(isTrustedRenderer(event, window, origin), false);
  frame.url = `${origin}/api/settings`;
  assert.equal(isTrustedRenderer(event, window, origin), false);
  frame.url = 'https://example.com/';
  assert.equal(isTrustedRenderer(event, window, origin), false);
});

test('window geometry validates dimensions and clamps disconnected monitor coordinates', () => {
  assert.equal(sanitizeWindowBounds({ x: 0, y: 0, width: NaN, height: 600 }), null);
  assert.equal(sanitizeWindowBounds({ x: 0, y: 0, width: 10, height: 10 }), null);
  const area = { x: 0, y: 0, width: 1280, height: 800 };
  const result = visibleWindowBounds({ x: 9000, y: -9000, width: 1400, height: 900 }, [area]);
  assert.deepEqual(result, { x: 0, y: 0, width: 1280, height: 800 });
  const small = visibleWindowBounds(null, [{ x: 0, y: 0, width: 720, height: 480 }]);
  assert.equal(small.width, 720);
  assert.equal(small.height, 480);
});

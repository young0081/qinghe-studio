import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, rmdir, realpath, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../src/core/harness.js';
import { startModelServer } from './fixtures/model-server.js';

async function fixture(context, options = {}) {
  const environmentKeys = ['HARNESS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const environment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  const tempParent = await realpath(os.tmpdir());
  const workspace = await mkdtemp(path.join(tempParent, 'harness-catalog-'));
  const harnesses = [];
  context.after(async () => {
    for (const harness of harnesses.reverse()) await harness.close();
    const target = await realpath(workspace);
    assert.equal(path.dirname(target), tempParent);
    assert.ok(path.basename(target).startsWith('harness-catalog-'));
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const key of environmentKeys) { if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key]; }
  });
  const settingsFile = path.join(workspace, '.harness', 'settings.json');
  if (options.stored) { await mkdir(path.dirname(settingsFile)); await writeFile(settingsFile, JSON.stringify(options.stored)); }
  const open = async extra => { const harness = await createHarness({ workspace, globalConfigDir: path.join(workspace, 'isolated-global-config'), ...options, ...extra }); harnesses.push(harness); return harness; };
  return { workspace, settingsFile, open, harness: await open() };
}

async function profile(harness, input = {}) {
  const before = new Set(harness.getProviderCatalog().providers.map(value => value.id));
  const catalog = await harness.createProvider({ name: '测试供应商', protocol: 'responses', apiKey: 'catalog-test-secret', ...input });
  return catalog.providers.find(value => !before.has(value.id));
}

async function mock(context, handler) {
  const requests = [];
  const failures = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers, method: request.method });
    Promise.resolve().then(() => handler(request, response, requests.length)).catch(error => { failures.push(error); response.writeHead(500); response.end('test handler failed'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); assert.deepEqual(failures, []); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function json(response, value, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }

test('legacy flat settings migrate losslessly once and incomplete credentials remain editable', async context => {
  const stored = { provider: 'anthropic', model: 'legacy-model', apiKey: 'legacy-private-key', baseUrl: 'https://gateway.example/v1/', approval: 'readonly', maxSteps: 13, maxTokens: 1234, temperature: 0.6 };
  const { harness, settingsFile, open } = await fixture(context, { stored });
  const catalog = harness.getProviderCatalog();
  assert.equal(catalog.providers.length, 1);
  assert.equal(catalog.providers[0].protocol, 'anthropic');
  assert.equal(catalog.providers[0].baseUrl, 'https://gateway.example/v1');
  assert.deepEqual(catalog.active, { providerId: catalog.providers[0].id, modelId: 'legacy-model' });
  assert.equal(harness.getSettings().maxTokens, 1234);
  assert.equal(harness.getSettings().approval, 'readonly');
  assert.equal(harness.getSettings().maxSteps, undefined);
  const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(saved.apiKey, stored.apiKey);
  assert.equal(saved.providerCatalog.providers[0].apiKey, stored.apiKey);
  assert.equal(saved.providerCatalog.version, 1);
  await harness.close();
  const reopened = await open();
  assert.deepEqual(reopened.getProviderCatalog(), catalog);
  await reopened.updateSettings({ model: '' });
  assert.equal(reopened.getProviderCatalog().active, null);
  assert.equal(reopened.getSettings().hasApiKey, true);
  await reopened.close();
  const pending = await open();
  assert.equal(pending.getSettings().provider, 'anthropic');
  assert.equal(pending.getSettings().hasApiKey, true);
  assert.equal(pending.getSettings().configured, false);
  await pending.updateSettings({ model: 'next-model' });
  assert.equal(pending.getProviderCatalog().providers[0].models.length, 2);
  assert.equal(pending.getSettings().configured, true);
});

test('catalog CRUD persists providers, unique models, parameter overrides and explicit activation', async context => {
  const { harness, open } = await fixture(context);
  assert.deepEqual(harness.getProviderCatalog(), { providers: [], active: null });
  const first = await profile(harness, { models: [{ id: 'team/coder', name: '编程模型', maxTokens: 1024, temperature: 0.4 }] });
  const second = await profile(harness, { name: '第二供应商', protocol: 'openai', models: [{ id: 'team/coder' }] });
  await harness.activateModel(first.id, 'team/coder');
  assert.equal(harness.getSettings().model, 'team/coder');
  assert.equal(harness.getSettings().maxTokens, 1024);
  assert.equal(harness.getSettings().temperature, 0.4);
  assert.equal(harness.getSettings().providerName, first.name);
  await harness.updateModel(first.id, 'team/coder', { maxTokens: 2048, temperature: null });
  assert.equal(harness.getSettings().maxTokens, 2048);
  assert.equal(harness.getSettings().temperature, 0.2);
  await harness.activateModel(second.id, 'team/coder');
  assert.equal(harness.getSettings().maxTokens, 4096);
  assert.equal(harness.getSettings().temperature, 0.2);
  await assert.rejects(harness.addModel(second.id, { id: 'team/coder' }), { statusCode: 409 });
  await harness.addProviderModels(first.id, { models: [{ id: 'small' }, { id: 'large', enabled: false }] });
  await harness.updateModel(first.id, 'small', { id: 'renamed', name: '改名模型' });
  await harness.deleteModel(first.id, 'renamed');
  const catalog = harness.getProviderCatalog();
  await harness.close();
  const reopened = await open();
  assert.deepEqual(reopened.getProviderCatalog(), catalog);
  assert.equal(reopened.getSettings().maxTokens, 4096);
  await reopened.deleteProvider(first.id);
  assert.equal(reopened.getProviderCatalog().providers.length, 1);
});

test('temporary launch overrides never alter the persisted legacy migration', async context => {
  const stored = { provider: 'responses', model: 'saved-model', apiKey: 'saved-only-key', approval: 'ask' };
  const { harness, settingsFile, open } = await fixture(context, { stored, settings: { model: 'temporary-model', apiKey: 'temporary-only-key' } });
  assert.equal(harness.getSettings().model, 'temporary-model');
  const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(saved.model, 'saved-model');
  assert.equal(saved.providerCatalog.active.modelId, 'saved-model');
  assert.deepEqual(saved.providerCatalog.providers[0].models.map(value => value.id), ['saved-model']);
  assert.ok(!JSON.stringify(saved).includes('temporary-only-key'));
  await harness.close();
  const reopened = await open({ settings: {} });
  assert.equal(reopened.getSettings().model, 'saved-model');
  assert.equal(reopened.settings.apiKey, 'saved-only-key');
});

test('active and disabled providers/models require explicit changes without silent fallback', async context => {
  const { harness } = await fixture(context);
  const selected = await profile(harness, { models: [{ id: 'enabled-model' }, { id: 'disabled-model', enabled: false }] });
  await harness.activateModel(selected.id, 'enabled-model');
  for (const mutate of [() => harness.deleteProvider(selected.id), () => harness.updateProvider(selected.id, { enabled: false }), () => harness.deleteModel(selected.id, 'enabled-model'), () => harness.updateModel(selected.id, 'enabled-model', { enabled: false }), () => harness.updateModel(selected.id, 'enabled-model', { id: 'renamed' })]) await assert.rejects(mutate(), { statusCode: 409 });
  await assert.rejects(harness.activateModel(selected.id, 'disabled-model'), { statusCode: 409 });
  await harness.activateModel(null, null);
  assert.equal(harness.getSettings().configured, false);
  await harness.updateProvider(selected.id, { enabled: false });
  await assert.rejects(harness.activateModel(selected.id, 'enabled-model'), { statusCode: 409 });
  await harness.deleteProvider(selected.id);
  assert.deepEqual(harness.getProviderCatalog(), { providers: [], active: null });
  await assert.rejects(harness.deleteProvider(selected.id), { statusCode: 404 });
});

test('concurrent mutations are atomic, duplicate batches roll back, and failures do not poison the queue', async context => {
  const { harness, settingsFile } = await fixture(context);
  const events = [];
  harness.on('event', event => events.push(event));
  await Promise.all(Array.from({ length: 12 }, (_, index) => harness.createProvider({ name: `供应商 ${index}`, protocol: 'responses', apiKey: `private-catalog-key-${index}` })));
  assert.equal(harness.getProviderCatalog().providers.length, 12);
  const selected = harness.getProviderCatalog().providers[0];
  await Promise.all(Array.from({ length: 10 }, (_, index) => harness.addModel(selected.id, { id: `model-${index}` })));
  const before = await readFile(settingsFile, 'utf8');
  await assert.rejects(harness.addProviderModels(selected.id, [{ id: 'would-have-been-new' }, { id: 'model-0' }]), { statusCode: 409 });
  assert.equal(await readFile(settingsFile, 'utf8'), before);
  assert.equal(harness.getProviderCatalog().providers[0].models.length, 10);
  await harness.updateProvider(selected.id, { name: '可以继续更新' });
  assert.equal(events.length, 23);
  assert.ok(events.every(event => event.type === 'settings.updated' && !event.sessionId && Object.keys(event.data).length === 0));
  assert.ok(!JSON.stringify(events).includes('private-catalog-key-'));
  assert.deepEqual((await readdir(path.dirname(settingsFile))).filter(name => name.endsWith('.tmp')), []);
});

test('failed atomic replacement leaves both in-memory catalog and prior settings unchanged', async context => {
  const { harness, settingsFile } = await fixture(context);
  await profile(harness);
  const before = harness.getProviderCatalog();
  const contents = await readFile(settingsFile, 'utf8');
  await rm(settingsFile);
  await mkdir(settingsFile);
  await assert.rejects(harness.createProvider({ name: '不能提交' }));
  assert.deepEqual(harness.getProviderCatalog(), before);
  await rmdir(settingsFile);
  await writeFile(settingsFile, contents);
  await harness.createProvider({ name: '恢复后可提交' });
  assert.equal(harness.getProviderCatalog().providers.length, 2);
});

test('legacy CLI/TUI patches preserve other profiles and model IDs while keeping effective settings coherent', async context => {
  const { harness } = await fixture(context);
  await harness.updateSettings({ apiKey: 'legacy-configured-key' });
  await harness.updateSettings({ model: 'original' });
  const original = harness.getProviderCatalog().active;
  await harness.updateModel(original.providerId, original.modelId, { maxTokens: 700 });
  await harness.updateSettings({ maxTokens: 900 });
  assert.equal(harness.getSettings().maxTokens, 900);
  await harness.updateSettings({ model: 'new-model' });
  assert.equal(harness.getSettings().maxTokens, 900);
  assert.deepEqual(harness.getProviderCatalog().providers[0].models.map(value => value.id), ['original', 'new-model']);
  await harness.updateSettings({ provider: 'anthropic', baseUrl: 'https://other.example/v1', model: 'another-model', apiKey: 'anthropic-private-key' });
  assert.equal(harness.getProviderCatalog().providers.length, 2);
  assert.equal(harness.getSettings().provider, 'anthropic');
  assert.equal(harness.getSettings().model, 'another-model');
  await harness.activateModel(original.providerId, original.modelId);
  assert.equal(harness.settings.apiKey, 'legacy-configured-key');
  assert.equal(harness.getSettings().maxTokens, 900);
});

test('all profile credentials are redacted and preserve/replace/clear semantics honor environment fallback', async context => {
  const { harness, settingsFile } = await fixture(context);
  const first = await profile(harness, { apiKey: '  inactive-whitespace-secret  ' });
  const second = await profile(harness, { apiKey: 'second-profile-private-key' });
  await harness.updateProvider(first.id, { apiKey: undefined, name: '保留密钥' });
  let saved = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(saved.providerCatalog.providers[0].apiKey, '  inactive-whitespace-secret  ');
  await harness.updateProvider(first.id, { apiKey: 'replacement-profile-key' });
  assert.equal(harness.getProviderCatalog().providers[0].apiKeySource, 'saved');
  process.env.OPENAI_API_KEY = 'environment-fallback-key';
  await harness.updateProvider(first.id, { apiKey: '' });
  assert.equal(harness.getProviderCatalog().providers[0].hasApiKey, true);
  assert.equal(harness.getProviderCatalog().providers[0].apiKeySource, 'environment');
  delete process.env.OPENAI_API_KEY;
  assert.equal(harness.getProviderCatalog().providers[0].hasApiKey, false);
  assert.equal(harness.getProviderCatalog().providers[0].apiKeySource, 'none');
  await harness.deleteProvider(second.id);
  const secrets = ['inactive-whitespace-secret', 'replacement-profile-key', 'second-profile-private-key', 'environment-fallback-key'];
  const session = await harness.createSession();
  harness.addMessage(harness.session(session.id), { role: 'user', content: secrets.join(' ') });
  await harness.flush();
  const publicData = JSON.stringify({ catalog: harness.getProviderCatalog(), settings: harness.getSettings(), sessions: harness.listSessions() });
  for (const secret of secrets) assert.ok(!publicData.includes(secret));
  const history = await readFile(path.join(path.dirname(settingsFile), 'sessions', `${session.id}.json`), 'utf8');
  for (const secret of secrets) assert.ok(!history.includes(secret));
  saved = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(saved.providerCatalog.providers[0].apiKey, '');
});

test('legacy protocol switches never copy another provider saved credentials', async context => {
  const { harness } = await fixture(context);
  await harness.updateSettings({ model: 'original-model', apiKey: 'original-provider-only-key' });
  const original = harness.getProviderCatalog().active;
  await harness.updateSettings({ provider: 'anthropic', model: 'new-protocol-model' });
  assert.equal(harness.getSettings().hasApiKey, false);
  assert.equal(harness.getSettings().configured, false);
  assert.equal(harness.settings.apiKey, '');
  await harness.updateSettings({ apiKey: 'anthropic-only-key' });
  await harness.updateSettings({ provider: 'responses', model: 'original-model' });
  assert.deepEqual(harness.getProviderCatalog().active, original);
  assert.equal(harness.settings.apiKey, 'original-provider-only-key');
  assert.equal(harness.getProviderCatalog().providers.length, 2);
});

test('short dummy credentials never corrupt public provider/model identities or native protocol names', async context => {
  const { harness } = await fixture(context);
  for (const key of ['a', 'ollama']) {
    const modelId = `${key}/team-coder`;
    const selected = await profile(harness, { name: '本地兼容网关', apiKey: key, models: [{ id: modelId }] });
    assert.equal(selected.id, harness.catalog.state.catalog.providers.at(-1).id);
    assert.equal(selected.models[0].id, modelId);
    assert.equal(selected.protocol, 'responses');
    await harness.activateModel(selected.id, modelId);
    assert.equal(harness.getSettings().model, modelId);
    assert.equal(harness.getSettings().activeProviderId, selected.id);
    assert.equal(harness.getSettings().activeModelId, modelId);
    assert.equal(harness.getSettings().apiKey, undefined);
    await harness.activateModel(null, null);
    await harness.deleteModel(selected.id, modelId);
    await harness.deleteProvider(selected.id);
  }
  const selected = await profile(harness, { apiKey: 'openai', protocol: 'openai', models: [{ id: 'local-model' }] });
  assert.equal(selected.protocol, 'openai');
  await harness.activateModel(selected.id, 'local-model');
  assert.equal(harness.getSettings().provider, 'openai');
  await assert.rejects(harness.createProvider({ apiKey: 'normal-private-api-key', models: [{ id: 'normal-private-api-key' }] }), /非秘密标识/);
  await assert.rejects(harness.createProvider({ apiKey: 'normal-private-api-key', models: [{ id: 'prefix-normal-private-api-key-model' }] }), /非秘密标识/);
});

test('active runs preserve provider, key and model parameter snapshots after default changes', async context => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const completion = async (settings, { onDelta }) => { calls.push(structuredClone(settings)); entered(); await gate; onDelta('完成'); return { content: '完成', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' }; };
  context.after(() => release());
  const { harness } = await fixture(context, { completion });
  const first = await profile(harness, { name: '原始供应商', apiKey: 'original-run-private-key', models: [{ id: 'original-model', maxTokens: 512 }] });
  const second = await profile(harness, { protocol: 'anthropic', models: [{ id: 'next-model' }] });
  await harness.activateModel(first.id, 'original-model');
  const session = await harness.createSession();
  const run = await harness.run(session.id, '快照测试');
  await running;
  await harness.activateModel(second.id, 'next-model');
  await harness.updateProvider(first.id, { protocol: 'openai', apiKey: 'updated-run-key', baseUrl: 'https://changed.example/v1' });
  await harness.updateModel(first.id, 'original-model', { maxTokens: 2048 });
  await assert.rejects(harness.deleteProvider(first.id), { statusCode: 409 });
  await assert.rejects(harness.deleteModel(first.id, 'original-model'), { statusCode: 409 });
  assert.equal(run.providerId, first.id);
  assert.equal(run.providerName, '原始供应商');
  assert.equal(run.provider, 'responses');
  assert.equal(run.model, 'original-model');
  assert.equal(calls[0].provider, 'responses');
  assert.equal(calls[0].apiKey, 'original-run-private-key');
  assert.equal(calls[0].maxTokens, 512);
  release();
  await harness.activeRuns.get(session.id).done;
  await harness.deleteProvider(first.id);
  assert.equal(harness.getSession(session.id).run.model, 'original-model');
});

test('profile connection tests use each native protocol without changing settings or importing models', async context => {
  const { harness, settingsFile } = await fixture(context);
  const server = await startModelServer();
  context.after(() => server.close());
  for (const protocol of ['responses', 'openai', 'anthropic']) {
    const selected = await profile(harness, { protocol, baseUrl: server.url, apiKey: 'test-key', models: [{ id: 'native-model' }] });
    const before = await readFile(settingsFile, 'utf8');
    const result = await harness.testProviderConnection(selected.id, { modelId: 'unsaved-model' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, protocol);
    assert.equal(result.modelId, 'unsaved-model');
    assert.equal(await readFile(settingsFile, 'utf8'), before);
    assert.equal(harness.getProviderCatalog().active, null);
    assert.equal(harness.listSessions().length, 0);
  }
});

test('native model discovery authenticates three protocols, preserves catalog, and deduplicates IDs', async context => {
  const { harness, settingsFile } = await fixture(context);
  const remote = await mock(context, (request, response) => json(response, { data: [{ id: 'discovered-model', display_name: '发现的模型' }, { id: 'discovered-model' }, { id: 'other-model' }, { missing: true }], has_more: false }));
  for (const protocol of ['responses', 'openai', 'anthropic']) {
    const selected = await profile(harness, { protocol, baseUrl: `${remote.baseUrl}/`, apiKey: 'discovery-private-key' });
    const before = await readFile(settingsFile, 'utf8');
    const result = await harness.discoverProviderModels(selected.id);
    assert.deepEqual(result.models.map(value => value.id), ['discovered-model', 'other-model']);
    assert.equal(result.truncated, false);
    assert.equal(await readFile(settingsFile, 'utf8'), before);
    const request = remote.requests.at(-1);
    assert.equal(request.method, 'GET');
    assert.equal(new URL(request.url, remote.baseUrl).pathname, '/v1/models');
    if (protocol === 'anthropic') { assert.equal(request.headers['x-api-key'], 'discovery-private-key'); assert.equal(request.headers['anthropic-version'], '2023-06-01'); assert.equal(request.headers.authorization, undefined); }
    else { assert.equal(request.headers.authorization, 'Bearer discovery-private-key'); assert.equal(request.headers['x-api-key'], undefined); }
  }
});

test('Anthropic discovery follows bounded native cursors and reports truncated model counts', async context => {
  const { harness } = await fixture(context);
  const remote = await mock(context, (request, response, count) => {
    const url = new URL(request.url, 'http://localhost');
    if (count === 1) { assert.equal(url.searchParams.get('after_id'), null); json(response, { data: [{ id: 'first', display_name: '第一个' }], has_more: true, last_id: 'first' }); }
    else { assert.equal(url.searchParams.get('after_id'), 'first'); json(response, { data: Array.from({ length: 1100 }, (_, index) => ({ id: `model-${index}` })), has_more: true, last_id: 'last' }); }
  });
  const selected = await profile(harness, { protocol: 'anthropic', baseUrl: remote.baseUrl });
  const result = await harness.discoverProviderModels(selected.id);
  assert.equal(result.models.length, 1000);
  assert.equal(result.models[0].name, '第一个');
  assert.equal(result.truncated, true);
  assert.equal(remote.requests.length, 2);
});

test('discovery rejects redirects, oversized and malformed responses without leaking stored or draft keys', async context => {
  const { harness } = await fixture(context);
  let behavior = 'error';
  const remote = await mock(context, (request, response) => {
    if (behavior === 'error') json(response, { error: 'private-discovery-key unsaved-discovery-key inactive-discovery-key' }, 401);
    else if (behavior === 'redirect') { response.writeHead(302, { location: '/redirect-leak' }); response.end(); }
    else if (behavior === 'large') { response.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 }); response.end('oversized'); }
    else if (behavior === 'stream-large') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('x'.repeat(1024 * 1024 + 1)); }
    else json(response, { models: [] });
  });
  await profile(harness, { apiKey: 'inactive-discovery-key' });
  const selected = await profile(harness, { baseUrl: remote.baseUrl, apiKey: 'private-discovery-key' });
  await assert.rejects(harness.discoverProviderModels(selected.id, { apiKey: 'unsaved-discovery-key' }), error => error.statusCode === 502 && /401/.test(error.message) && !/private-discovery-key|unsaved-discovery-key|inactive-discovery-key/.test(error.message));
  for (const next of ['redirect', 'large', 'stream-large', 'malformed']) {
    behavior = next;
    const before = remote.requests.length;
    await assert.rejects(harness.discoverProviderModels(selected.id), { statusCode: 502 });
    assert.equal(remote.requests.length, before + 1);
  }
});

test('discovery timeout, caller abort and harness close terminate real pending requests', async context => {
  const { harness } = await fixture(context);
  let seen;
  const remote = await mock(context, () => { seen?.(); });
  const selected = await profile(harness, { baseUrl: remote.baseUrl });
  await harness.updateSettings({ providerTimeoutMs: 100 });
  await assert.rejects(harness.discoverProviderModels(selected.id), { statusCode: 504 });
  await harness.updateSettings({ providerTimeoutMs: 5000 });
  const controller = new AbortController();
  const requested = new Promise(resolve => { seen = resolve; });
  const pending = harness.discoverProviderModels(selected.id, { signal: controller.signal });
  const cancelled = assert.rejects(pending, { statusCode: 499, name: 'AbortError' });
  await requested;
  controller.abort();
  await cancelled;
  const finalRequest = new Promise(resolve => { seen = resolve; });
  const finalCheck = assert.rejects(harness.discoverProviderModels(selected.id), { statusCode: 499 });
  await finalRequest;
  await harness.close();
  await finalCheck;
  assert.equal(harness.connectionChecks.size, 0);
});

test('discovery redacts active and inactive credentials before truncating HTTP error details', async context => {
  const { harness } = await fixture(context);
  const activeKey = 'active-truncation-private-credential';
  const inactiveKey = 'inactive-truncation-private-credential';
  let echoedKey = activeKey;
  const remote = await mock(context, (_request, response) => {
    response.writeHead(401, { 'content-type': 'text/plain' });
    response.end('x'.repeat(1490) + echoedKey + 'tail'.repeat(20));
  });
  await profile(harness, { apiKey: inactiveKey });
  const selected = await profile(harness, { baseUrl: remote.baseUrl, apiKey: activeKey });
  for (const secret of [activeKey, inactiveKey]) {
    echoedKey = secret;
    await assert.rejects(harness.discoverProviderModels(selected.id), error => {
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes(secret.slice(0, 10)));
      const detail = error.message.slice(error.message.indexOf(': ') + 2);
      assert.equal(detail.length, 1500);
      assert.ok(detail.endsWith('[REDACTED]'));
      return true;
    });
  }
});

test('discovery redacts display names before length limits and omits credential-bearing model IDs', async context => {
  const { harness, settingsFile } = await fixture(context);
  const activeKey = 'active-name-truncation-credential';
  const inactiveKey = 'inactive-name-truncation-credential';
  const remote = await mock(context, (_request, response) => json(response, { data: [
    { id: 'safe-model', display_name: 'x'.repeat(500) + activeKey + 'extra suffix' },
    { id: 'inactive-label', display_name: 'x'.repeat(500) + inactiveKey + 'extra suffix' },
    { id: `prefix-${activeKey}-model`, display_name: '不应返回此 ID' },
    { id: inactiveKey, display_name: '不应返回此凭据' },
    { id: 'bounded-name', display_name: 'z'.repeat(2000) },
  ] }));
  await profile(harness, { apiKey: inactiveKey });
  const selected = await profile(harness, { baseUrl: remote.baseUrl, apiKey: activeKey });
  const before = await readFile(settingsFile, 'utf8');
  const result = await harness.discoverProviderModels(selected.id);
  assert.deepEqual(result.models.map(value => value.id), ['safe-model', 'inactive-label', 'bounded-name']);
  assert.ok(result.models.every(value => value.name.length === 512));
  assert.ok(result.models.slice(0, 2).every(value => value.name.includes('[REDACTED]')));
  for (const secret of [activeKey, inactiveKey]) assert.ok(!JSON.stringify(result).includes(secret.slice(0, 12)));
  assert.equal(await readFile(settingsFile, 'utf8'), before);
});

test('catalog rejects invalid protocols, fields, IDs, ranges and ambiguous model batches', async context => {
  const { harness } = await fixture(context);
  for (const input of [{ protocol: 'demo' }, { apiKey: null }, { enabled: 'false' }, { baseUrl: 'https://user:key@example.test' }, { name: '' }, { name: null }, { id: 'client-selected-id' }]) await assert.rejects(harness.createProvider(input));
  const selected = await profile(harness);
  for (const input of [{ id: '' }, { id: 'bad\nmodel' }, { id: 'valid', maxTokens: 0 }, { id: 'valid', temperature: 3 }, { id: 'valid', enabled: null }, { id: 'valid', name: null }, { id: 'valid', secret: 'hidden' }]) await assert.rejects(harness.addModel(selected.id, input));
  await assert.rejects(harness.addProviderModels(selected.id, [{ id: 'duplicate' }, { id: 'duplicate' }]), { statusCode: 409 });
  assert.equal(harness.getProviderCatalog().providers[0].models.length, 0);
  await assert.rejects(harness.testProviderConnection(selected.id), { statusCode: 400 });
  await assert.rejects(harness.testProviderConnection(selected.id, { modelId: 'test-model', apiKey: null }));
  await assert.rejects(harness.updateProvider(selected.id, { models: [] }));
});

test('opaque provider history only replays for the original profile, protocol, gateway and model', async context => {
  const received = [];
  const completion = async (_settings, { messages }) => {
    received.push(structuredClone(messages));
    const number = received.length;
    return { content: `历史正文 ${number}`, toolCalls: [], providerItems: [{ id: `opaque-${number}`, type: 'reasoning', encrypted_content: `encrypted-${number}`, summary: [] }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
  };
  const { harness, open, settingsFile } = await fixture(context, { completion });
  const first = await profile(harness, { baseUrl: 'https://first.example/v1', models: [{ id: 'alpha' }, { id: 'beta' }] });
  const second = await profile(harness, { baseUrl: 'https://first.example/v1', models: [{ id: 'alpha' }] });
  await harness.activateModel(first.id, 'alpha');
  const session = await harness.createSession();
  const run = async (current = harness) => {
    await current.run(session.id, '继续历史');
    await current.activeRuns.get(session.id).done;
    assert.equal(current.getSession(session.id).run.status, 'completed');
    return received.at(-1).filter(message => message.role === 'assistant');
  };
  await run();
  let history = await run();
  assert.equal(history[0].providerItems[0].id, 'opaque-1');
  assert.deepEqual(history[0].providerContext, { providerId: first.id, scope: 'workspace', protocol: 'responses', baseUrl: 'https://first.example/v1', model: 'alpha' });
  await harness.activateModel(first.id, 'beta');
  history = await run();
  assert.deepEqual(history.map(message => message.content), ['历史正文 1', '历史正文 2']);
  assert.ok(history.every(message => message.providerItems === undefined));
  await harness.updateProvider(first.id, { baseUrl: 'https://changed.example/v1' });
  history = await run();
  assert.ok(history.every(message => message.providerItems === undefined));
  await harness.updateProvider(first.id, { protocol: 'openai' });
  history = await run();
  assert.ok(history.every(message => message.providerItems === undefined));
  await harness.activateModel(second.id, 'alpha');
  history = await run();
  assert.ok(history.every(message => message.providerItems === undefined));
  const persisted = JSON.parse(await readFile(path.join(path.dirname(settingsFile), 'sessions', `${session.id}.json`), 'utf8'));
  assert.ok(persisted.messages.filter(message => message.role === 'assistant').every(message => message.providerItems.length === 1));
  for (const message of persisted.messages.filter(value => value.role === 'assistant')) assert.deepEqual(Object.keys(message.providerContext).sort(), ['baseUrl', 'model', 'protocol', 'providerId', 'scope']);
  assert.ok(!JSON.stringify(persisted).includes('catalog-test-secret'));
  await harness.close();
  const reopened = await open();
  history = await run(reopened);
  assert.equal(history.at(-1).providerItems[0].id, 'opaque-6');
  assert.ok(history.slice(0, -1).every(message => message.providerItems === undefined));
});

test('unknown legacy opaque items downgrade safely while same-run reasoning survives tool round trips', async context => {
  const received = [];
  const reasoning = { id: 'current-reasoning', type: 'reasoning', encrypted_content: 'current-encrypted-reasoning', summary: [] };
  const functionCall = { id: 'current-function', type: 'function_call', call_id: 'current-call', name: 'list_files', arguments: '{"path":"."}', status: 'completed' };
  const completion = async (_settings, { messages }) => {
    received.push(structuredClone(messages));
    return received.length === 1
      ? { content: '当前工具调用正文', toolCalls: [{ id: 'current-call', name: 'list_files', args: { path: '.' } }], providerItems: [reasoning, functionCall], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'tool_calls' }
      : { content: '当前轮次完成', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
  };
  const { harness } = await fixture(context, { completion });
  const selected = await profile(harness, { models: [{ id: 'alpha' }] });
  await harness.activateModel(selected.id, 'alpha');
  const session = await harness.createSession();
  const legacyItems = [{ id: 'unknown-reasoning', type: 'reasoning', encrypted_content: 'unknown-encrypted-content' }];
  harness.addMessage(harness.session(session.id), { role: 'assistant', content: '保留旧正文', toolCalls: [{ id: 'old-call', name: 'list_files', args: { path: '.' } }], providerItems: legacyItems });
  harness.addMessage(harness.session(session.id), { role: 'tool', toolCallId: 'old-call', content: '{"entries":[]}' });
  await harness.run(session.id, '继续旧会话');
  await harness.activeRuns.get(session.id).done;
  assert.equal(harness.getSession(session.id).run.status, 'completed');
  assert.equal(received.length, 2);
  for (const messages of received) {
    assert.equal(messages[0].content, '保留旧正文');
    assert.equal(messages[0].providerItems, undefined);
    assert.equal(messages[0].toolCalls[0].id, 'old-call');
    assert.equal(messages[1].toolCallId, 'old-call');
    assert.equal(messages[1].content, '{"entries":[]}');
  }
  const current = received[1].find(message => message.toolCalls?.some(call => call.id === 'current-call'));
  assert.deepEqual(current.providerItems, [reasoning, functionCall]);
  assert.equal(current.providerContext.providerId, selected.id);
  assert.equal(current.providerContext.model, 'alpha');
  assert.ok(received[1].some(message => message.role === 'tool' && message.toolCallId === 'current-call'));
  assert.deepEqual(harness.getSession(session.id).messages[0].providerItems, legacyItems);
});

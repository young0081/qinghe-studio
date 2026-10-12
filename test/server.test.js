import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHarness } from '../src/core/harness.js';
import { startServer } from '../src/server.js';
import { testCompletion } from './fixtures/completion.js';
import { startModelServer } from './fixtures/model-server.js';

async function fixture(context, settings = {}, serverOptions = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'harness-server-'));
  const harness = await createHarness({ workspace, completion: testCompletion, settings: { provider: 'responses', model: 'test-model', apiKey: 'test-key', ...settings } });
  const server = await startServer({ harness, port: 0, ...serverOptions });
  context.after(async () => { await server.close(); await harness.close(); await rm(workspace, { recursive: true, force: true }); });
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`${server.url}${route}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { workspace, harness, server, request };
}

function waitEvent(harness, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harness.off('event', listener); reject(new Error(`Timed out: ${type}`)); }, timeout);
    const listener = event => {
      if (event.type === type) { clearTimeout(timer); harness.off('event', listener); resolve(event); }
    };
    harness.on('event', listener);
  });
}

test('HTTP sessions, settings redaction, files, and validation', async context => {
  const { workspace, request } = await fixture(context);
  await writeFile(path.join(workspace, 'sample.txt'), 'hello from a real file');
  assert.equal((await request('/api/health')).body.ok, true);
  const created = await request('/api/sessions', 'POST', { title: 'API session' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await request(`/api/sessions/${id}`)).body.title, 'API session');
  assert.equal((await request('/api/sessions')).body.length, 1);
  const settings = await request('/api/settings', 'PATCH', { apiKey: 'test-secret-value' });
  assert.equal(settings.status, 200);
  assert.ok(!JSON.stringify(settings.body).includes('test-secret-value'));
  assert.equal((await request('/api/file?path=sample.txt')).body.content, 'hello from a real file');
  assert.notEqual((await request('/api/file?path=../outside.txt')).status, 200);
  assert.notEqual((await request('/api/file?path=.harness/state.json')).status, 200);
  assert.equal((await request(`/api/sessions/${id}/run`, 'POST', { prompt: '' })).status, 400);
  assert.equal((await request('/api/approvals/bad', 'POST', { approved: 'yes' })).status, 400);
  assert.equal((await request(`/api/sessions/${id}`, 'DELETE')).status, 200);
  assert.notEqual((await request(`/api/sessions/${id}`)).status, 200);
});

test('HTTP drives approvals, checkpoints and cancellation through shared core', async context => {
  const { request, harness, workspace } = await fixture(context);
  const { body: session } = await request('/api/sessions', 'POST', { title: 'Approval round trip' });
  const approvalReady = waitEvent(harness, 'approval.required');
  assert.equal((await request(`/api/sessions/${session.id}/run`, 'POST', { prompt: '[test:write]' })).status, 202);
  const approval = (await approvalReady).data;
  assert.equal((await request(`/api/sessions/${session.id}/run`, 'POST', { prompt: 'overlap' })).status, 409);
  const completed = waitEvent(harness, 'run.completed');
  assert.equal((await request(`/api/approvals/${approval.id}`, 'POST', { approved: true })).status, 200);
  await completed;
  const persisted = (await request(`/api/sessions/${session.id}`)).body;
  assert.equal(persisted.run.status, 'completed');
  assert.ok(persisted.checkpoints.length > 0);
  const checkpoint = persisted.checkpoints[0];
  assert.equal((await request(`/api/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`, 'POST', {})).status, 200);
  const nextApproval = waitEvent(harness, 'approval.required');
  await request(`/api/sessions/${session.id}/run`, 'POST', { prompt: '[test:write]' });
  await nextApproval;
  const cancelled = waitEvent(harness, 'run.cancelled');
  assert.equal((await request(`/api/sessions/${session.id}/cancel`, 'POST', {})).status, 200);
  await cancelled;
  assert.equal(harness.getSession(session.id).run.status, 'cancelled');
});

test('SSE streams real events and replays after reconnect', async context => {
  const { harness, server } = await fixture(context);
  const session = await harness.createSession({ title: 'SSE' });
  const controller = new AbortController();
  context.after(() => controller.abort());
  const response = await fetch(`${server.url}/api/events?sessionId=${session.id}`, { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  await reader.read();
  const completed = waitEvent(harness, 'run.completed');
  await harness.run(session.id, 'Inspect this workspace');
  let stream = '';
  while (!stream.includes('run.completed')) {
    const { value, done } = await reader.read();
    if (done) break;
    stream += new TextDecoder().decode(value);
  }
  await completed;
  assert.match(stream, /event: harness/);
  assert.match(stream, /assistant.delta/);
  const events = harness.getSession(session.id).events;
  const started = events.find(event => event.type === 'run.started');
  controller.abort();
  const replayAbort = new AbortController();
  context.after(() => replayAbort.abort());
  const replay = await fetch(`${server.url}/api/events?sessionId=${session.id}`, { signal: replayAbort.signal, headers: { 'Last-Event-ID': started.id } });
  const replayReader = replay.body.getReader();
  const chunk = await replayReader.read();
  assert.match(new TextDecoder().decode(chunk.value), /run.completed/);
  replayAbort.abort();
});

test('local server rejects foreign origins and host headers', async context => {
  const { server } = await fixture(context);
  assert.equal((await fetch(`${server.url}/api/health`, { headers: { Origin: 'https://malicious.example' } })).status, 403);
  assert.equal((await fetch(`${server.url}/api/health`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const request = http.get(`${server.url}/api/health`, { headers: { Host: 'malicious.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(status, 403);
});

test('connection testing uses the selected native API without persisting candidate credentials', async context => {
  const model = await startModelServer();
  context.after(() => model.close());
  const { request, harness } = await fixture(context);
  const original = harness.getSettings();
  for (const provider of ['responses', 'openai', 'anthropic']) {
    const response = await request('/api/connection/test', 'POST', { provider, model: 'connection-test', baseUrl: model.url, apiKey: 'test-key' });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.provider, provider);
    assert.equal(response.body.model, 'connection-test');
    assert.ok(response.body.latencyMs >= 0);
    assert.ok(!JSON.stringify(response.body).includes('test-key'));
    assert.deepEqual(harness.getSettings(), original);
    assert.equal(harness.listSessions().length, 0);
  }
  const failure = await request('/api/connection/test', 'POST', { model: '', apiKey: '' });
  assert.equal(failure.status, 400);
  assert.equal(failure.body.ok, undefined);
  assert.deepEqual(harness.getSettings(), original);
});

test('desktop server authenticates every asset, API and event stream without changing public WebUI mode', async context => {
  const authToken = 'private-desktop-test-token-32-bytes-long';
  const { server } = await fixture(context, {}, { authToken });
  for (const route of ['/api/health', '/api/settings', '/api/providers', '/api/events', '/']) {
    assert.equal((await fetch(`${server.url}${route}`)).status, 401);
    assert.equal((await fetch(`${server.url}${route}`, { headers: { 'X-Harness-Token': 'wrong' } })).status, 401);
  }
  const response = await fetch(`${server.url}/api/health`, { headers: { 'X-Harness-Token': authToken } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('HTTP provider catalog manages native suppliers, model discovery and persisted active selections', async context => {
  const model = await startModelServer();
  context.after(() => model.close());
  const { request, harness } = await fixture(context);
  const initial = (await request('/api/providers')).body;
  assert.equal(initial.providers.length, 1);
  assert.equal(initial.active.modelId, 'test-model');
  const events = [];
  harness.on('event', event => { if (event.type === 'settings.updated') events.push(event); });
  for (const protocol of ['responses', 'openai', 'anthropic']) {
    const created = await request('/api/providers', 'POST', { name: `供应商 ${protocol}`, protocol, baseUrl: model.url, apiKey: 'test-key', enabled: true });
    assert.equal(created.status, 201);
    const provider = created.body.providers.find(item => item.name === `供应商 ${protocol}`);
    assert.ok(provider.id);
    assert.equal(provider.hasApiKey, true);
    assert.equal(provider.apiKeySource, 'saved');
    assert.equal(provider.apiKey, undefined);
    const prefix = `/api/providers/${provider.id}`;
    const modelId = `team/${protocol}-coding`;
    const models = await request(`${prefix}/models`, 'POST', { models: [{ id: modelId, name: '编程模型', enabled: true, maxTokens: 1024, temperature: 0.4 }] });
    assert.equal(models.status, 201);
    assert.equal((await request(`${prefix}/models/${encodeURIComponent(modelId)}`, 'PATCH', { name: '主力编程模型' })).status, 200);
    const discovered = await request(`${prefix}/discover`, 'POST', {});
    assert.equal(discovered.status, 200);
    assert.ok(discovered.body.models.some(item => item.id === 'test-model'));
    assert.equal((await request('/api/providers')).body.providers.find(item => item.id === provider.id).models.length, 1);
    const connection = await request(`${prefix}/test`, 'POST', { modelId });
    assert.equal(connection.status, 200);
    assert.equal(connection.body.ok, true);
    assert.equal(connection.body.provider, protocol);
    assert.equal(connection.body.model, modelId);
    const activated = await request('/api/providers/active', 'POST', { providerId: provider.id, modelId });
    assert.equal(activated.status, 200);
    assert.deepEqual(activated.body.active, { providerId: provider.id, modelId });
    const settings = (await request('/api/settings')).body;
    assert.equal(settings.provider, protocol);
    assert.equal(settings.model, modelId);
    assert.equal(settings.providerName, `供应商 ${protocol}`);
    assert.equal(settings.activeProviderId, provider.id);
    assert.equal(settings.maxTokens, 1024);
    assert.ok(!JSON.stringify({ settings, catalog: activated.body, events }).includes('test-key'));
    assert.equal((await request(prefix, 'DELETE')).status, 409);
    assert.equal((await request(prefix, 'PATCH', { enabled: false })).status, 409);
    assert.equal((await request(`${prefix}/models/${encodeURIComponent(modelId)}`, 'DELETE')).status, 409);
    assert.equal((await request('/api/providers/active', 'POST', { providerId: null, modelId: null })).status, 200);
    assert.equal((await request(`${prefix}/models/${encodeURIComponent(modelId)}`, 'PATCH', { id: `${modelId}-renamed`, maxTokens: null, temperature: null })).status, 200);
    assert.equal((await request(`${prefix}/models/${encodeURIComponent(`${modelId}-renamed`)}`, 'DELETE')).status, 200);
    assert.equal((await request(prefix, 'DELETE')).status, 200);
  }
  assert.ok(events.length > 0);
  assert.equal((await request('/api/providers/active', 'POST', {})).status, 400);
  assert.equal((await request('/api/providers/no-such-provider', 'PATCH', { name: '不存在' })).status, 404);
});

test('HTTP catalog mutations retain concurrent providers and guard running model references', async context => {
  const { request, harness } = await fixture(context);
  const original = (await request('/api/providers')).body.active;
  const created = await Promise.all(['并发供应商甲', '并发供应商乙'].map(name => request('/api/providers', 'POST', { name, protocol: 'responses', apiKey: 'test-key' })));
  assert.ok(created.every(response => response.status === 201));
  const catalog = (await request('/api/providers')).body;
  assert.equal(catalog.providers.length, 3);
  const replacement = catalog.providers.find(provider => provider.name === '并发供应商甲');
  assert.equal((await request(`/api/providers/${replacement.id}/models`, 'POST', { models: [{ id: 'replacement', name: '备用模型' }] })).status, 201);
  const session = (await request('/api/sessions', 'POST', {})).body;
  const approval = waitEvent(harness, 'approval.required');
  await request(`/api/sessions/${session.id}/run`, 'POST', { prompt: '[test:write]' });
  await approval;
  await request('/api/providers/active', 'POST', { providerId: replacement.id, modelId: 'replacement' });
  assert.equal((await request(`/api/providers/${original.providerId}`, 'DELETE')).status, 409);
  assert.equal((await request(`/api/providers/${original.providerId}/models/${original.modelId}`, 'DELETE')).status, 409);
  assert.equal((await request(`/api/sessions/${session.id}/cancel`, 'POST', {})).status, 200);
  assert.equal((await request(`/api/providers/${original.providerId}`, 'DELETE')).status, 200);
});

test('session-scoped SSE receives global settings updates without credential data', async context => {
  const { harness, server, request } = await fixture(context);
  const session = await harness.createSession();
  const controller = new AbortController();
  context.after(() => controller.abort());
  const response = await fetch(`${server.url}/api/events?sessionId=${session.id}`, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  await request('/api/providers', 'POST', { name: '全局通知', protocol: 'responses', apiKey: 'hidden-catalog-credential' });
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /settings.updated/);
  assert.ok(!text.includes('hidden-catalog-credential'));
  controller.abort();
});

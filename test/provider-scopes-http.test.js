import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarness } from '../src/core/harness.js';
import { startServer } from '../src/server.js';
import { startModelServer } from './fixtures/model-server.js';

async function fixture(context) {
  const temporaryParent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(temporaryParent, 'harness-provider-scopes-http-'));
  const globalConfigDir = path.join(directory, 'shared-config');
  const resources = [];
  const models = [];
  context.after(async () => {
    for (const resource of resources.reverse()) { await resource.server.close(); await resource.harness.close(); }
    for (const model of models) await model.close();
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), temporaryParent);
    assert.ok(path.basename(resolved).startsWith('harness-provider-scopes-http-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const open = async (name = 'workspace', options = {}) => {
    const workspace = path.join(directory, name);
    await mkdir(workspace, { recursive: true });
    const harness = await createHarness({ workspace, globalConfigDir });
    const server = await startServer({ harness, port: 0, ...options });
    const resource = { harness, server };
    resources.push(resource);
    const request = async (route, method = 'GET', body, headers = {}) => {
      const response = await fetch(`${server.url}${route}`, { method, headers: { ...(options.authToken ? { 'X-Harness-Token': options.authToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    return { workspace, harness, server, request, async close() { await server.close(); await harness.close(); resources.splice(resources.indexOf(resource), 1); } };
  };
  const modelServer = async apiKey => {
    const model = await startModelServer({ apiKey });
    models.push(model);
    return model;
  };
  return { directory, globalConfigDir, open, modelServer };
}

async function addSource(client, scope, { model = `${scope}-model`, name = `${scope} provider`, baseUrl = 'https://example.com/v1', apiKey = `scope-${scope}-secret-123456` } = {}) {
  const created = await client.request(`/api/providers?scope=${scope}`, 'POST', { name, protocol: 'responses', baseUrl, apiKey, models: [{ id: model }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const provider = created.body.providers.find(item => item.name === name);
  assert.ok(provider);
  const selected = await client.request(`/api/providers/active?scope=${scope}`, 'POST', { providerId: provider.id, modelId: model });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  return { id: provider.id, model, apiKey, baseUrl };
}

async function waitFor(client, sessionId, status) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const session = client.harness.getSession(sessionId);
    if (session.run?.status === status) return session;
    if (session.run?.status === 'failed') assert.fail(session.run.error);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Session ${sessionId} did not reach ${status}`);
}

test('provider scope endpoints preserve desktop authentication and reject ambiguous or invalid scope', async context => {
  const isolated = await fixture(context);
  const client = await isolated.open('workspace', { authToken: 'isolated-desktop-auth-token-1234567890' });
  for (const route of ['/api/provider-scopes', '/api/providers?scope=global']) {
    assert.equal((await fetch(`${client.server.url}${route}`)).status, 401);
    assert.equal((await client.request(route, 'GET', undefined, { Origin: 'https://foreign.example' })).status, 403);
  }
  const initial = await client.request('/api/provider-scopes');
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.equal(initial.body.activeScope, 'workspace');
  assert.deepEqual(initial.body.global.providers, []);
  assert.deepEqual(initial.body.workspace.providers, []);
  for (const body of [{}, { scope: 'account' }, { scope: 'GLOBAL' }, { scope: null }, { scope: ['global'] }, { scope: 'global', unexpected: true }]) assert.equal((await client.request('/api/provider-scopes', 'POST', body)).status, 400);
  for (const query of ['scope=', 'scope=account', 'scope=GLOBAL', 'scope=..%2Fglobal', 'scope=global&scope=workspace']) {
    for (const [route, method, body] of [['/api/providers', 'GET'], ['/api/providers', 'POST', { name: 'invalid' }], ['/api/providers/active', 'POST', { providerId: null, modelId: null }]]) assert.equal((await client.request(`${route}?${query}`, method, body)).status, 400);
  }
  assert.deepEqual((await client.request('/api/provider-scopes')).body, initial.body);
});

test('HTTP keeps both catalogs and defaults separate and scopes CRUD, discovery and connection tests', async context => {
  const isolated = await fixture(context);
  const native = await isolated.modelServer('global-http-secret-123456');
  const client = await isolated.open();
  const workspace = await addSource(client, 'workspace');
  assert.equal((await client.request('/api/provider-scopes', 'POST', { scope: 'global' })).status, 200);
  const emptyGlobal = (await client.request('/api/settings')).body;
  assert.equal(emptyGlobal.providerScope, 'global');
  assert.equal(emptyGlobal.model, '');
  assert.equal(emptyGlobal.configured, false);
  assert.equal((await client.request('/api/providers')).body.providers.length, 0);
  assert.equal((await client.request('/api/provider-scopes', 'POST', { scope: 'workspace' })).status, 200);
  assert.equal((await client.request('/api/settings')).body.model, workspace.model);
  const global = await addSource(client, 'global', { baseUrl: native.url, apiKey: 'global-http-secret-123456' });
  const before = (await client.request('/api/provider-scopes')).body;
  assert.equal(before.activeScope, 'workspace');
  assert.deepEqual(before.workspace.active, { providerId: workspace.id, modelId: workspace.model });
  assert.deepEqual(before.global.active, { providerId: global.id, modelId: global.model });
  assert.deepEqual((await client.request('/api/providers')).body, before.workspace);
  assert.equal((await client.request(`/api/providers/${global.id}?scope=workspace`, 'PATCH', { name: 'wrong catalog' })).status, 404);
  assert.equal((await client.request(`/api/providers/${global.id}?scope=global`, 'PATCH', { name: 'Shared profile' })).status, 200);
  assert.equal((await client.request(`/api/providers/${global.id}/models?scope=global`, 'POST', { models: [{ id: 'extra-model' }] })).status, 201);
  assert.equal((await client.request(`/api/providers/${global.id}/models/extra-model?scope=global`, 'PATCH', { name: 'Extra renamed' })).status, 200);
  assert.equal((await client.request(`/api/providers/${global.id}/test?scope=global`, 'POST', { modelId: global.model })).status, 200);
  const discovery = await client.request(`/api/providers/${global.id}/discover?scope=global`, 'POST', {});
  assert.equal(discovery.status, 200);
  assert.ok(discovery.body.models.some(item => item.id === 'discovered-small'));
  assert.equal((await client.request(`/api/providers/${global.id}/models/extra-model?scope=global`, 'DELETE')).status, 200);
  assert.deepEqual((await client.request('/api/providers?scope=workspace')).body, before.workspace);
  assert.equal((await client.request('/api/settings')).body.model, workspace.model);
  const switched = await client.request('/api/provider-scopes', 'POST', { scope: 'global' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.activeScope, 'global');
  assert.deepEqual((await client.request('/api/providers')).body, switched.body.global);
  assert.equal((await client.request('/api/settings')).body.providerScope, 'global');
  assert.equal((await client.request('/api/settings')).body.model, global.model);
  assert.ok(!JSON.stringify(switched.body).includes(global.apiKey));
  assert.ok(!JSON.stringify(switched.body).includes(workspace.apiKey));
  assert.equal((await client.request('/api/provider-scopes', 'POST', { scope: 'workspace' })).status, 200);
  assert.equal((await client.request('/api/settings')).body.model, workspace.model);
});

test('a shared user catalog survives independent workspaces and restart without replacing legacy local settings', async context => {
  const isolated = await fixture(context);
  const first = await isolated.open('first');
  const local = await addSource(first, 'workspace');
  const global = await addSource(first, 'global');
  const initialGlobal = (await first.request('/api/providers?scope=global')).body;
  assert.equal((await first.request('/api/provider-scopes', 'POST', { scope: 'global' })).status, 200);
  assert.ok(!(await readFile(path.join(first.workspace, '.harness/settings.json'), 'utf8')).includes(global.apiKey));
  const legacyWorkspace = path.join(isolated.directory, 'legacy');
  await mkdir(path.join(legacyWorkspace, '.harness'), { recursive: true });
  await writeFile(path.join(legacyWorkspace, '.harness/settings.json'), JSON.stringify({ provider: 'responses', model: 'legacy-local-model', apiKey: 'legacy-local-secret-123456', baseUrl: 'https://legacy.example/v1' }));
  const second = await isolated.open('legacy');
  const secondScopes = (await second.request('/api/provider-scopes')).body;
  assert.equal(secondScopes.activeScope, 'workspace');
  assert.deepEqual(secondScopes.global, initialGlobal);
  assert.equal(secondScopes.workspace.providers[0].models[0].id, 'legacy-local-model');
  assert.equal((await second.request('/api/settings')).body.model, 'legacy-local-model');
  assert.equal((await second.request('/api/provider-scopes', 'POST', { scope: 'global' })).status, 200);
  assert.equal((await second.request(`/api/providers/${global.id}?scope=global`, 'PATCH', { name: 'Updated shared name' })).status, 200);
  assert.equal((await first.request('/api/providers?scope=global')).body.providers[0].name, 'Updated shared name');
  await first.close();
  await second.close();
  const restoredFirst = await isolated.open('first');
  const restoredSecond = await isolated.open('legacy');
  assert.equal((await restoredFirst.request('/api/provider-scopes')).body.activeScope, 'global');
  assert.equal((await restoredSecond.request('/api/provider-scopes')).body.activeScope, 'global');
  assert.equal((await restoredFirst.request('/api/settings')).body.model, global.model);
  assert.equal((await restoredSecond.request('/api/settings')).body.model, global.model);
  assert.equal((await restoredFirst.request('/api/provider-scopes', 'POST', { scope: 'workspace' })).status, 200);
  assert.equal((await restoredFirst.request('/api/settings')).body.model, local.model);
  assert.equal((await restoredSecond.request('/api/provider-scopes', 'POST', { scope: 'workspace' })).status, 200);
  const legacySettings = (await restoredSecond.request('/api/settings')).body;
  assert.equal(legacySettings.model, 'legacy-local-model');
  assert.equal(legacySettings.hasApiKey, true);
  assert.ok((await readFile(path.join(legacyWorkspace, '.harness/settings.json'), 'utf8')).includes('legacy-local-model'));
});

test('switching scope during a native run retains its provider snapshot while the next run uses the selected scope', async context => {
  const isolated = await fixture(context);
  const localNative = await isolated.modelServer('native-local-secret-123456');
  const globalNative = await isolated.modelServer('native-global-secret-123456');
  const client = await isolated.open();
  const local = await addSource(client, 'workspace', { baseUrl: localNative.url, apiKey: 'native-local-secret-123456' });
  const global = await addSource(client, 'global', { baseUrl: globalNative.url, apiKey: 'native-global-secret-123456' });
  const session = (await client.request('/api/sessions', 'POST', { title: 'Snapshot across provider scopes' })).body;
  assert.equal((await client.request(`/api/sessions/${session.id}/run`, 'POST', { prompt: '[test:question]' })).status, 202);
  await waitFor(client, session.id, 'waiting_input');
  assert.equal((await client.request('/api/provider-scopes', 'POST', { scope: 'global' })).status, 200);
  const question = (await client.request('/api/questions')).body[0];
  assert.equal((await client.request(`/api/questions/${question.id}`, 'POST', { answer: 'Finish with the original provider' })).status, 200);
  const oldRun = await waitFor(client, session.id, 'completed');
  assert.equal(oldRun.run.model, local.model);
  assert.equal(globalNative.requests.length, 0);
  assert.ok(localNative.requests.length >= 2);
  assert.ok(localNative.requests.every(request => request.body.model === local.model));
  const oldRequestCount = localNative.requests.length;
  assert.equal((await client.request(`/api/sessions/${session.id}/run`, 'POST', { prompt: '[test:question]' })).status, 202);
  await waitFor(client, session.id, 'waiting_input');
  const nextQuestion = (await client.request('/api/questions')).body[0];
  assert.equal((await client.request(`/api/questions/${nextQuestion.id}`, 'POST', { answer: 'Use the global source for this new task' })).status, 200);
  const nextRun = await waitFor(client, session.id, 'completed');
  assert.equal(nextRun.run.model, global.model);
  assert.equal(localNative.requests.length, oldRequestCount);
  assert.ok(globalNative.requests.length >= 2);
  assert.ok(globalNative.requests.every(request => request.body.model === global.model));
});

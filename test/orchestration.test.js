import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHarness } from '../src/core/harness.js';
import { complete } from '../src/core/providers.js';
import { validateSettings } from '../src/core/settings.js';
import { defaultOrchestration, validateOrchestration } from '../src/core/orchestration-config.js';
import { startModelServer } from './fixtures/model-server.js';
import { wav, upload } from './fixtures/attachments.js';

const reply = (content, toolCalls = []) => ({ content, toolCalls, usage: { inputTokens: 3, outputTokens: 2 }, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
const choice = (model = 'm0', tool = 'none', direction = 'continue', confidence = 0.95) => ({ answers: Object.fromEntries(Object.entries({ model, tool, direction }).map(([key, value]) => [key, { type: 'choice', choice: value, confidence }])) });
const ref = (providerId, modelId, scope = 'workspace') => ({ scope, providerId, modelId });
const candidate = (providerId, modelId, specialty = '', scope = 'workspace') => ({ ...ref(providerId, modelId, scope), specialty });

async function fixture(context, completion = async () => reply('完成')) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qinghe-orchestration-'));
  const options = { workspace: path.join(directory, 'workspace'), globalConfigDir: path.join(directory, 'global'), completion };
  const harness = await createHarness(options);
  const catalog = await harness.createProvider({ name: 'Main', protocol: 'responses', apiKey: 'orchestration-fixture-secret', models: [{ id: 'general' }, { id: 'coder' }, { id: 'writer' }, { id: 'cheap', maxContextTokens: 5000, maxTokens: 512 }, { id: 'decider', maxTokens: 1024 }] });
  const providerId = catalog.providers[0].id;
  await harness.activateModel(providerId, 'general');
  context.after(async () => { await harness.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { harness, providerId, options, directory };
}

async function run(harness, prompt = '检查并完成任务') {
  const session = await harness.createSession();
  await harness.run(session.id, prompt);
  await harness.activeRuns.get(session.id).done;
  return harness.getSession(session.id);
}

test('orchestration validates explicit references, booleans, confidence and bounded candidates', () => {
  assert.deepEqual(validateOrchestration({}), defaultOrchestration);
  for (const value of [{ decision: { enabled: 'yes' } }, { routing: { enabled: true } }, { compressionModel: { providerId: 'p', modelId: 'm' } }, { decision: { minConfidence: 2 } }, { routing: { candidates: [candidate('p', 'm'), candidate('p', 'm')] } }, { routing: { candidates: Array.from({ length: 33 }, (_, i) => candidate('p', `m${i}`)) } }, { decision: null }]) assert.throws(() => validateOrchestration(value));
});

test('disabled orchestration adds no model calls and preserves normal streaming', async context => {
  const calls = [];
  const { harness } = await fixture(context, async (settings, request) => { calls.push(settings.model); request.onDelta('完成'); return reply('完成'); });
  const session = await run(harness);
  assert.equal(session.run.status, 'completed');
  assert.deepEqual(calls, ['general']);
  assert.equal(session.events.some(event => event.type.startsWith('decision.')), false);
  assert.equal(session.events.filter(event => event.type === 'assistant.delta').map(event => event.data.text).join(''), '完成');
});

test('independent compressor uses its credentials/window and usage without replacing the execution model', async context => {
  const calls = [];
  const { harness, providerId, options } = await fixture(context, async (settings, request) => {
    calls.push({ model: settings.model, maxContextTokens: settings.maxContextTokens, maxTokens: settings.maxTokens, tools: request.tools.length });
    return reply(settings.model === 'cheap' ? '用户要求检查项目。尚未执行操作；继续检查并完成任务。' : '完成');
  });
  await harness.updateModel(providerId, 'general', { maxContextTokens: 12000, maxTokens: 512 });
  await harness.updateSettings({ modelOrchestration: { compressionModel: ref(providerId, 'cheap') } });
  const session = await run(harness, '检查项目并完成任务。'.repeat(2200));
  assert.equal(session.run.status, 'completed', session.run.error);
  assert.ok(calls.filter(call => call.model === 'cheap').length > 1);
  assert.ok(calls.filter(call => call.model === 'cheap').every(call => call.maxContextTokens === 5000 && call.maxTokens <= 512 && call.tools === 0));
  assert.equal(calls.at(-1).model, 'general');
  assert.ok(session.context.summary);
  assert.ok(session.messages[0].content.length > 10000);
  assert.equal(session.run.modelUsage.find(item => item.purpose === 'compression').model, 'cheap');
  const stored = JSON.parse(await readFile(path.join(harness.dataDir, 'settings.json'), 'utf8'));
  assert.equal(stored.modelOrchestration, undefined);
  assert.equal(stored.providerCatalog.modelOrchestration.compressionModel.modelId, 'cheap');
  await harness.close();
  const reopened = await createHarness(options);
  try { assert.equal(reopened.getSettings().modelOrchestration.compressionModel.modelId, 'cheap'); } finally { await reopened.close(); }
});

test('decision and routing revisit start, tool results and summary, preserve pairing and track per-model usage', async context => {
  const calls = [];
  const { harness, providerId } = await fixture(context, async (settings, request) => {
    calls.push({ model: settings.model, request });
    if (settings.model === 'decider') return { ...reply(''), ...choice(request.state.phase === 'start' ? 'm0' : request.state.phase === 'progress' ? 'm1' : 'm2', request.state.phase === 'start' ? 'list_files' : 'none', request.state.phase === 'summary' ? 'summarize' : 'inspect') };
    if (settings.model === 'general') return { ...reply('', [{ id: 'list-1', name: 'list_files', args: { path: '.' } }]), providerItems: [{ type: 'reasoning', id: 'opaque-general' }] };
    if (settings.model === 'coder') { assert.ok(request.messages.some(message => message.role === 'tool')); assert.ok(request.messages.every(message => !message.providerItems)); return reply('执行草稿：检查完成'); }
    assert.equal(request.tools.length, 0);
    assert.match(request.system, /检查完成/);
    return reply('最终总结：已完成检查');
  });
  await harness.updateSettings({ modelOrchestration: { decision: { enabled: true, model: ref(providerId, 'decider') }, routing: { enabled: true, candidates: [candidate(providerId, 'general', '分析'), candidate(providerId, 'coder', '代码与验证'), candidate(providerId, 'writer', '最终汇报')] } } });
  const session = await run(harness);
  assert.equal(session.run.status, 'completed', session.run.error);
  assert.deepEqual(calls.map(call => call.model), ['decider', 'general', 'decider', 'coder', 'decider', 'writer']);
  assert.deepEqual(calls.filter(call => call.model === 'decider').map(call => call.request.state.phase), ['start', 'progress', 'summary']);
  assert.match(calls[1].request.system, /优先考虑 list_files/);
  assert.equal(session.messages.at(-1).content, '最终总结：已完成检查');
  assert.equal(session.messages.some(message => message.content === '执行草稿：检查完成'), false);
  assert.equal(session.run.model, 'writer');
  assert.equal(harness.getSettings().model, 'general');
  assert.equal(session.run.usage.inputTokens, 18);
  assert.equal(session.run.usage.outputTokens, 12);
  assert.equal(session.run.modelUsage.find(item => item.purpose === 'decision').requests, 3);
  assert.equal(session.messages[1].providerItems[0].id, 'opaque-general');
  assert.equal(session.messages[2].toolCallId, 'list-1');
});

test('invalid, low-confidence and failed decisions fall back without invoking any suggested tool', async context => {
  for (const mode of ['invalid', 'low', 'error']) {
    const { harness, providerId } = await fixture(context, async (settings) => {
      if (settings.model !== 'decider') return reply('安全继续');
      if (mode === 'error') throw new Error('gateway unavailable');
      return { ...reply(''), ...choice(mode === 'invalid' ? 'not-in-catalog' : 'm0', 'none', 'continue', mode === 'low' ? 0.1 : 0.9) };
    });
    await harness.updateSettings({ modelOrchestration: { decision: { model: ref(providerId, 'decider') }, routing: { enabled: true, candidates: [candidate(providerId, 'coder')] } } });
    const session = await run(harness);
    assert.equal(session.run.status, 'completed', session.run.error);
    assert.equal(session.run.model, 'general');
    assert.equal(session.messages.at(-1).content, '安全继续');
    assert.equal(session.events.some(event => event.type === 'tool.started'), false);
    assert.ok(session.events.some(event => event.type === (mode === 'low' ? 'decision.completed' : 'decision.fallback')));
  }
});

test('summary failure preserves the original successful answer', async context => {
  const { harness, providerId } = await fixture(context, async (settings, request) => {
    if (settings.model === 'decider') return { ...reply(''), ...choice(request.state.phase === 'summary' ? 'm1' : 'm0') };
    if (settings.model === 'writer') throw new Error('summary unavailable');
    return reply('原始成果');
  });
  await harness.updateSettings({ modelOrchestration: { decision: { model: ref(providerId, 'decider') }, routing: { enabled: true, candidates: [candidate(providerId, 'general'), candidate(providerId, 'writer')] } } });
  const session = await run(harness);
  assert.equal(session.run.status, 'completed', session.run.error);
  assert.equal(session.messages.at(-1).content, '原始成果');
  assert.equal(session.run.model, 'general');
  assert.ok(session.events.some(event => event.type === 'decision.fallback' && event.data.phase === 'summary'));
});

test('decision guidance never bypasses readonly policy or calls tools itself', async context => {
  let invoked = false;
  const { harness, providerId } = await fixture(context, async (settings, request) => {
    if (settings.model === 'decider') return { ...reply(''), ...choice('m0', 'none', 'implement') };
    if (request.messages.some(message => message.role === 'tool')) return reply('写入被策略拒绝');
    return reply('', [{ id: 'write-1', name: 'write_file', args: { path: 'no.txt', content: 'no' } }]);
  });
  harness.registerTool({ name: 'forbidden', description: 'must not execute', parameters: { type: 'object', properties: {} }, execute: () => { invoked = true; } });
  await harness.updateSettings({ approval: 'readonly', modelOrchestration: { decision: { enabled: true, model: ref(providerId, 'decider') } } });
  const session = await run(harness);
  assert.equal(session.run.status, 'completed', session.run.error);
  assert.equal(invoked, false);
  assert.ok(session.events.some(event => event.type === 'tool.failed' && /只读/.test(event.data.error)));
  await assert.rejects(readFile(path.join(harness.workspace, 'no.txt')), /ENOENT/);
});

test('cancel interrupts pending decision and freezes referenced models and credentials for the run', async context => {
  let reached;
  const pending = new Promise(resolve => { reached = resolve; });
  const { harness, providerId } = await fixture(context, async (settings, request) => {
    reached();
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  });
  await harness.updateSettings({ modelOrchestration: { decision: { enabled: true, model: ref(providerId, 'decider') } } });
  const session = await harness.createSession();
  await harness.run(session.id, '等待决策');
  await pending;
  await assert.rejects(harness.deleteModel(providerId, 'decider'), /正在使用/);
  await harness.cancelRun(session.id);
  assert.equal(harness.getSession(session.id).run.status, 'cancelled');
  await harness.deleteModel(providerId, 'decider');
  const before = harness.getSession(session.id).messages.length;
  await assert.rejects(harness.run(session.id, '失效配置'), /模型不存在/);
  assert.equal(harness.getSession(session.id).messages.length, before);
  assert.equal(harness.catalog.reservations.size, 0);
});

test('global auxiliary leases protect all selected models across workspaces and never persist global secrets locally', async context => {
  const { harness, directory, options } = await fixture(context);
  const global = await harness.createProvider({ name: 'Shared', protocol: 'systemone', apiKey: 'private-global-decision-key', models: [{ id: 'jev-latest' }] }, 'global');
  const providerId = global.providers[0].id;
  await harness.updateSettings({ modelOrchestration: { decision: { enabled: true, model: ref(providerId, 'jev-latest', 'global') } } });
  const reservation = await harness.catalog.reserveRun('lease-test');
  const peer = await createHarness({ workspace: path.join(directory, 'peer'), globalConfigDir: options.globalConfigDir });
  try {
    await assert.rejects(peer.deleteProvider(providerId, 'global'), /正在使用/);
    assert.equal(reservation.orchestration.decision.settings.apiKey, 'private-global-decision-key');
    assert.equal((await readFile(path.join(harness.dataDir, 'settings.json'), 'utf8')).includes('private-global-decision-key'), false);
    await reservation.release();
    await peer.deleteProvider(providerId, 'global');
  } finally { await peer.close(); await reservation.release(); }
});

test('System One authenticates its native endpoint, discovers models and cannot be used for chat or compression', async context => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: request.url, key: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.method === 'GET' ? { models: [{ name: 'jev-latest', description: 'typed decisions' }] } : { answers: Object.fromEntries(Object.entries(body.questions).map(([name, q]) => [name, { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.9 }])), usage: { input_tokens: 7, output_tokens: 0 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const { harness, providerId } = await fixture(context);
  const catalog = await harness.createProvider({ name: 'Jev', protocol: 'systemone', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'jev-private-test-key', models: [{ id: 'jev-latest' }] });
  const jev = catalog.providers.find(profile => profile.name === 'Jev');
  assert.equal((await harness.testProviderConnection(jev.id, { modelId: 'jev-latest' })).ok, true);
  assert.equal((await harness.discoverProviderModels(jev.id)).models[0].id, 'jev-latest');
  await assert.rejects(harness.activateModel(jev.id, 'jev-latest'), /决策模型/);
  await assert.rejects(harness.updateSettings({ modelOrchestration: { compressionModel: ref(jev.id, 'jev-latest') } }), /决策模型/);
  await harness.updateSettings({ modelOrchestration: { decision: { enabled: true, model: ref(jev.id, 'jev-latest') } } });
  harness.completion = (settings, request) => settings.provider === 'systemone' ? complete(settings, request) : reply('原生 Jev 决策完成');
  const session = await run(harness);
  assert.equal(session.run.status, 'completed', session.run.error);
  assert.equal(session.run.modelUsage.find(item => item.purpose === 'decision').inputTokens, 7);
  assert.ok(requests.filter(item => item.path === '/v1/systemone').every(item => item.key === 'Bearer jev-private-test-key' && item.body.model === 'jev-latest' && item.body.questions && !item.body.messages));
  assert.equal(harness.getSettings().activeProviderId, providerId);
  assert.equal(JSON.stringify(session).includes('jev-private-test-key'), false);
  await assert.rejects(complete(validateSettings({ provider: 'systemone', model: 'jev-latest', apiKey: 'unused' }), { signal: new AbortController().signal }), /不能作为聊天/);
});

test('native Jev routes one task across Responses, Chat and Messages without changing the default', async context => {
  const model = await startModelServer();
  context.after(() => model.close());
  const { harness } = await fixture(context, complete);
  const references = [];
  for (const [protocol, id] of [['responses', 'route-reader'], ['openai', 'route-coder'], ['anthropic', 'route-writer'], ['systemone', 'jev-latest']]) {
    const catalog = await harness.createProvider({ name: protocol, protocol, baseUrl: model.url, apiKey: 'test-key', models: [{ id }] });
    references.push(ref(catalog.providers.at(-1).id, id));
  }
  await harness.activateModel(references[0].providerId, references[0].modelId);
  await harness.updateSettings({ modelOrchestration: { decision: { model: references[3] }, routing: { enabled: true, candidates: references.slice(0, 3).map((value, index) => ({ ...value, specialty: ['检查', '执行', '总结'][index] })) } } });
  const session = await run(harness);
  assert.equal(session.run.status, 'completed', session.run.error);
  assert.deepEqual(model.requests.map(request => request.path), ['/v1/systemone', '/v1/responses', '/v1/systemone', '/v1/chat/completions', '/v1/systemone', '/v1/messages']);
  const chat = model.requests.find(request => request.path === '/v1/chat/completions').body;
  assert.ok(chat.messages.some(message => message.role === 'tool' && message.tool_call_id === 'route-list'));
  const summary = model.requests.find(request => request.path === '/v1/messages').body;
  assert.ok(!summary.tools?.length);
  assert.match(session.messages.at(-1).content, /智能路由验证完成/);
  assert.equal(harness.getSettings().model, 'route-reader');
});

test('routing filters incompatible audio protocols and decision state contains metadata without binary media', async context => {
  const { harness, providerId } = await fixture(context, async (settings, request) => {
    if (settings.model === 'decider') {
      assert.equal(Object.keys(request.questions.model.criteria).length, 1);
      assert.match(request.questions.model.criteria.m0, /audio-model/);
      assert.equal(JSON.stringify(request.state).includes(wav.toString('base64')), false);
      return { ...reply(''), ...choice() };
    }
    assert.equal(settings.provider, 'openai');
    assert.ok(request.messages.some(message => message.media?.[0].kind === 'audio'));
    return reply('音频已分析');
  });
  const catalog = await harness.createProvider({ name: 'Audio', protocol: 'openai', apiKey: 'audio-fixture-key', models: [{ id: 'audio-model' }] });
  const audioProvider = catalog.providers.at(-1).id;
  await harness.activateModel(audioProvider, 'audio-model');
  await harness.updateSettings({ modelOrchestration: { decision: { model: ref(providerId, 'decider') }, routing: { enabled: true, candidates: [candidate(providerId, 'general'), candidate(audioProvider, 'audio-model')] } } });
  const file = await harness.importAttachment(upload('audio.wav', wav));
  const session = await harness.createSession();
  await harness.run(session.id, '分析音频', { attachments: [file.id] });
  await harness.activeRuns.get(session.id).done;
  assert.equal(harness.getSession(session.id).run.status, 'completed');
});

test('decision timeout falls back promptly and configuration changes do not alter an active run snapshot', async context => {
  const { harness, providerId } = await fixture(context, async (settings, request) => {
    if (settings.model !== 'decider') return reply('超时后继续');
    await harness.updateSettings({ modelOrchestration: defaultOrchestration });
    await harness.updateProvider(providerId, { apiKey: 'replacement-key' });
    assert.equal(settings.apiKey, 'orchestration-fixture-secret');
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  });
  await harness.updateSettings({ providerTimeoutMs: 100, modelOrchestration: { decision: { enabled: true, model: ref(providerId, 'decider') } } });
  const session = await run(harness);
  assert.equal(session.run.status, 'completed', session.run.error);
  assert.ok(session.events.some(event => event.type === 'decision.fallback'));
  assert.equal(session.messages.at(-1).content, '超时后继续');
  assert.equal(harness.getSettings().modelOrchestration.decision.enabled, false);
});

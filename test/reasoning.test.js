import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../src/core/harness.js';
import { validateSettings } from '../src/core/settings.js';
import { anthropicEfforts, openaiEfforts, reasoningParameters, validateReasoning } from '../src/core/reasoning.js';
import { startModelServer } from './fixtures/model-server.js';

async function fixture(context, settings = {}, completion) {
  const temporaryRoot = await realpath(os.tmpdir());
  const workspace = await mkdtemp(path.join(temporaryRoot, 'harness-reasoning-'));
  let harness = await createHarness({ workspace, ...(completion ? { completion } : {}) });
  await harness.updateSettings({ provider: 'responses', model: 'custom-model-alias', apiKey: 'test-key', approval: 'auto', ...settings });
  context.after(async () => {
    await harness.close();
    if (path.dirname(workspace) !== temporaryRoot || !path.basename(workspace).startsWith('harness-reasoning-')) throw new Error('Unexpected cleanup path');
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  });
  return { harness, workspace, restart: async () => { await harness.close(); harness = await createHarness({ workspace }); return harness; } };
}

async function run(harness, id, prompt = '检查当前工作区') {
  await harness.run(id, prompt);
  await harness.activeRuns.get(id)?.done;
  const session = harness.getSession(id);
  assert.equal(session.run.status, 'completed', session.run.error);
  return session;
}

async function modelServer(context) {
  const model = await startModelServer();
  context.after(() => model.close());
  return model;
}

test('reasoning validation is strict and the legacy default sends no new parameters', () => {
  assert.deepEqual(validateSettings({}).reasoning, { mode: 'default' });
  for (const provider of ['responses', 'openai', 'anthropic']) assert.deepEqual(reasoningParameters(validateSettings({ provider })), {});
  assert.ok(openaiEfforts.includes('max'));
  assert.deepEqual(validateReasoning({ mode: 'effort', effort: 'max' }), { mode: 'effort', effort: 'max' });
  for (const reasoning of [null, [], {}, { mode: ['effort'], effort: 'high' }, { mode: 'unknown' }, { mode: 'default', effort: 'high' }, { mode: 'effort', effort: 'invalid' }, { mode: 'adaptive', effort: 'xhigh' }, { mode: 'budget', budgetTokens: 1023 }, { mode: 'budget', budgetTokens: 131072 }, { mode: 'budget', budgetTokens: 2048.5 }, { mode: 'budget', budgetTokens: '2048' }]) assert.throws(() => validateReasoning(reasoning));
  for (const provider of ['responses', 'openai']) assert.throws(() => reasoningParameters(validateSettings({ provider, reasoning: { mode: 'adaptive' } })), /不兼容/);
  assert.throws(() => reasoningParameters(validateSettings({ provider: 'anthropic', reasoning: { mode: 'effort', effort: 'high' } })), /不兼容/);
});

test('Responses and Chat send all explicit effort values natively and omit temperature for model aliases', async context => {
  const remote = await modelServer(context);
  const { harness } = await fixture(context, { baseUrl: remote.url });
  for (const provider of ['responses', 'openai']) {
    for (const effort of openaiEfforts) {
      await harness.updateSettings({ provider, model: 'custom-reasoning-alias', apiKey: 'test-key', reasoning: { mode: 'effort', effort } });
      const count = remote.requests.length;
      const completed = await run(harness, (await harness.createSession()).id);
      assert.deepEqual(completed.run.reasoning, { mode: 'effort', effort });
      for (const { body } of remote.requests.slice(count)) {
        assert.equal(body.temperature, undefined);
        assert.equal(body.thinking, undefined);
        assert.equal(body.output_config, undefined);
        if (provider === 'responses') {
          assert.deepEqual(body.reasoning, { effort });
          assert.equal(body.reasoning_effort, undefined);
          assert.ok(body.max_output_tokens > 0);
        } else {
          assert.equal(body.reasoning_effort, effort);
          assert.equal(body.reasoning, undefined);
          assert.equal(body.max_tokens, undefined);
          assert.ok(body.max_completion_tokens > 0);
        }
      }
    }
    await harness.updateSettings({ reasoning: { mode: 'default' } });
    await harness.testConnection();
    assert.equal(remote.requests.at(-1).body.reasoning, undefined);
    assert.equal(remote.requests.at(-1).body.reasoning_effort, undefined);
    assert.equal(remote.requests.at(-1).body.temperature, 0.2);
  }
});

test('Anthropic adaptive effort, explicit budgets and disabled thinking use distinct native fields', async context => {
  const remote = await modelServer(context);
  const { harness } = await fixture(context, { provider: 'anthropic', baseUrl: remote.url });
  for (const effort of anthropicEfforts) {
    await harness.updateSettings({ reasoning: { mode: 'adaptive', effort } });
    await harness.testConnection();
    const body = remote.requests.at(-1).body;
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.deepEqual(body.output_config, effort === 'default' ? undefined : { effort });
    assert.equal(body.temperature, undefined);
    assert.equal(body.reasoning, undefined);
    assert.equal(body.reasoning_effort, undefined);
  }
  await harness.updateSettings({ reasoning: { mode: 'budget', budgetTokens: 2048 } });
  const before = harness.getSettings();
  await harness.testConnection();
  assert.deepEqual(harness.getSettings(), before);
  assert.deepEqual(remote.requests.at(-1).body.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.ok(remote.requests.at(-1).body.max_tokens > 2048);
  await run(harness, (await harness.createSession()).id);
  assert.equal(remote.requests.at(-1).body.temperature, undefined);
  await harness.updateSettings({ reasoning: { mode: 'disabled' } });
  await harness.testConnection();
  assert.deepEqual(remote.requests.at(-1).body.thinking, { type: 'disabled' });
  assert.equal(remote.requests.at(-1).body.output_config, undefined);
  await harness.updateSettings({ reasoning: { mode: 'default' } });
  await harness.testConnection();
  assert.equal(remote.requests.at(-1).body.thinking, undefined);
});

test('invalid thinking budgets fail locally and legacy task budgets do not limit reasoning', async context => {
  const remote = await modelServer(context);
  const { harness } = await fixture(context, { provider: 'anthropic', baseUrl: remote.url, maxTokens: 1024, reasoning: { mode: 'budget', budgetTokens: 1024 } });
  const session = await harness.createSession();
  assert.equal(harness.getSettings().configured, false);
  await assert.rejects(harness.run(session.id, 'invalid'), /思考预算必须小于/);
  assert.deepEqual(harness.getSession(session.id).messages, []);
  await harness.updateSettings({ maxTokens: 4096, maxRunTokens: 1024 });
  await harness.run(session.id, 'continue without a task budget');
  await harness.activeRuns.get(session.id).done;
  assert.equal(harness.getSession(session.id).run.status, 'completed');
  assert.equal(remote.requests.at(-1).body.thinking.budget_tokens, 1024);
});

test('model reasoning overrides persist independently and running tasks retain their parameter snapshot', async context => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const fixtureState = await fixture(context, {}, async (settings, { onDelta }) => {
    calls.push(structuredClone(settings)); entered(); await gate; onDelta('done');
    return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
  });
  const { harness, workspace } = fixtureState;
  const { providerId, modelId } = harness.getProviderCatalog().active;
  await harness.updateModel(providerId, modelId, { reasoning: { mode: 'effort', effort: 'high' } });
  await harness.addModel(providerId, { id: 'second-model' });
  const source = await harness.createSession();
  await harness.run(source.id, 'snapshot');
  await started;
  try {
    await harness.updateModel(providerId, modelId, { reasoning: { mode: 'effort', effort: 'max' } });
    assert.deepEqual(harness.getSession(source.id).run.reasoning, { mode: 'effort', effort: 'high' });
    assert.equal(calls[0].reasoning.effort, 'high');
    await harness.activateModel(providerId, 'second-model');
    assert.deepEqual(harness.getSettings().reasoning, { mode: 'default' });
    await harness.activateModel(providerId, modelId);
    assert.equal(harness.getSettings().reasoning.effort, 'max');
  } finally { release(); }
  await harness.activeRuns.get(source.id)?.done;
  const reopened = await fixtureState.restart();
  assert.equal(reopened.getSettings().reasoning.effort, 'max');
  assert.equal(reopened.getSession(source.id).run.reasoning.effort, 'high');
  const saved = JSON.parse(await readFile(path.join(workspace, '.harness', 'settings.json'), 'utf8'));
  assert.deepEqual(saved.providerCatalog.modelDefaults.reasoning, { mode: 'default' });
  await reopened.updateModel(providerId, modelId, { reasoning: null });
  assert.deepEqual(reopened.getSettings().reasoning, { mode: 'default' });
});

for (const streaming of [true, false]) test(`Anthropic signed thinking survives ${streaming ? 'SSE' : 'JSON'} tools, branches and restart without entering visible text`, async context => {
  const requests = [];
  const thinking = { type: 'thinking', thinking: 'private thought', signature: 'native-signature' };
  const redacted = { type: 'redacted_thinking', data: 'opaque-redacted-data' };
  const tool = { type: 'tool_use', id: 'thinking-tool', name: 'list_files', input: { path: '.' } };
  const blocks = [thinking, redacted, tool];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    const first = requests.length === 1;
    const content = first ? blocks : [{ type: 'text', text: 'public answer' }];
    if (!streaming) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content, usage: { input_tokens: 2, output_tokens: 5 }, stop_reason: first ? 'tool_use' : 'end_turn' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } });
    for (const [index, block] of content.entries()) {
      send({ type: 'content_block_start', index, content_block: block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : block.type === 'text' ? { type: 'text', text: '' } : block.type === 'tool_use' ? { ...block, input: {} } : block });
      if (block.type === 'thinking') {
        send({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'private ' } });
        send({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'thought' } });
        for (const signature of ['native-', 'signature']) send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } });
      } else if (block.type === 'tool_use') {
        for (const partial_json of ['{"path":', '"."}']) send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
      } else if (block.type === 'text') send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
      send({ type: 'content_block_stop', index });
    }
    send({ type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
    send({ type: 'message_stop' });
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const fixtureState = await fixture(context, { provider: 'anthropic', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: { mode: 'budget', budgetTokens: 1024 } });
  const { harness } = fixtureState;
  const session = await run(harness, (await harness.createSession()).id);
  const anchor = session.messages.find(message => message.role === 'assistant');
  assert.deepEqual(anchor.providerItems, blocks);
  assert.deepEqual(requests[1].messages.find(message => message.role === 'assistant').content, blocks);
  assert.ok(!session.events.filter(event => event.type === 'assistant.delta').some(event => JSON.stringify(event).includes('private thought')));
  assert.ok(!session.messages.some(message => message.content.includes('private thought')));
  const child = await harness.forkSession(session.id, { messageId: anchor.id });
  await run(harness, child.id, 'continue');
  assert.deepEqual(requests.at(-1).messages.find(message => message.role === 'assistant').content, blocks);
  const reopened = await fixtureState.restart();
  await run(reopened, child.id, 'restart');
  assert.deepEqual(requests.at(-1).messages.find(message => message.role === 'assistant').content, blocks);
});

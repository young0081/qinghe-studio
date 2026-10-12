import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from '../src/core/harness.js';
import { compactContext, contextMessages, estimateTokens } from '../src/core/context.js';

const response = (content, toolCalls = [], usage = { inputTokens: 1, outputTokens: 1 }) => ({ content, toolCalls, usage, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
const operation = ordinal => ({ id: `operation-${ordinal}`, name: 'record_step', args: { ordinal } });

async function fixture(context, completion, settings = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'harness-context-'));
  const harness = await createHarness({ workspace, completion, settings: { model: 'fixture-model', apiKey: 'fixture-context-key', approval: 'auto', ...settings } });
  await harness.updateSettings({ model: 'fixture-model', apiKey: 'fixture-context-key', approval: 'auto', ...settings });
  context.after(async () => { await harness.close(); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { harness, workspace };
}

async function run(harness, sessionId, prompt = '完成任务，保留 src/result.js 中的既有修改') {
  await harness.run(sessionId, prompt);
  await harness.activeRuns.get(sessionId).done;
  return harness.getSession(sessionId);
}

function registerRecorder(harness, execute, options = {}) {
  harness.registerTool({ name: 'record_step', description: '记录已经完成的步骤', parameters: { type: 'object', properties: { ordinal: { type: 'integer' } }, required: ['ordinal'] }, requiresApproval: false, execute, ...options });
}

function assertPaired(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role !== 'tool') assert.equal(pending.size, 0, 'tool results must remain adjacent to their assistant call');
    for (const call of message.toolCalls || []) pending.add(call.id);
    if (message.role === 'tool') assert.equal(pending.delete(message.toolCallId), true, 'orphaned tool result');
  }
  assert.equal(pending.size, 0);
}

test('runs continue beyond legacy step and total token caps and can still be cancelled', async context => {
  let step = 0;
  const { harness } = await fixture(context, async () => {
    step++;
    return response(step > 25 ? '完成' : '', step > 25 ? [] : [operation(step)], { inputTokens: 5000, outputTokens: 500 });
  }, { maxSteps: 1, maxRunTokens: 5, maxContextTokens: 2000000 });
  let executions = 0;
  registerRecorder(harness, () => { executions++; return { done: executions }; });
  const completed = await run(harness, (await harness.createSession()).id);
  assert.equal(completed.run.status, 'completed', completed.run.error);
  assert.equal(completed.run.steps, 26);
  assert.equal(executions, 25);
  assert.ok(completed.run.usage.inputTokens + completed.run.usage.outputTokens > 100000);
  assert.equal(harness.getSettings().maxSteps, undefined);
  assert.equal(harness.getSettings().maxRunTokens, undefined);
  harness.completion = async () => response('', [operation(++step)]);
  const session = await harness.createSession();
  harness.on('event', event => { if (event.sessionId === session.id && event.type === 'tool.completed' && event.data.result.done >= 50) void harness.cancelRun(session.id); });
  const cancelled = await run(harness, session.id);
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(harness.activeRuns.size, 0);
});

test('switching to auto releases pending approvals and ignores legacy alwaysApproval tools', async context => {
  let step = 0;
  const { harness } = await fixture(context, async () => response(step++ < 2 ? '' : '完成', step <= 2 ? [operation(step)] : []), { approval: 'ask' });
  const executed = [];
  registerRecorder(harness, args => { executed.push(args.ordinal); return { ok: true }; }, { requiresApproval: true, alwaysApproval: true });
  const session = await harness.createSession();
  let pending;
  const waiting = new Promise(resolve => { pending = resolve; });
  harness.on('event', event => { if (event.type === 'approval.required') pending(event); });
  await harness.run(session.id, '执行两个步骤');
  const approval = await waiting;
  const done = harness.activeRuns.get(session.id).done;
  await harness.updateSettings({ approval: 'auto' });
  await done;
  const saved = harness.getSession(session.id);
  assert.equal(saved.run.status, 'completed', saved.run.error);
  assert.deepEqual(executed, [1, 2]);
  assert.equal(saved.events.filter(event => event.type === 'approval.required').length, 1);
  assert.ok(saved.events.some(event => event.type === 'approval.resolved' && event.data.id === approval.data.id && event.data.status === 'approved'));
  assert.equal(harness.approvals.size, 0);
});

test('long tool loops repeatedly compact, preserve pairs and resume from persisted summaries', async context => {
  let step = 0;
  let summaries = 0;
  let resumed = 0;
  const executed = [];
  const completion = async (settings, request) => {
    assert.ok(estimateTokens(request.system) + estimateTokens(request.messages) + estimateTokens(request.tools) + settings.maxTokens < settings.maxContextTokens);
    if (!request.tools.length) {
      summaries++;
      assert.match(request.system, /当前计划/);
      assert.match(request.system + request.messages[0].content, /src\/result.js/);
      return response('目标：完成任务，保留 src/result.js。已完成步骤按最近记录推进；接下来继续验证，禁止重复修改。');
    }
    assertPaired(request.messages);
    if (request.messages.some(message => message.content.includes('会话已自动压缩'))) resumed++;
    step++;
    return response(step > 24 ? '完成所有验证' : '', step > 24 ? [] : [operation(step)]);
  };
  const { harness, workspace } = await fixture(context, completion, { maxContextTokens: 9000, maxTokens: 512, contextCompactionThreshold: 0.6 });
  registerRecorder(harness, args => { executed.push(args.ordinal); return { ordinal: args.ordinal, path: 'src/result.js', result: '验证结果'.repeat(700) }; });
  const session = await harness.createSession();
  harness.session(session.id).plan = [{ step: '保留 src/result.js 并完成验证', status: 'in_progress' }];
  const completed = await run(harness, session.id);
  assert.equal(completed.run.status, 'completed', completed.run.error);
  assert.ok(completed.run.compactions >= 3);
  assert.ok(summaries >= completed.run.compactions);
  assert.ok(resumed >= completed.run.compactions);
  assert.deepEqual(executed, Array.from({ length: 24 }, (_, index) => index + 1));
  assert.equal(completed.messages.filter(message => message.role === 'tool').length, 24);
  assertPaired(completed.messages);
  const persisted = JSON.parse(await readFile(path.join(workspace, '.harness', 'sessions', `${session.id}.json`), 'utf8'));
  assert.deepEqual(persisted.context, completed.context);
  await harness.close();
  let resumedRequest;
  const reopened = await createHarness({ workspace, completion: async (_settings, request) => { resumedRequest = request; return response('重启后继续完成'); } });
  context.after(() => reopened.close());
  const next = await run(reopened, session.id, '继续检查');
  assert.equal(next.run.status, 'completed', next.run.error);
  assert.ok(resumedRequest.messages.some(message => message.content.includes(completed.context.summary)));
  const boundary = completed.messages.findIndex(message => message.id === completed.context.throughMessageId);
  assert.ok(completed.messages.slice(0, boundary + 1).every(message => !resumedRequest.messages.some(item => item.id === message.id)));
  await reopened.close();
});

test('provider context overflow triggers compaction and retries automatically', async context => {
  let attempts = 0;
  const { harness } = await fixture(context, async (_settings, request) => {
    if (!request.tools.length) return response('目标是继续任务。已读历史，下一步检查文件。');
    if (++attempts === 1) throw new Error('模型 API HTTP 400: context_length_exceeded');
    assert.ok(request.messages.some(message => message.content.includes('会话已自动压缩')));
    return response('压缩后完成');
  });
  const session = await harness.createSession();
  harness.addMessage(harness.session(session.id), { role: 'user', content: '较早任务的详细记录。'.repeat(250) });
  const completed = await run(harness, session.id);
  assert.equal(completed.run.status, 'completed', completed.run.error);
  assert.equal(attempts, 2);
  assert.equal(completed.events.filter(event => event.type === 'context.retry').length, 1);
});

test('single-response output limits automatically continue without repeating tools', async context => {
  let calls = 0;
  const { harness } = await fixture(context, async (_settings, request) => {
    calls++;
    if (calls === 1) return { ...response('答案的前半部分'), finishReason: 'length' };
    assert.match(request.messages.find(message => message.continuation).content, /单次输出上限/);
    assert.equal(request.messages.at(-1).role, 'user');
    return response('答案的后半部分');
  });
  const completed = await run(harness, (await harness.createSession()).id);
  assert.equal(completed.run.status, 'completed', completed.run.error);
  assert.equal(calls, 2);
  assert.deepEqual(completed.messages.filter(message => message.role === 'assistant').map(message => message.content), ['答案的前半部分', '答案的后半部分']);
});

test('failed and cancelled summaries retain original history and never execute summary tool calls', async context => {
  const { harness } = await fixture(context, async () => response('invalid summary', [operation(1)]), { maxContextTokens: 9000, maxTokens: 512 });
  let executions = 0;
  registerRecorder(harness, () => { executions++; });
  const session = await harness.createSession();
  const original = '不可丢失的任务信息。'.repeat(5000);
  const failed = await run(harness, session.id, original);
  assert.equal(failed.run.status, 'failed');
  assert.match(failed.run.error, /摘要生成不完整/);
  assert.equal(failed.context, undefined);
  assert.equal(failed.messages[0].content, original);
  assert.equal(executions, 0);
  let entered;
  const summarizing = new Promise(resolve => { entered = resolve; });
  harness.completion = async (_settings, { signal, tools }) => {
    assert.equal(tools.length, 0);
    entered();
    return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  };
  await harness.run(session.id, '继续');
  await summarizing;
  await harness.cancelRun(session.id);
  const cancelled = harness.getSession(session.id);
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.context, undefined);
  assert.equal(cancelled.messages[0].content, original);
});

test('compaction retains the active task attachment references through the durable cursor', async () => {
  const session = { plan: [], messages: [{ id: 'user-image', role: 'user', content: '查看附图', attachments: [{ id: 'image-id', kind: 'image', name: 'screenshot.png' }] }, { id: 'assistant-work', role: 'assistant', content: '步骤结果。'.repeat(2500) }] };
  const compacted = await compactContext({ session, messages: session.messages, settings: { maxTokens: 512, maxContextTokens: 16000 }, limit: 2500, signal: new AbortController().signal, completion: async () => response('用户要查看附件 image-id，继续观察图片。'), onUsage: () => {} });
  session.context = compacted.context;
  const resumed = contextMessages(session);
  assert.deepEqual(resumed.find(message => message.id === 'user-image').attachments, session.messages[0].attachments);
  assert.equal(resumed.some(message => message.id === 'assistant-work'), false);
});

test('model context windows override workspace defaults and survive restart', async context => {
  const { harness, workspace } = await fixture(context, async () => response('完成'));
  const { providerId, modelId } = harness.getProviderCatalog().active;
  await harness.updateModel(providerId, modelId, { maxContextTokens: 200000 });
  assert.equal(harness.getSettings().maxContextTokens, 200000);
  await harness.addModel(providerId, { id: 'small-model', maxContextTokens: 64000 });
  await harness.activateModel(providerId, 'small-model');
  assert.equal(harness.getSettings().maxContextTokens, 64000);
  await harness.close();
  const reopened = await createHarness({ workspace });
  context.after(() => reopened.close());
  assert.equal(reopened.getSettings().maxContextTokens, 64000);
  await reopened.activateModel(providerId, modelId);
  assert.equal(reopened.getSettings().maxContextTokens, 200000);
  await reopened.close();
});

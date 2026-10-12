import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../src/core/harness.js';
import { startServer } from '../src/server.js';
import { startModelServer } from './fixtures/model-server.js';
import { testCompletion } from './fixtures/completion.js';

async function fixture(context, options = {}) {
  const temporaryRoot = await realpath(os.tmpdir());
  const workspace = await mkdtemp(path.join(temporaryRoot, 'harness-branch-test-'));
  await writeFile(path.join(workspace, 'README.md'), '# Branch test\n');
  const configuration = { workspace, completion: testCompletion, settings: { provider: 'responses', model: 'test-model', apiKey: 'test-key', approval: 'auto' }, ...options };
  let harness = await createHarness(configuration);
  context.after(async () => {
    await harness.close();
    if (path.dirname(workspace) !== temporaryRoot || !path.basename(workspace).startsWith('harness-branch-test-')) throw new Error('Unexpected temporary workspace');
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { workspace, harness, restart: async () => { await harness.close(); harness = await createHarness(configuration); return harness; } };
}

async function run(harness, id, prompt) {
  await harness.run(id, prompt);
  await harness.activeRuns.get(id).done;
  assert.equal(harness.getSession(id).run.status, 'completed');
  return harness.getSession(id);
}

const simpleCompletion = async (_settings, { messages }) => ({ content: `Reply: ${messages.findLast(message => message.role === 'user').content}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' });

test('fork snapshots only the selected prefix, persists lineage and survives deletion of ancestors', async context => {
  const fixtureState = await fixture(context, { completion: simpleCompletion });
  const { harness, workspace } = fixtureState;
  const source = await harness.createSession({ title: '原始对话' });
  const first = await run(harness, source.id, 'first turn');
  const before = await run(harness, source.id, 'later turn must not be copied');
  const branch = await harness.forkSession(source.id, { messageId: first.messages[1].id });
  assert.deepEqual(branch.messages.map(message => message.content), first.messages.map(message => message.content));
  assert.ok(branch.messages.every(message => !before.messages.some(original => original.id === message.id)));
  assert.deepEqual(branch.branch, { parentSessionId: source.id, rootSessionId: source.id, parentTitle: '原始对话', messageId: first.messages[1].id, mode: 'continue', inheritedMessageCount: 2, ordinal: 1 });
  assert.equal(branch.run, null);
  assert.deepEqual(branch.plan, []);
  assert.deepEqual(branch.checkpoints, []);
  assert.deepEqual(branch.events.map(event => event.type), ['session.created']);
  assert.deepEqual(harness.getSession(source.id), before);
  const child = await harness.forkSession(branch.id, { messageId: branch.messages[0].id, title: '嵌套分支' });
  assert.equal(child.branch.parentSessionId, branch.id);
  assert.equal(child.branch.rootSessionId, source.id);
  assert.equal(child.title, '嵌套分支');
  assert.equal(child.messages.length, 1);
  const persisted = JSON.parse(await readFile(path.join(workspace, '.harness', 'sessions', `${child.id}.json`), 'utf8'));
  assert.deepEqual(persisted, child);
  await harness.deleteSession(source.id);
  await harness.deleteSession(branch.id);
  const restarted = await fixtureState.restart();
  assert.deepEqual(restarted.getSession(child.id), child);
  await run(restarted, child.id, 'continue independently');
  assert.equal(restarted.listSessions().length, 1);
});

test('retry from user or assistant starts before that user turn and never mutates the source', async context => {
  const received = [];
  const { harness } = await fixture(context, { completion: async (settings, input) => { received.push(structuredClone(input.messages)); return simpleCompletion(settings, input); } });
  const source = await harness.createSession();
  await run(harness, source.id, 'keep this context');
  const before = await run(harness, source.id, 'replace this turn');
  for (const target of [before.messages[2], before.messages[3]]) {
    const branch = await harness.forkSession(source.id, { messageId: target.id, mode: 'retry' });
    assert.deepEqual(branch.messages.map(message => message.content), before.messages.slice(0, 2).map(message => message.content));
    assert.equal(branch.run, null);
    await run(harness, branch.id, 'edited replacement');
    assert.deepEqual(received.at(-1).filter(message => message.role === 'user').map(message => message.content), ['keep this context', 'edited replacement']);
    assert.deepEqual(harness.getSession(source.id), before);
  }
  const empty = await harness.forkSession(source.id, { messageId: before.messages[0].id, mode: 'retry' });
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.branch.inheritedMessageCount, 0);
});

test('tool-call branches include paired results without copying approvals, plans or file checkpoints', async context => {
  const { harness, workspace } = await fixture(context);
  const source = await harness.createSession();
  const completed = await run(harness, source.id, '[test:write]');
  assert.ok(completed.checkpoints.length);
  const beforeFile = await readFile(path.join(workspace, 'harness-test.txt'), 'utf8');
  const firstAssistant = completed.messages.find(message => message.role === 'assistant');
  const branch = await harness.forkSession(source.id, { messageId: firstAssistant.id });
  assert.deepEqual(branch.messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool']);
  assert.deepEqual(branch.messages[1].toolCalls, firstAssistant.toolCalls);
  assert.deepEqual(branch.messages.filter(message => message.role === 'tool').map(message => message.toolCallId), firstAssistant.toolCalls.map(call => call.id));
  assert.deepEqual(branch.messages[1].providerContext, firstAssistant.providerContext);
  assert.deepEqual(branch.checkpoints, []);
  assert.deepEqual(branch.plan, []);
  assert.equal(branch.run, null);
  assert.ok(branch.events.every(event => !event.runId && !event.type.startsWith('approval.')));
  assert.equal(await readFile(path.join(workspace, 'harness-test.txt'), 'utf8'), beforeFile);
  await assert.rejects(harness.restoreCheckpoint(branch.id, completed.checkpoints[0].id), /不存在/);
});

test('running source sessions and incomplete tool histories cannot be forked', async context => {
  const { harness } = await fixture(context);
  await harness.updateSettings({ approval: 'ask' });
  const source = await harness.createSession();
  const waiting = new Promise(resolve => { harness.on('event', event => { if (event.type === 'approval.required') resolve(); }); });
  await harness.run(source.id, '[test:write]');
  await waiting;
  const messageId = harness.getSession(source.id).messages[0].id;
  await assert.rejects(harness.forkSession(source.id, { messageId }), { statusCode: 409 });
  assert.equal(harness.listSessions().length, 1);
  await harness.cancelRun(source.id);
  const retry = await harness.forkSession(source.id, { messageId, mode: 'retry' });
  assert.equal(retry.messages.length, 0);
  const broken = await harness.createSession();
  harness.addMessage(harness.session(broken.id), { role: 'user', content: 'unfinished' });
  const call = harness.addMessage(harness.session(broken.id), { role: 'assistant', content: 'pending tool', toolCalls: [{ id: 'unfinished-call', name: 'read_file', args: { path: 'README.md' } }] });
  await assert.rejects(harness.forkSession(broken.id, { messageId: call.id }), { statusCode: 409 });
});

test('fork validates ownership and parameters, permits unconfigured continuation, and redacts secrets', async context => {
  const { harness, workspace } = await fixture(context);
  await harness.updateSettings({ apiKey: 'private-branch-secret-key', model: '' });
  const source = await harness.createSession({ title: 'private-branch-secret-key title' });
  const message = harness.addMessage(harness.session(source.id), { role: 'user', content: 'Do not leak private-branch-secret-key' });
  const other = await harness.createSession();
  for (const options of [{}, [], null, { messageId: 2 }, { messageId: message.id, mode: 'delete' }, { messageId: message.id, title: '' }, { messageId: message.id, title: 'x'.repeat(201) }, { messageId: message.id, messages: [] }]) await assert.rejects(harness.forkSession(source.id, options), { statusCode: 400 });
  await assert.rejects(harness.forkSession(other.id, { messageId: message.id }), { statusCode: 404 });
  const branch = await harness.forkSession(source.id, { messageId: message.id });
  assert.equal(harness.getSettings().configured, false);
  assert.equal(branch.run, null);
  assert.ok(!JSON.stringify(branch).includes('private-branch-secret-key'));
  assert.ok(!(await readFile(path.join(workspace, '.harness', 'sessions', `${branch.id}.json`), 'utf8')).includes('private-branch-secret-key'));
});

test('concurrent forks persist before publication and failed writes leave no ghost session', async context => {
  const { harness, workspace } = await fixture(context, { completion: simpleCompletion });
  const source = await harness.createSession();
  const history = await run(harness, source.id, 'branch root');
  const writes = [];
  harness.on('event', event => { if (event.type === 'session.created' && event.data.session.branch) writes.push(readFile(path.join(workspace, '.harness', 'sessions', `${event.sessionId}.json`), 'utf8')); });
  const children = await Promise.all(Array.from({ length: 3 }, () => harness.forkSession(source.id, { messageId: history.messages[1].id })));
  await Promise.all(writes);
  assert.equal(new Set(children.map(child => child.id)).size, 3);
  assert.deepEqual(children.map(child => child.branch.ordinal).sort(), [1, 2, 3]);
  await harness.deleteSession(children[0].id);
  const next = await harness.forkSession(source.id, { messageId: history.messages[1].id });
  assert.equal(next.branch.ordinal, 4);
  const before = harness.listSessions();
  const sessionDirectory = path.join(workspace, '.harness', 'sessions');
  const backupDirectory = path.join(workspace, '.harness', 'sessions-backup');
  assert.equal(path.dirname(sessionDirectory), path.join(workspace, '.harness'));
  assert.equal(path.dirname(backupDirectory), path.join(workspace, '.harness'));
  await rename(sessionDirectory, backupDirectory);
  await writeFile(sessionDirectory, 'not a directory');
  try {
    await assert.rejects(harness.forkSession(source.id, { messageId: history.messages[0].id }));
    assert.deepEqual(harness.listSessions(), before);
  } finally {
    await rm(sessionDirectory);
    await rename(backupDirectory, sessionDirectory);
  }
  assert.equal(writes.length, 4);
});

test('HTTP forks retain valid native tool histories for all three protocols', async context => {
  const remote = await startModelServer();
  context.after(() => remote.close());
  const { harness } = await fixture(context, { completion: undefined });
  const server = await startServer({ harness, port: 0 });
  context.after(() => server.close());
  const post = async (pathname, body) => fetch(`${server.url}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const protocol of ['responses', 'openai', 'anthropic']) {
    await harness.updateSettings({ provider: protocol, baseUrl: remote.url, model: 'test-model', apiKey: 'test-key', approval: 'auto' });
    const source = await harness.createSession();
    const history = await run(harness, source.id, 'native original');
    const anchor = history.messages.find(message => message.role === 'assistant' && message.toolCalls?.length);
    const response = await post(`/api/sessions/${source.id}/fork`, { messageId: anchor.id });
    assert.equal(response.status, 201);
    const branch = await response.json();
    assert.equal(branch.branch.parentSessionId, source.id);
    const accepted = await post(`/api/sessions/${branch.id}/run`, { prompt: 'native branch continuation' });
    assert.equal(accepted.status, 202);
    const active = harness.activeRuns.get(branch.id);
    if (active) await active.done;
    assert.equal(harness.getSession(branch.id).run.status, 'completed');
    assert.deepEqual(harness.getSession(source.id), history);
    assert.equal((await post(`/api/sessions/${source.id}/fork`, { messageId: anchor.id, mode: 'unknown' })).status, 400);
    assert.equal((await post(`/api/sessions/${branch.id}/fork`, { messageId: anchor.id })).status, 404);
  }
  assert.ok(remote.requests.some(request => request.path === '/v1/responses'));
  assert.ok(remote.requests.some(request => request.path === '/v1/chat/completions'));
  assert.ok(remote.requests.some(request => request.path === '/v1/messages'));
});

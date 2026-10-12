import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../src/core/harness.js';
import { executeCommand } from '../src/core/tools.js';
import { testCompletion } from './fixtures/completion.js';

async function fixture(context, settings = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'harness-core-'));
  const harness = await createHarness({ workspace, completion: testCompletion, settings: { provider: 'responses', model: 'test-model', apiKey: 'test-key', ...settings } });
  context.after(async () => { await harness.close(); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { workspace, harness };
}

function eventOnce(harness, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harness.off('event', listener); reject(new Error('事件等待超时')); }, 10000);
    const listener = event => {
      if (predicate(event)) { clearTimeout(timer); harness.off('event', listener); resolve(event); }
    };
    harness.on('event', listener);
  });
}

async function runToEnd(harness, sessionId, prompt) {
  const terminal = eventOnce(harness, event => event.sessionId === sessionId && /^run\.(completed|failed|cancelled)$/.test(event.type));
  await harness.run(sessionId, prompt);
  return terminal;
}

test('formal defaults require explicit model and key before any run history changes', async context => {
  const environmentKeys = ['HARNESS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const environment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  context.after(() => { for (const key of environmentKeys) { if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key]; } });
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'harness-unconfigured-'));
  const harness = await createHarness({ workspace });
  context.after(async () => { await harness.close(); await rm(workspace, { recursive: true, force: true }); });
  assert.equal(harness.getSettings().provider, 'responses');
  assert.equal(harness.getSettings().model, '');
  assert.equal(harness.getSettings().configured, false);
  assert.equal(harness.getSettings().configurationIssues.length, 2);
  const session = await harness.createSession();
  const before = harness.getSession(session.id);
  await assert.rejects(harness.run(session.id, '真实编程任务'), error => error.statusCode === 400 && /模型 ID/.test(error.message));
  assert.deepEqual(harness.getSession(session.id), before);
  await harness.updateSettings({ model: 'explicit-model' });
  await assert.rejects(harness.run(session.id, '真实编程任务'), error => error.statusCode === 400 && /API Key/.test(error.message));
  assert.deepEqual(harness.getSession(session.id), before);
  await harness.updateSettings({ apiKey: 'configured-test-key' });
  assert.equal(harness.getSettings().configured, true);
  assert.deepEqual(harness.getSettings().configurationIssues, []);
  await assert.rejects(harness.updateSettings({ provider: 'demo' }), /不支持/);
  await assert.rejects(createHarness({ workspace, settings: { provider: 'demo' } }), /不支持/);
  await assert.rejects(harness.testConnection({ model: '' }), { statusCode: 400 });
  await assert.rejects(harness.testConnection({ provider: 'demo' }), /不支持/);
});

test('persisted legacy provider migrates once while preserving native configuration and conversation history', async context => {
  const { harness, workspace } = await fixture(context);
  const session = await harness.createSession({ title: '保留的会话' });
  harness.addMessage(harness.session(session.id), { role: 'user', content: '保留这段历史' });
  const before = harness.getSession(session.id);
  await harness.close();
  const settingsPath = path.join(workspace, '.harness', 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ provider: 'demo', model: 'saved-model', apiKey: 'saved-secret-key', approval: 'readonly', maxSteps: 7, baseUrl: 'http://127.0.0.1:9999/v1' }));
  const reopened = await createHarness({ workspace });
  context.after(() => reopened.close());
  assert.equal(reopened.getSettings().provider, 'responses');
  assert.equal(reopened.getSettings().model, 'saved-model');
  assert.equal(reopened.getSettings().approval, 'readonly');
  assert.equal(reopened.getSettings().maxSteps, undefined);
  assert.equal(reopened.getSettings().configured, true);
  assert.deepEqual(reopened.getSession(session.id), before);
  const migrated = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(migrated.provider, 'responses');
  assert.equal(migrated.apiKey, 'saved-secret-key');
  await reopened.close();
});

test('injected completion performs real reads, updates plan, and persists sessions across restart', async context => {
  const { workspace, harness } = await fixture(context);
  await writeFile(path.join(workspace, 'README.md'), 'A real workspace\n');
  const session = await harness.createSession();
  const result = await runToEnd(harness, session.id, '查看项目');
  assert.equal(result.type, 'run.completed');
  const saved = harness.getSession(session.id);
  assert.ok(saved.events.some(event => event.type === 'tool.completed' && event.data.name === 'read_file' && event.data.result.content === 'A real workspace\n'));
  assert.ok(saved.plan.every(item => item.status === 'completed'));
  assert.match(saved.messages.at(-1).content, /测试任务已完成/);
  await harness.close();
  const reopened = await createHarness({ workspace });
  context.after(() => reopened.close());
  assert.deepEqual(reopened.getSession(session.id), saved);
  await reopened.close();
});

test('write waits for approval, creates checkpoint, and restore removes newly created file', async context => {
  const { workspace, harness } = await fixture(context);
  const session = await harness.createSession();
  const pending = eventOnce(harness, event => event.type === 'approval.required');
  const terminal = eventOnce(harness, event => event.type === 'run.completed');
  await harness.run(session.id, '[test:write]');
  const approval = (await pending).data;
  assert.equal(harness.getSession(session.id).run.status, 'waiting_approval');
  await assert.rejects(readFile(path.join(workspace, 'harness-test.txt')), { code: 'ENOENT' });
  await assert.rejects(harness.run(session.id, 'overlap'), { statusCode: 409 });
  await harness.resolveApproval(approval.id, true);
  await terminal;
  assert.match(await readFile(path.join(workspace, 'harness-test.txt'), 'utf8'), /Hello from Harness/);
  const checkpoint = harness.getSession(session.id).checkpoints[0];
  assert.equal(checkpoint.before, null);
  assert.match(checkpoint.diff, /\+Hello from Harness/);
  await harness.restoreCheckpoint(session.id, checkpoint.id);
  await assert.rejects(readFile(path.join(workspace, 'harness-test.txt')), { code: 'ENOENT' });
  assert.equal(harness.getSession(session.id).checkpoints[0].restored, true);
});

test('denied and readonly writes cannot mutate files', async context => {
  const { workspace, harness } = await fixture(context);
  const session = await harness.createSession();
  harness.on('event', event => { if (event.type === 'approval.required') void harness.resolveApproval(event.data.id, false); });
  await runToEnd(harness, session.id, '[test:write]');
  assert.ok(harness.getSession(session.id).events.some(event => event.type === 'tool.failed' && /拒绝/.test(event.data.error)));
  await harness.updateSettings({ approval: 'readonly' });
  await runToEnd(harness, session.id, '[test:write] [test:command]');
  await assert.rejects(readFile(path.join(workspace, 'harness-test.txt')), { code: 'ENOENT' });
  assert.equal(harness.getSession(session.id).checkpoints.length, 0);
});

test('cancel while waiting approval resolves pending state and permits a later run', async context => {
  const { harness } = await fixture(context);
  const session = await harness.createSession();
  const pending = eventOnce(harness, event => event.type === 'approval.required');
  await harness.run(session.id, '[test:write]');
  const approval = (await pending).data;
  await harness.cancelRun(session.id);
  assert.equal(harness.getSession(session.id).run.status, 'cancelled');
  await assert.rejects(harness.resolveApproval(approval.id, true), { statusCode: 404 });
  const answer = await runToEnd(harness, session.id, '继续只读检查');
  assert.equal(answer.type, 'run.completed');
});

test('switching to readonly invalidates already pending write approvals', async context => {
  const { harness, workspace } = await fixture(context);
  const session = await harness.createSession();
  const pending = eventOnce(harness, event => event.type === 'approval.required');
  const terminal = eventOnce(harness, event => event.type === 'run.completed');
  await harness.run(session.id, '[test:write]');
  const approval = (await pending).data;
  await harness.updateSettings({ approval: 'readonly' });
  await assert.rejects(harness.resolveApproval(approval.id, true), { statusCode: 403 });
  await terminal;
  await assert.rejects(readFile(path.join(workspace, 'harness-test.txt')), { code: 'ENOENT' });
  assert.ok(harness.getSession(session.id).events.some(event => event.type === 'approval.resolved' && event.data.status === 'denied'));
});

test('workspace boundaries reject traversal, internal state, symlinks and unsafe paths', async context => {
  const { workspace, harness } = await fixture(context);
  await assert.rejects(harness.readFile('../outside.txt'), /工作区/);
  await assert.rejects(harness.readFile('.harness/settings.json'), /内部/);
  await assert.rejects(harness.readFile('C:\\Windows\\win.ini'), /相对路径/);
  await assert.rejects(harness.readFile('file.txt:secret'), /相对路径/);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'harness-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'private.txt'), 'private');
  await symlink(outside, path.join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(harness.readFile('link/private.txt'), /符号链接/);
  await assert.rejects(harness.files.write('link/new.txt', 'unsafe'), /符号链接/);
  assert.ok(!(await harness.listFiles()).some(file => file.name === '.harness'));
});

test('restoring refuses to overwrite subsequent external edits', async context => {
  const { workspace, harness } = await fixture(context, { approval: 'auto' });
  const session = await harness.createSession();
  await runToEnd(harness, session.id, '[test:write]');
  const checkpoint = harness.getSession(session.id).checkpoints[0];
  await writeFile(path.join(workspace, checkpoint.path), 'manual change');
  await assert.rejects(harness.restoreCheckpoint(session.id, checkpoint.id), { statusCode: 409 });
  assert.equal(await readFile(path.join(workspace, checkpoint.path), 'utf8'), 'manual change');
});

test('literal search and exact editing handle ambiguity, missing text and replaceAll safely', async context => {
  const { workspace, harness } = await fixture(context);
  const content = 'hello world\nhello world\nunique phrase\n';
  await mkdir(path.join(workspace, 'src'));
  await writeFile(path.join(workspace, 'src', 'sample.txt'), content);
  await mkdir(path.join(workspace, '.git'));
  await writeFile(path.join(workspace, '.git', 'ignored.txt'), 'hello world');
  const search = await harness.toolRegistry.get('search_files').execute({ query: 'hello world', path: '.' });
  assert.deepEqual(search.matches.map(match => [match.path, match.line]), [['src/sample.txt', 1], ['src/sample.txt', 2]]);
  const singleFile = await harness.toolRegistry.get('search_files').execute({ query: 'phrase', path: 'src/sample.txt' });
  assert.equal(singleFile.matches[0].line, 3);
  const session = await harness.createSession();
  const execution = { sessionId: session.id, signal: new AbortController().signal };
  const edit = harness.toolRegistry.get('edit_file');
  await assert.rejects(edit.execute({ path: 'src/sample.txt', oldText: 'hello world', newText: 'replacement' }, execution), /匹配 2 次/);
  await assert.rejects(edit.execute({ path: 'src/sample.txt', oldText: 'missing', newText: 'replacement' }, execution), /不存在/);
  assert.equal(await readFile(path.join(workspace, 'src', 'sample.txt'), 'utf8'), content);
  await edit.execute({ path: 'src/sample.txt', oldText: 'unique phrase', newText: 'verified phrase' }, execution);
  const exact = await readFile(path.join(workspace, 'src', 'sample.txt'), 'utf8');
  assert.equal(exact, 'hello world\nhello world\nverified phrase\n');
  await edit.execute({ path: 'src/sample.txt', oldText: 'hello world', newText: 'hi', replaceAll: true }, execution);
  assert.equal(await readFile(path.join(workspace, 'src', 'sample.txt'), 'utf8'), 'hi\nhi\nverified phrase\n');
  const checkpoints = harness.getSession(session.id).checkpoints;
  assert.equal(checkpoints.length, 2);
  await harness.restoreCheckpoint(session.id, checkpoints[1].id);
  assert.equal(await readFile(path.join(workspace, 'src', 'sample.txt'), 'utf8'), exact);
});

test('settings are validated and credentials are redacted from every public projection', async context => {
  const { harness, workspace } = await fixture(context);
  await harness.updateSettings({ provider: 'responses', apiKey: 'my-test-secret-api-key' });
  assert.equal(harness.getSettings().apiKey, undefined);
  assert.equal(harness.getSettings().hasApiKey, true);
  await assert.rejects(harness.updateSettings({ provider: 'unknown' }));
  await assert.rejects(harness.updateSettings({ contextCompactionThreshold: 0 }));
  await assert.rejects(harness.updateSettings({ baseUrl: 'https://user:secret@example.com' }));
  await writeFile(path.join(workspace, 'file.txt'), 'my-test-secret-api-key');
  assert.equal((await harness.readFile('file.txt')).content, '[REDACTED]');
  const session = await harness.createSession();
  harness.addMessage(harness.session(session.id), { role: 'user', content: 'my-test-secret-api-key' });
  assert.ok(!JSON.stringify(harness.getSession(session.id)).includes('my-test-secret-api-key'));
});

test('legacy step caps are discarded and process lock prevents competing writers', async context => {
  const { harness, workspace } = await fixture(context, { maxSteps: 1 });
  await assert.rejects(createHarness({ workspace }), { statusCode: 409 });
  const session = await harness.createSession();
  const terminal = await runToEnd(harness, session.id, 'hello');
  assert.equal(terminal.type, 'run.completed');
  assert.ok(terminal.data.run.steps > 1);
});

test('shell captures exit status, times out, and aborts promptly', async context => {
  const { workspace } = await fixture(context);
  const signal = new AbortController().signal;
  const result = await executeCommand('node --version', { cwd: workspace, signal, timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^v\d+/);
  await assert.rejects(executeCommand('node -e "setTimeout(()=>{}, 10000)"', { cwd: workspace, signal, timeoutMs: 200 }), /超过/);
  const controller = new AbortController();
  const task = executeCommand('node -e "setTimeout(()=>{}, 10000)"', { cwd: workspace, signal: controller.signal, timeoutMs: 15000 });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(task, { name: 'AbortError' });
});

test('memory, skills and AGENTS.md enter model system context; memory has restore checkpoints', async context => {
  const { workspace, harness } = await fixture(context);
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Project uses Node tests.');
  await mkdir(path.join(workspace, '.harness', 'skills', 'review'), { recursive: true });
  await writeFile(path.join(workspace, '.harness', 'skills', 'review', 'SKILL.md'), 'Review code and run targeted tests.');
  const session = await harness.createSession();
  await harness.saveMemory(session.id, 'Use pnpm in this workspace.', new AbortController().signal);
  const prompt = await harness.systemContext(harness.settings);
  assert.match(prompt, /Project uses Node tests/);
  assert.match(prompt, /Use pnpm/);
  assert.match(prompt, /可用技能 review/);
  assert.match((await harness.readSkill('review')).content, /Review code/);
  await harness.restoreCheckpoint(session.id, harness.getSession(session.id).checkpoints[0].id);
  await assert.rejects(readFile(path.join(workspace, '.harness', 'memory.md')), { code: 'ENOENT' });
});

test('interrupted sessions recover cancelled state and unmatched tool calls on restart', async context => {
  const { harness, workspace } = await fixture(context);
  const session = await harness.createSession();
  const internal = harness.session(session.id);
  internal.run = { id: 'interrupted-run', sessionId: session.id, status: 'waiting_approval', startedAt: new Date().toISOString(), steps: 1, usage: { inputTokens: 0, outputTokens: 0 } };
  harness.addMessage(internal, { role: 'user', content: 'A task before a crash' });
  harness.addMessage(internal, { role: 'assistant', content: '', toolCalls: [{ id: 'unfinished-call', name: 'write_file', args: { path: 'file.txt', content: 'not known' } }] });
  await harness.close();
  const reopened = await createHarness({ workspace });
  context.after(() => reopened.close());
  const recovered = reopened.getSession(session.id);
  assert.equal(recovered.run.status, 'cancelled');
  assert.equal(recovered.messages.at(-1).toolCallId, 'unfinished-call');
  assert.match(recovered.messages.at(-1).content, /状态未知/);
  const deletion = eventOnce(reopened, event => event.type === 'session.deleted');
  await reopened.deleteSession(session.id);
  assert.equal((await deletion).sessionId, session.id);
  await reopened.close();
});

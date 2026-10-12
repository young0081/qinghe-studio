import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, access, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import blessed from 'blessed';
import { createHarness } from '../src/core/harness.js';
import { startTui } from '../src/tui.js';
import { testCompletion } from './fixtures/completion.js';
import { startModelServer } from './fixtures/model-server.js';

const pause = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

async function until(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`TUI timeout: ${description}`);
    await pause(20);
  }
}

async function terminal(context, columns = 128, settings = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'harness-tui-test-'));
  const harness = await createHarness({ workspace, settings: { provider: 'responses', model: 'test-model', apiKey: 'test-key', ...settings }, completion: testCompletion });
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = columns;
  output.rows = 42;
  output.resume();
  const completed = startTui({ harness, input, output });
  const key = (name, character = '', extra = {}) => input.emit('keypress', character, { name, sequence: character, ...extra });
  const type = text => { for (const character of text) key(character, character); };
  context.after(async () => {
    key('q', '\x11', { ctrl: true });
    await Promise.race([completed, pause(1000)]);
    await harness.close();
    input.destroy();
    output.destroy();
    await rm(workspace, { recursive: true, force: true });
  });
  await pause(70);
  const screen = blessed.screen.instances.find(instance => instance.program.output === output);
  return { workspace, harness, completed, key, type, rendered: () => screen.lines.map(line => line.map(cell => cell[1]).join('').replaceAll('\x03', '')).join('\n') };
}

test('real blessed keyboard flow runs a task, approves tools, restores checkpoint and saves settings', async context => {
  const ui = await terminal(context);
  assert.match(ui.rendered(), /青禾 Studio/);
  ui.type('[test:write]');
  ui.key('s', '\x13', { ctrl: true });
  await until(() => ui.harness.listSessions()[0]?.run?.status === 'waiting_approval', 'approval request');
  await pause(80);
  ui.key('y', 'y');
  await until(() => ui.harness.listSessions()[0]?.run?.status === 'completed', 'approved task completion');
  const session = ui.harness.getSession(ui.harness.listSessions()[0].id);
  assert.equal(session.checkpoints.length, 1);
  await access(join(ui.workspace, 'harness-test.txt'));
  ui.key('f7');
  await pause(80);
  ui.key('enter', '\r');
  await pause(80);
  ui.key('r', 'r');
  await pause(80);
  ui.key('y', 'y');
  await until(() => ui.harness.getSession(session.id).checkpoints[0].restored, 'checkpoint restore');
  await assert.rejects(access(join(ui.workspace, 'harness-test.txt')));
  ui.key('f8');
  await pause(80);
  for (let index = 0; index < ui.harness.getSettings().provider.length; index += 1) ui.key('backspace', '\x7f');
  ui.type('openai');
  ui.key('tab', '\t');
  await pause(30);
  for (let index = 0; index < ui.harness.getSettings().model.length; index += 1) ui.key('backspace', '\x7f');
  ui.type('updated-model');
  ui.key('tab', '\t');
  await pause(30);
  ui.type('http://127.0.0.1:1234/v1');
  ui.key('tab', '\t');
  await pause(30);
  ui.type('secret-tui-key-must-stay-masked');
  assert.equal(ui.rendered().includes('secret-tui-key'), false);
  ui.key('s', '\x13', { ctrl: true });
  await until(() => ui.harness.getSettings().provider === 'openai', 'provider settings saved');
  assert.equal(ui.harness.getSettings().model, 'updated-model');
  assert.equal(ui.harness.getSettings().baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(ui.harness.getSettings().hasApiKey, true);
  ui.key('f2');
  await until(() => ui.harness.listSessions().length === 2, 'new session while composer focused');
  ui.key('q', '\x11', { ctrl: true });
  await Promise.race([ui.completed, pause(1000).then(() => { throw new Error('Ctrl+Q did not exit'); })]);
});

test('narrow terminal opens files/help and Escape denies approval', async context => {
  const ui = await terminal(context, 80);
  await writeFile(join(ui.workspace, 'visible.txt'), 'hello TUI', 'utf8');
  ui.key('f4');
  await pause(100);
  assert.match(ui.rendered(), /visible\.txt/);
  ui.key('enter', '\r');
  await pause(80);
  assert.match(ui.rendered(), /hello TUI/);
  ui.key('escape', '\x1b');
  ui.key('f1');
  await pause(80);
  assert.match(ui.rendered(), /Ctrl\+S/);
  ui.key('escape', '\x1b');
  ui.key('i', 'i');
  await pause(40);
  ui.type('[test:write]');
  ui.key('s', '\x13', { ctrl: true });
  await until(() => ui.harness.listSessions()[0]?.run?.status === 'waiting_approval', 'approval request');
  await pause(80);
  ui.key('escape', '\x1b');
  await until(() => ui.harness.listSessions()[0]?.run?.status === 'completed', 'denied task completion');
  await assert.rejects(access(join(ui.workspace, 'harness-test.txt')));
  assert.ok(ui.harness.getSession(ui.harness.listSessions()[0].id).events.some(event => event.type === 'approval.resolved' && event.data.status === 'denied'));
});

test('TUI stops approval-waiting tasks, switches and deletes sessions, and reports restore conflicts', async context => {
  const ui = await terminal(context);
  ui.type('[test:write]');
  ui.key('s', '\x13', { ctrl: true });
  await until(() => ui.harness.listSessions()[0]?.run?.status === 'waiting_approval', 'pending task');
  const firstId = ui.harness.listSessions()[0].id;
  ui.key('f10');
  await until(() => ui.harness.getSession(firstId).run.status === 'cancelled', 'F10 cancellation');
  ui.key('f2');
  await until(() => ui.harness.listSessions().length === 2, 'second session');
  await pause(70);
  ui.key('f3');
  ui.key('down');
  ui.key('enter', '\r');
  await pause(70);
  assert.match(ui.rendered(), /已取消/);
  ui.key('f9');
  await pause(70);
  ui.key('y', 'y');
  await until(() => ui.harness.listSessions().length === 1, 'session deletion');
  assert.throws(() => ui.harness.getSession(firstId), /不存在/);
  ui.key('i', 'i');
  await pause(40);
  ui.type('[test:write]');
  ui.key('s', '\x13', { ctrl: true });
  await until(() => ui.harness.listSessions()[0]?.run?.status === 'waiting_approval', 'second write approval');
  ui.key('y', 'y');
  await until(() => ui.harness.listSessions()[0]?.run?.status === 'completed', 'second write complete');
  const file = join(ui.workspace, 'harness-test.txt');
  await writeFile(file, 'User changes must survive', 'utf8');
  ui.key('f7');
  await pause(60);
  ui.key('enter', '\r');
  await pause(60);
  ui.key('r', 'r');
  await pause(60);
  ui.key('y', 'y');
  await until(() => ui.rendered().includes('错误'), 'conflicting restore error displayed');
  assert.equal(await readFile(file, 'utf8'), 'User changes must survive');
  assert.ok(!ui.harness.listSessions()[0].checkpoints[0].restored);
});

test('TUI guides unconfigured users to settings without creating a task', async context => {
  const ui = await terminal(context, 80, { model: '' });
  assert.match(ui.rendered(), /F8/);
  assert.match(ui.rendered(), /尚未配置/);
  assert.doesNotMatch(ui.rendered(), /demo/i);
  ui.type('implement feature');
  ui.key('s', '\x13', { ctrl: true });
  await until(() => ui.rendered().includes('模型与运行设置'), 'setup settings');
  assert.deepEqual(ui.harness.listSessions(), []);
});

test('TUI connection testing is explicit, uses native API and preserves unsaved settings', async context => {
  const model = await startModelServer();
  context.after(() => model.close());
  const ui = await terminal(context, 128, { baseUrl: model.url });
  ui.key('f8');
  await pause(60);
  assert.equal(model.requests.length, 0);
  ui.key('t', '\x14', { ctrl: true });
  await until(() => ui.rendered().includes('连接成功'), 'native connection success');
  assert.equal(model.requests.length, 1);
  assert.equal(model.requests[0].path, '/v1/responses');
  assert.ok(!model.requests[0].body.tools?.length);
  for (let index = 0; index < 3; index += 1) {
    ui.key('tab', '\t');
    await pause(30);
  }
  ui.type('invalid-key');
  ui.key('t', '\x14', { ctrl: true });
  await until(() => ui.rendered().includes('连接失败'), 'native connection failure');
  assert.equal(model.requests.length, 2);
  assert.doesNotMatch(ui.rendered(), /invalid-key/);
  assert.equal((await ui.harness.testConnection()).ok, true);
});

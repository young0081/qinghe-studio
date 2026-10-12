import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import { createHarness } from '../src/core/harness.js';
import { main } from '../src/cli.js';
import { startTui } from '../src/tui.js';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const response = (toolCalls = [], content = '') => ({ toolCalls, content, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });

function completionFor(args = { question: '请选择部署环境', options: ['预览', '生产'] }) {
  return async (settings, { messages }) => {
    const index = messages.findLastIndex(message => message.role === 'user');
    const result = messages.slice(index + 1).find(message => message.role === 'tool');
    return result ? response([], `收到回答：${result.content}`) : response([{ id: `ask-${index}`, name: 'ask_user', args }]);
  };
}

async function fixture(context, completion = completionFor(), settings = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'harness-questions-'));
  const harness = await createHarness({ workspace, completion, settings: { provider: 'responses', model: 'question-model', apiKey: 'question-secret-key', ...settings } });
  context.after(async () => { await harness.close(); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { workspace, harness };
}

function nextEvent(harness, type, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harness.off('event', listener); reject(new Error(`Waiting for ${type} timed out`)); }, 10000);
    const listener = event => {
      if (event.type === type && (!sessionId || event.sessionId === sessionId)) {
        clearTimeout(timer);
        harness.off('event', listener);
        resolve(event);
      }
    };
    harness.on('event', listener);
  });
}

async function ask(harness, sessionId) {
  const required = nextEvent(harness, 'question.required', sessionId);
  await harness.run(sessionId, '开始任务');
  return (await required).data;
}

test('ask_user pauses the same run, allows free text under readonly and resumes with a paired tool result', async context => {
  let completions = 0;
  const complete = completionFor();
  const { harness } = await fixture(context, (...args) => { completions++; return complete(...args); }, { approval: 'readonly' });
  const session = await harness.createSession();
  const question = await ask(harness, session.id);
  assert.equal(completions, 1);
  assert.equal(harness.getSession(session.id).run.status, 'waiting_input');
  assert.ok(harness.getTools().some(tool => tool.name === 'ask_user'));
  assert.deepEqual(harness.getQuestions(), [question]);
  const publicCopy = harness.getQuestions();
  publicCopy[0].options[0] = 'tampered';
  assert.equal(harness.getQuestions()[0].options[0], '预览');
  await assert.rejects(harness.run(session.id, '重叠任务'), { statusCode: 409 });
  const terminal = nextEvent(harness, 'run.completed');
  const answered = await harness.answerQuestion(question.id, { answer: ' 自定义第三种环境 ' });
  await terminal;
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, '自定义第三种环境');
  assert.deepEqual(harness.getQuestions(), []);
  const saved = harness.getSession(session.id);
  assert.equal(saved.run.id, question.runId);
  assert.equal(saved.run.steps, 2);
  assert.equal(completions, 2);
  assert.deepEqual(JSON.parse(saved.messages.find(message => message.role === 'tool').content), { questionId: question.id, answer: '自定义第三种环境' });
  assert.equal(saved.events.filter(event => event.type === 'question.resolved').length, 1);
  assert.equal(saved.events.some(event => event.type === 'approval.required'), false);
});

test('answer validation leaves the question pending and concurrent or stale submissions settle only once', async context => {
  const { harness } = await fixture(context);
  const session = await harness.createSession();
  const question = await ask(harness, session.id);
  for (const input of [null, [], {}, { answer: '' }, { answer: '   ' }, { answer: 1 }, { answer: 'x'.repeat(16001) }, { answer: '\u001b[31m' }, { answer: 'yes', extra: true }]) {
    await assert.rejects(harness.answerQuestion(question.id, input), { statusCode: 400 });
    assert.equal(harness.getQuestions().length, 1);
  }
  const terminal = nextEvent(harness, 'run.completed');
  const results = await Promise.allSettled([harness.answerQuestion(question.id, { answer: '预览' }), harness.answerQuestion(question.id, { answer: '生产' })]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.statusCode, 404);
  await terminal;
});

test('invalid questions fail as tool results without entering a waiting state', async context => {
  const invalid = [{ question: '' }, { question: 'x'.repeat(4001) }, { question: 'hello', options: [''] }, { question: 'hello', options: ['A', ' A '] }, { question: 'hello', options: ['x'.repeat(201)] }, { question: 'hello', options: Array(9).fill('A') }, { question: 'hello\u001b', options: [] }];
  let args;
  const { harness } = await fixture(context, (settings, request) => completionFor(args)(settings, request));
  for (args of invalid) {
    const session = await harness.createSession();
    const terminal = nextEvent(harness, 'run.completed');
    await harness.run(session.id, '开始');
    await terminal;
    const saved = harness.getSession(session.id);
    assert.ok(saved.events.some(event => event.type === 'tool.failed' && event.data.name === 'ask_user'));
    assert.equal(saved.events.some(event => event.type === 'question.required'), false);
    assert.deepEqual(harness.getQuestions(), []);
  }
});

test('question text, choices and answers are redacted in events, getters, tool output and durable history', async context => {
  const secret = 'question-secret-key';
  const { harness, workspace } = await fixture(context, completionFor({ question: `信息 ${secret}`, options: [`选项 ${secret}`] }));
  const session = await harness.createSession();
  const question = await ask(harness, session.id);
  assert.equal(JSON.stringify(question).includes(secret), false);
  const terminal = nextEvent(harness, 'run.completed');
  await harness.answerQuestion(question.id, { answer: `回答 ${secret}` });
  await terminal;
  assert.equal(JSON.stringify(harness.getSession(session.id)).includes(secret), false);
  assert.equal((await readFile(join(workspace, '.harness', 'sessions', `${session.id}.json`), 'utf8')).includes(secret), false);
});

test('cancellation clears a waiting question, rejects late answers and allows safe session deletion', async context => {
  const { harness } = await fixture(context);
  const session = await harness.createSession();
  const question = await ask(harness, session.id);
  await assert.rejects(harness.deleteSession(session.id), { statusCode: 409 });
  await harness.cancelRun(session.id);
  assert.deepEqual(harness.getQuestions(), []);
  assert.equal(harness.getSession(session.id).run.status, 'cancelled');
  assert.equal(harness.getSession(session.id).events.findLast(event => event.type === 'question.resolved').data.status, 'cancelled');
  await assert.rejects(harness.answerQuestion(question.id, { answer: '迟到的回答' }), { statusCode: 404 });
  await harness.deleteSession(session.id);
  assert.deepEqual(harness.listSessions(), []);
});

test('close aborts waiting input and restart reconciles interrupted questions without dangling tool calls', async context => {
  const { harness, workspace } = await fixture(context);
  const session = await harness.createSession();
  const question = await ask(harness, session.id);
  await harness.flush();
  const interrupted = await readFile(join(workspace, '.harness', 'sessions', `${session.id}.json`), 'utf8');
  await harness.close();
  assert.deepEqual(harness.getQuestions(), []);
  assert.equal(harness.getSession(session.id).run.status, 'cancelled');
  await writeFile(join(workspace, '.harness', 'sessions', `${session.id}.json`), interrupted);
  const reopened = await createHarness({ workspace, completion: completionFor(), settings: { model: 'question-model', apiKey: 'question-secret-key' } });
  try {
    const recovered = reopened.getSession(session.id);
    assert.equal(recovered.run.status, 'cancelled');
    assert.equal(recovered.events.findLast(event => event.type === 'question.resolved').data.status, 'cancelled');
    assert.equal(recovered.messages.filter(message => message.role === 'tool' && message.toolCallId === question.callId).length, 1);
    assert.deepEqual(reopened.getQuestions(), []);
    await assert.rejects(reopened.answerQuestion(question.id, { answer: '无效' }), { statusCode: 404 });
    const resumed = await ask(reopened, session.id);
    const terminal = nextEvent(reopened, 'run.completed');
    await reopened.answerQuestion(resumed.id, { answer: '继续任务' });
    await terminal;
  } finally { await reopened.close(); }
});

test('questions in concurrent sessions remain independent', async context => {
  const { harness } = await fixture(context);
  const first = await harness.createSession();
  const second = await harness.createSession();
  const one = await ask(harness, first.id);
  const two = await ask(harness, second.id);
  assert.equal(harness.getQuestions().length, 2);
  const terminal = nextEvent(harness, 'run.completed', second.id);
  await harness.answerQuestion(two.id, { answer: '第二个会话' });
  await terminal;
  assert.equal(harness.getSession(first.id).run.status, 'waiting_input');
  assert.deepEqual(harness.getQuestions().map(question => question.id), [one.id]);
  await harness.cancelRun(first.id);
});

test('CLI answers selected options and free text; noninteractive JSON runs cancel instead of hanging', async context => {
  const received = [];
  const server = createServer(async (request, reply) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const answer = body.messages.findLast(message => message.role === 'tool');
    if (answer) received.push(JSON.parse(answer.content).answer);
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify({ choices: [{ message: answer ? { role: 'assistant', content: '回答已收到' } : { role: 'assistant', content: '', tool_calls: [{ id: 'cli-question', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '请选择', options: ['预览', '生产'] }) } }] }, finish_reason: answer ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { harness, workspace } = await fixture(context);
  await harness.updateSettings({ provider: 'openai', model: 'question-model', apiKey: 'question-secret-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  await harness.close();
  for (const reply of ['2', '自定义回答', null]) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.isTTY = stderr.isTTY = reply !== null;
    stdin.setRawMode = () => {};
    let output = '';
    let error = '';
    stdout.on('data', chunk => { output += chunk; });
    stderr.on('data', chunk => {
      error += chunk;
      if (reply !== null && chunk.toString().includes('输入选项编号或自由文本')) setImmediate(() => stdin.write(`${reply}\n`));
    });
    const code = await main(['run', '请提问', '--workspace', workspace, ...(reply === null ? ['--json'] : [])], { stdin, stdout, stderr });
    assert.equal(code, reply === null ? 130 : 0, error);
    if (reply === null) {
      assert.match(error, /当前没有交互终端/);
      assert.equal(JSON.parse(output.trim().split('\n').at(-1)).type, 'run.cancelled');
    } else assert.match(output, /回答已收到/);
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  }
  assert.deepEqual(received, ['生产', '自定义回答']);
});

test('TUI question modal accepts keyboard answers and Escape cancels the waiting task', async context => {
  const { harness } = await fixture(context);
  const session = await harness.createSession();
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = () => input;
  output.columns = 128;
  output.rows = 42;
  output.resume();
  const completed = startTui({ harness, input, output });
  const key = (name, character = '', extra = {}) => input.emit('keypress', character, { name, sequence: character, ...extra });
  try {
    await pause(70);
    await ask(harness, session.id);
    await pause(80);
    const screen = blessed.screen.instances.find(instance => instance.program.output === output);
    const rendered = screen.lines.map(line => line.map(cell => cell[1]).join('').replaceAll('\x03', '')).join('\n');
    assert.match(rendered, /青禾 Studio 需要补充信息/);
    const terminal = nextEvent(harness, 'run.completed');
    for (const character of '自定义回答') key(character, character);
    key('s', '\x13', { ctrl: true });
    await terminal;
    assert.equal(harness.getSession(session.id).events.findLast(event => event.type === 'question.resolved').data.answer, '自定义回答');
    await ask(harness, session.id);
    await pause(80);
    const cancelled = nextEvent(harness, 'run.cancelled');
    key('escape', '\x1b');
    await cancelled;
    assert.deepEqual(harness.getQuestions(), []);
  } finally {
    key('q', '\x11', { ctrl: true });
    await completed;
    input.destroy();
    output.destroy();
  }
});

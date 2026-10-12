import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHarness } from '../src/core/harness.js';
import { startServer } from '../src/server.js';

const apiKey = 'companion-http-secret-key';
const questionInput = { question: '请选择发布环境，也可以填写其他环境', options: ['预览环境', '生产环境'] };

async function completion(settings, { messages }) {
  const latest = messages.findLastIndex(message => message.role === 'user');
  const answer = messages.slice(latest + 1).find(message => message.role === 'tool');
  return { content: answer ? `回答已收到：${answer.content}` : '', toolCalls: answer ? [] : [{ id: `ask-http-${latest}`, name: 'ask_user', args: questionInput }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: answer ? 'stop' : 'tool_calls' };
}

async function fixture(context, options = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'harness-companion-http-'));
  const harness = await createHarness({ workspace, completion, settings: { provider: 'responses', model: 'test-model', apiKey } });
  const server = await startServer({ harness, port: 0, ...options });
  context.after(async () => { await server.close(); await harness.close(); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const request = async (route, { method = 'GET', body, headers = {}, raw } = {}) => {
    const response = await fetch(`${server.url}${route}`, { method, headers: { ...(options.authToken ? { 'X-Harness-Token': options.authToken } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return { harness, server, request };
}

function event(harness, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harness.off('event', listener); reject(new Error(`Timed out: ${type}`)); }, 10000);
    const listener = value => {
      if (value.type !== type) return;
      clearTimeout(timer);
      harness.off('event', listener);
      resolve(value);
    };
    harness.on('event', listener);
  });
}

async function begin({ harness, request }) {
  const session = await request('/api/sessions', { method: 'POST', body: { title: 'HTTP companion test' } });
  assert.equal(session.status, 201);
  const required = event(harness, 'question.required');
  const run = await request(`/api/sessions/${session.body.id}/run`, { method: 'POST', body: { prompt: '开始任务，需要补充信息时提问' } });
  assert.equal(run.status, 202);
  return { session: session.body, run: run.body, question: (await required).data };
}

test('HTTP questions expose the pending request, accept free text and resume the same run with SSE history', async context => {
  const api = await fixture(context);
  const controller = new AbortController();
  context.after(() => controller.abort());
  const stream = await fetch(`${api.server.url}/api/events`, { signal: controller.signal });
  const reader = stream.body.getReader();
  await reader.read();
  const { session, run, question } = await begin(api);
  const pending = await api.request('/api/questions');
  assert.equal(pending.status, 200);
  assert.equal(pending.headers.get('cache-control'), 'no-store');
  assert.deepEqual(pending.body, [question]);
  const waiting = await api.request(`/api/sessions/${session.id}`);
  assert.equal(waiting.body.run.status, 'waiting_input');
  assert.equal(waiting.body.run.id, run.id);
  assert.ok(waiting.body.events.some(item => item.type === 'question.required' && item.data.id === question.id));
  const finished = event(api.harness, 'run.completed');
  const answer = await api.request(`/api/questions/${question.id}`, { method: 'POST', body: { answer: `使用自定义环境 ${apiKey}` } });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  assert.equal(answer.body.status, 'answered');
  assert.equal(answer.body.id, question.id);
  assert.equal(JSON.stringify(answer.body).includes(apiKey), false);
  await finished;
  assert.deepEqual((await api.request('/api/questions')).body, []);
  const completed = (await api.request(`/api/sessions/${session.id}`)).body;
  assert.equal(completed.run.id, run.id);
  assert.equal(completed.run.status, 'completed');
  const toolResult = JSON.parse(completed.messages.find(message => message.role === 'tool').content);
  assert.equal(toolResult.questionId, question.id);
  assert.match(toolResult.answer, /使用自定义环境/);
  assert.equal(JSON.stringify(completed).includes(apiKey), false);
  let events = '';
  while (!events.includes('run.completed')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    events += new TextDecoder().decode(chunk.value);
  }
  assert.match(events, /question.required/);
  assert.match(events, /question.resolved/);
  assert.match(events, /"status":"answered"/);
  assert.equal(events.includes(apiKey), false);
  controller.abort();
});

test('HTTP answer rejects malformed bodies and duplicate submissions without consuming valid pending input', async context => {
  const api = await fixture(context);
  const { question } = await begin(api);
  const route = `/api/questions/${question.id}`;
  for (const body of [null, [], {}, { answer: '' }, { answer: '  ' }, { answer: 7 }, { answer: 'x'.repeat(16001) }, { answer: 'yes', sessionId: 'another-session' }, { answer: '\u001b[31m' }]) {
    const rejected = await api.request(route, { method: 'POST', body });
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal(typeof rejected.body.error, 'string');
    assert.equal((await api.request('/api/questions')).body[0].id, question.id);
  }
  assert.equal((await api.request(route, { method: 'POST', raw: '{"answer":', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await api.request(route, { method: 'POST', raw: 'answer=hello', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const finished = event(api.harness, 'run.completed');
  const responses = await Promise.all(['预览环境', '生产环境'].map(answer => api.request(route, { method: 'POST', body: { answer } })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 404]);
  await finished;
  assert.equal((await api.request(route, { method: 'POST', body: { answer: '再次提交' } })).status, 404);
  assert.equal((await api.request('/api/questions/missing', { method: 'POST', body: { answer: '不存在的问题' } })).status, 404);
});

test('HTTP cancellation clears the question and invalidates late answers before session deletion', async context => {
  const api = await fixture(context);
  const { session, question } = await begin(api);
  assert.equal((await api.request(`/api/sessions/${session.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await api.request(`/api/sessions/${session.id}/cancel`, { method: 'POST', body: {} })).status, 200);
  assert.deepEqual((await api.request('/api/questions')).body, []);
  const cancelled = (await api.request(`/api/sessions/${session.id}`)).body;
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.events.findLast(item => item.type === 'question.resolved').data.status, 'cancelled');
  assert.equal((await api.request(`/api/questions/${question.id}`, { method: 'POST', body: { answer: '迟到回答' } })).status, 404);
  assert.equal((await api.request(`/api/sessions/${session.id}`, { method: 'DELETE' })).status, 200);
});

test('browser live HTTP transports current metadata and JPEG frames without caching or duplicate delivery', async context => {
  const { harness, server, request } = await fixture(context);
  const initial = await request('/api/automation/browser-live');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.active, false);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  const empty = await fetch(`${server.url}/api/automation/browser-live/frame`);
  assert.equal(empty.status, 204);
  assert.equal(empty.headers.get('cache-control'), 'no-store');
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
  let frame = { sequence: 41, mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x48, 0x53, 0xff, 0xd9]) };
  harness.automation.browser.getBrowserFrame = () => frame;
  harness.automation.browser.getBrowserLive = () => ({ active: true, sessionId: 'http-session', runId: 'http-run', tabId: 'tab-1', title: `测试网页 ${apiKey}`, url: 'https://example.test/', action: 'click', sequence: frame?.sequence || 0, updatedAt: new Date().toISOString() });
  const metadata = await request('/api/automation/browser-live');
  assert.equal(metadata.body.sequence, 41);
  assert.equal(metadata.body.action, 'click');
  assert.equal(metadata.body.sessionId, 'http-session');
  assert.equal(JSON.stringify(metadata.body).includes(apiKey), false);
  assert.equal(metadata.body.data, undefined);
  const first = await fetch(`${server.url}/api/automation/browser-live/frame?after=40`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('content-type'), 'image/jpeg');
  assert.equal(first.headers.get('x-frame-sequence'), '41');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), frame.data);
  const repeated = await fetch(`${server.url}/api/automation/browser-live/frame?after=41`);
  assert.equal(repeated.status, 204);
  assert.equal(repeated.headers.get('cache-control'), 'no-store');
  assert.equal((await repeated.arrayBuffer()).byteLength, 0);
  frame = { ...frame, sequence: 42, data: Buffer.from([0xff, 0xd8, 0x42, 0xff, 0xd9]) };
  const next = await fetch(`${server.url}/api/automation/browser-live/frame?after=41`);
  assert.equal(next.status, 200);
  assert.equal(next.headers.get('x-frame-sequence'), '42');
  assert.deepEqual(Buffer.from(await next.arrayBuffer()), frame.data);
  frame = null;
  const cleared = await fetch(`${server.url}/api/automation/browser-live/frame?after=42`);
  assert.equal(cleared.status, 204);
  assert.equal(cleared.headers.get('cache-control'), 'no-store');
  await cleared.arrayBuffer();
});

test('desktop authentication, Origin, fetch-site and Host protect questions and browser live routes', async context => {
  const authToken = 'companion-desktop-private-token-32-characters';
  const api = await fixture(context, { authToken });
  const { question } = await begin(api);
  const routes = [
    ['/api/questions', 'GET'],
    [`/api/questions/${question.id}`, 'POST'],
    ['/api/automation/browser-live', 'GET'],
    ['/api/automation/browser-live/frame', 'GET'],
  ];
  for (const [route, method] of routes) {
    const body = method === 'POST' ? JSON.stringify({ answer: '未经授权的回答' }) : undefined;
    const baseHeaders = { ...(body ? { 'Content-Type': 'application/json' } : {}) };
    for (const token of [undefined, 'wrong-token']) {
      const blocked = await fetch(`${api.server.url}${route}`, { method, body, headers: { ...baseHeaders, ...(token ? { 'X-Harness-Token': token } : {}) } });
      assert.equal(blocked.status, 401, route);
      const error = await blocked.json();
      assert.equal(JSON.stringify(error).includes(authToken), false);
    }
    for (const securityHeaders of [{ Origin: 'https://hostile.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const blocked = await fetch(`${api.server.url}${route}`, { method, body, headers: { ...baseHeaders, 'X-Harness-Token': authToken, ...securityHeaders } });
      assert.equal(blocked.status, 403, route);
      await blocked.json();
    }
    const status = await new Promise((resolve, reject) => {
      const request = http.request(`${api.server.url}${route}`, { method, headers: { ...baseHeaders, 'X-Harness-Token': authToken, Host: 'hostile.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(status, 403, route);
  }
  assert.equal((await api.request('/api/questions')).body[0].id, question.id);
  const live = await api.request('/api/automation/browser-live', { headers: { Origin: api.server.url } });
  assert.equal(live.status, 200);
  const finished = event(api.harness, 'run.completed');
  const answered = await api.request(`/api/questions/${question.id}`, { method: 'POST', headers: { Origin: api.server.url }, body: { answer: '已授权回答' } });
  assert.equal(answered.status, 200);
  await finished;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../src/core/harness.js';
import { complete } from '../src/core/providers.js';
import { validateSettings } from '../src/core/settings.js';

for (const protocol of ['responses', 'openai', 'anthropic']) test(`${protocol} carries tool screenshots as native image blocks after complete tool results`, async context => {
  const image = { mimeType: 'image/jpeg', data: 'dGVzdC1pbWFnZQ==' };
  const { baseUrl, requests } = await mock(context, (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(protocol === 'responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] } : protocol === 'openai' ? { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } : { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
  });
  const messages = [
    { role: 'user', content: '查看网页' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'screen', name: 'browser', args: { action: 'screenshot' } }, { id: 'tabs', name: 'browser', args: { action: 'tabs' } }] },
    { role: 'tool', toolCallId: 'screen', content: '{"screenshotId":"capture"}', images: [image] },
    { role: 'tool', toolCallId: 'tabs', content: '{"tabs":[]}' },
  ];
  await complete(validateSettings({ provider: protocol, model: 'fixture-vision', apiKey: 'fixture-key', baseUrl }), { messages, system: 'Test only', tools: [], signal: new AbortController().signal, onDelta() {} });
  const body = requests[0].body;
  if (protocol === 'responses') {
    assert.equal(body.input.at(-2).call_id, 'tabs');
    assert.deepEqual(body.input.at(-1).content.at(-1), { type: 'input_image', image_url: `data:image/jpeg;base64,${image.data}`, detail: 'auto' });
  } else if (protocol === 'openai') {
    assert.equal(body.messages.at(-2).tool_call_id, 'tabs');
    assert.deepEqual(body.messages.at(-1).content.at(-1), { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.data}` } });
  } else {
    const result = body.messages.at(-1).content;
    assert.equal(result[1].tool_use_id, 'tabs');
    assert.deepEqual(result[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.data } });
  }
  assert.equal(messages.length, 4);
});

for (const protocol of ['responses', 'openai', 'anthropic']) test(`${protocol} summarizes through its native endpoint and automatically continues length-limited output`, async context => {
  let mainRequests = 0;
  let summaryRequests = 0;
  const { baseUrl, requests } = await mock(context, (request, remote) => {
    const summarizing = !request.body.tools?.length;
    if (summarizing) summaryRequests++;
    else mainRequests++;
    const truncated = !summarizing && mainRequests === 1;
    const content = summarizing ? '用户目标：检查项目。已读早期记录。继续处理最新任务。' : truncated ? '第一部分' : '任务已完成';
    const usage = { input_tokens: 10, output_tokens: 10 };
    remote.setHeader('content-type', 'application/json');
    remote.end(JSON.stringify(protocol === 'responses'
      ? { status: truncated ? 'incomplete' : 'completed', incomplete_details: truncated ? { reason: 'max_output_tokens' } : null, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }], usage }
      : protocol === 'openai'
        ? { choices: [{ message: { content }, finish_reason: truncated ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }
        : { content: [{ type: 'text', text: content }], stop_reason: truncated ? 'max_tokens' : 'end_turn', usage }));
  });
  const { harness, session } = await fixture(context, { provider: protocol, baseUrl, maxContextTokens: 9000, maxTokens: 512 });
  harness.addMessage(harness.session(session.id), { role: 'user', content: '需要检查项目的历史记录。'.repeat(3000) });
  const end = await runToEnd(harness, session.id, '处理最新任务');
  assert.equal(end.type, 'run.completed', end.data.run.error);
  assert.ok(summaryRequests > 0);
  assert.equal(mainRequests, 2);
  const main = requests.filter(request => request.body.tools?.length);
  assert.match(JSON.stringify(main[0].body), /会话已自动压缩/);
  assert.match(JSON.stringify(main[1].body), /单次输出上限/);
  assert.equal((protocol === 'responses' ? main[1].body.input : main[1].body.messages).at(-1).role, 'user');
  assert.equal(harness.getSession(session.id).messages.filter(message => message.role === 'assistant').length, 2);
});

async function mock(context, handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const item = { url: request.url, headers: request.headers, body: JSON.parse(text) };
    requests.push(item);
    try { await handler(item, response, requests.length); }
    catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function sse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  for (let offset = 0; offset < bytes.length; offset += 7) response.write(bytes.subarray(offset, offset + 7));
  response.end();
}

async function fixture(context, settings) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'harness-provider-'));
  const harness = await createHarness({ workspace, settings: { model: 'test-model', apiKey: 'mock-key-only-for-test', approval: 'auto', ...settings } });
  context.after(async () => { await harness.close(); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const session = await harness.createSession();
  return { workspace, harness, session };
}

async function runToEnd(harness, sessionId, prompt = 'Create a test file') {
  const terminal = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harness.off('event', listener); reject(new Error('run timeout')); }, 10000);
    const listener = event => { if (event.sessionId === sessionId && /^run\.(completed|failed|cancelled)$/.test(event.type)) { clearTimeout(timer); harness.off('event', listener); resolve(event); } };
    harness.on('event', listener);
  });
  await harness.run(sessionId, prompt);
  return terminal;
}

test('native Chat Completions streams split tool JSON, performs writes, sends tool results, and counts usage', async context => {
  const { baseUrl, requests } = await mock(context, (request, response, count) => {
    if (count === 1) sse(response, [
      { choices: [{ delta: { content: '创建中文文件。', tool_calls: [{ index: 0, id: 'call_chat_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"result.txt",' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"中文内容\\n"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10 } },
    ]);
    else sse(response, [{ choices: [{ delta: { content: '文件已创建并验证。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 45, completion_tokens: 8 } }]);
  });
  const { harness, session, workspace } = await fixture(context, { provider: 'openai', baseUrl });
  const end = await runToEnd(harness, session.id);
  assert.equal(end.type, 'run.completed');
  assert.equal(await readFile(path.join(workspace, 'result.txt'), 'utf8'), '中文内容\n');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, 'Bearer mock-key-only-for-test');
  assert.equal(requests[0].body.tools[0].type, 'function');
  assert.equal(requests[1].body.messages.find(message => message.role === 'tool').tool_call_id, 'call_chat_1');
  assert.deepEqual(end.data.run.usage, { inputTokens: 75, outputTokens: 18 });
  assert.ok(harness.getSession(session.id).events.some(event => event.type === 'assistant.delta' && event.data.text === '创建中文文件。'));
});

test('native Responses preserves reasoning items and function-call output round trips', async context => {
  const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'encrypted-reasoning-test' };
  const functionCall = { id: 'fc_1', type: 'function_call', call_id: 'call_responses_1', name: 'write_file', arguments: '{"path":"result.txt","content":"native responses"}', status: 'completed' };
  const { baseUrl, requests } = await mock(context, (request, response, count) => {
    if (count === 1) sse(response, [
      { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...functionCall, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: functionCall.arguments.slice(0, 20) },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: functionCall.arguments.slice(20) },
      { type: 'response.function_call_arguments.done', output_index: 1, arguments: functionCall.arguments },
      { type: 'response.output_item.done', output_index: 1, item: functionCall },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [reasoning, functionCall], usage: { input_tokens: 35, output_tokens: 15 } } },
    ]);
    else sse(response, [
      { type: 'response.output_text.delta', delta: 'Responses 完成。' },
      { type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [{ type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: 'Responses 完成。', annotations: [] }] }], usage: { input_tokens: 50, output_tokens: 6 } } },
    ]);
  });
  const { harness, session, workspace } = await fixture(context, { provider: 'responses', baseUrl, model: 'gpt-5-mini' });
  const end = await runToEnd(harness, session.id);
  assert.equal(end.type, 'run.completed');
  assert.equal(await readFile(path.join(workspace, 'result.txt'), 'utf8'), 'native responses');
  assert.equal(requests[0].url, '/v1/responses');
  assert.equal(requests[0].body.temperature, undefined);
  assert.equal(requests[0].body.store, false);
  assert.ok(requests[0].body.include.includes('reasoning.encrypted_content'));
  assert.equal(requests[0].body.tools[0].type, 'function');
  assert.equal(requests[0].body.tools[0].function, undefined);
  assert.deepEqual(requests[1].body.input.find(item => item.type === 'reasoning'), reasoning);
  assert.equal(requests[1].body.input.find(item => item.type === 'function_call_output').call_id, 'call_responses_1');
  assert.deepEqual(end.data.run.usage, { inputTokens: 85, outputTokens: 21 });
});

test('native Anthropic Messages streams tool_use blocks and sends tool_result user blocks', async context => {
  const { baseUrl, requests } = await mock(context, (request, response, count) => {
    if (count === 1) sse(response, [
      { type: 'message_start', message: { usage: { input_tokens: 25, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '开始写入。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"result.txt",' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"content":"native messages"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]);
    else sse(response, [
      { type: 'message_start', message: { usage: { input_tokens: 44, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Messages 完成。' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]);
  });
  const { harness, session, workspace } = await fixture(context, { provider: 'anthropic', baseUrl });
  const end = await runToEnd(harness, session.id);
  assert.equal(end.type, 'run.completed');
  assert.equal(await readFile(path.join(workspace, 'result.txt'), 'utf8'), 'native messages');
  assert.equal(requests[0].url, '/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], 'mock-key-only-for-test');
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
  assert.ok(requests[0].body.tools[0].input_schema);
  assert.equal(requests[1].body.messages.at(-1).role, 'user');
  assert.equal(requests[1].body.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(requests[1].body.messages.at(-1).content[0].tool_use_id, 'toolu_1');
  assert.deepEqual(end.data.run.usage, { inputTokens: 69, outputTokens: 19 });
});

test('provider error details redact configured credentials', async context => {
  const { baseUrl } = await mock(context, (request, response) => { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: `Invalid key: ${request.headers.authorization}` } })); });
  const { harness, session } = await fixture(context, { provider: 'openai', baseUrl });
  const end = await runToEnd(harness, session.id);
  assert.equal(end.type, 'run.failed');
  assert.match(end.data.run.error, /HTTP 401/);
  assert.ok(!JSON.stringify(harness.getSession(session.id)).includes('mock-key-only-for-test'));
  await harness.updateSettings({ apiKey: '  whitespace-padded-secret  ' });
  const repeated = await runToEnd(harness, session.id);
  assert.equal(repeated.type, 'run.failed');
  assert.ok(!JSON.stringify(harness.getSession(session.id)).includes('whitespace-padded-secret'));
});

test('credentials split across streaming chunks never enter public delta events', async context => {
  const { baseUrl } = await mock(context, (request, response) => sse(response, [
    { choices: [{ delta: { content: 'A model echoed the key mock-key-' } }] },
    { choices: [{ delta: { content: 'only-for-test and then continued.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ]));
  const { harness, session } = await fixture(context, { provider: 'openai', baseUrl });
  const deltas = [];
  harness.on('event', event => { if (event.type === 'assistant.delta') deltas.push(event.data.text); });
  assert.equal((await runToEnd(harness, session.id)).type, 'run.completed');
  assert.equal(deltas.join(''), 'A model echoed the key [REDACTED] and then continued.');
  assert.ok(!JSON.stringify(harness.getSession(session.id)).includes('mock-key-only-for-test'));
});

test('provider network request is abortable and streaming timeout terminates a run', async context => {
  const { baseUrl } = await mock(context, (request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); });
  const first = await fixture(context, { provider: 'openai', baseUrl, providerTimeoutMs: 5000 });
  const terminal = runToEnd(first.harness, first.session.id);
  await new Promise(resolve => setTimeout(resolve, 100));
  await first.harness.cancelRun(first.session.id);
  assert.equal((await terminal).type, 'run.cancelled');
  const second = await fixture(context, { provider: 'openai', baseUrl, providerTimeoutMs: 150 });
  assert.equal((await runToEnd(second.harness, second.session.id)).type, 'run.failed');
});

test('non-length incomplete Responses fail explicitly without automatic continuation', async context => {
  const { baseUrl, requests } = await mock(context, (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial response' }] }] }));
  });
  const { harness, session } = await fixture(context, { provider: 'responses', baseUrl });
  const end = await runToEnd(harness, session.id);
  assert.equal(end.type, 'run.failed');
  assert.match(end.data.run.error, /content_filter/);
  assert.equal(requests.length, 1);
});

test('truncated SSE without protocol completion is a failure, never a fabricated success', async context => {
  const { baseUrl } = await mock(context, (request, response) => sse(response, [{ choices: [{ delta: { content: 'incomplete' } }] }]));
  const { harness, session } = await fixture(context, { provider: 'openai', baseUrl });
  const end = await runToEnd(harness, session.id);
  assert.equal(end.type, 'run.failed');
  assert.match(end.data.run.error, /意外中断/);
  assert.match(harness.getSession(session.id).messages.at(-1).content, /响应已中断/);
});

test('transient provider errors retry with bounded attempts', async context => {
  const { baseUrl, requests } = await mock(context, (request, response, count) => {
    if (count < 3) { response.writeHead(503); response.end('temporarily unavailable'); }
    else sse(response, [{ choices: [{ delta: { content: 'Recovered' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]);
  });
  const { harness, session } = await fixture(context, { provider: 'openai', baseUrl });
  assert.equal((await runToEnd(harness, session.id)).type, 'run.completed');
  assert.equal(requests.length, 3);
});

test('legacy token caps are ignored and long histories are summarized before continuing', async context => {
  const { baseUrl, requests } = await mock(context, (request, response) => sse(response, [{ choices: [{ delta: { content: 'Finished' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }]));
  const { harness, session } = await fixture(context, { provider: 'openai', baseUrl, maxRunTokens: 5, maxContextTokens: 4096, maxTokens: 100 });
  for (let index = 0; index < 15; index++) {
    harness.addMessage(harness.session(session.id), { role: 'user', content: `Old task ${index}: ${'background '.repeat(300)}` });
    harness.addMessage(harness.session(session.id), { role: 'assistant', content: 'An old response '.repeat(300) });
  }
  const end = await runToEnd(harness, session.id, 'Keep this latest task');
  assert.equal(end.type, 'run.completed', end.data.run.error);
  assert.ok(end.data.run.usage.inputTokens + end.data.run.usage.outputTokens > 5);
  assert.ok(requests.at(-1).body.messages.some(message => message.content.includes('会话已自动压缩')));
  assert.ok(requests.at(-1).body.messages.some(message => message.content.includes('Keep this latest task')));
  assert.ok(JSON.stringify(requests.at(-1).body.messages).length < 20000);
  assert.ok(harness.getSession(session.id).context.summary);
});

test('connection checks use all three native protocols with unsaved credentials and preserve state', async context => {
  const { baseUrl, requests } = await mock(context, (request, response) => {
    if (request.url === '/v1/chat/completions') sse(response, [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }]);
    else if (request.url === '/v1/messages') sse(response, [
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]);
    else sse(response, [{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 3, output_tokens: 1 } } }]);
  });
  const { harness, session } = await fixture(context, { provider: 'responses', baseUrl });
  const beforeSettings = harness.getSettings();
  const beforeSession = harness.getSession(session.id);
  for (const provider of ['responses', 'openai', 'anthropic']) {
    const result = await harness.testConnection({ provider, model: `${provider}-explicit-model`, apiKey: 'unsaved-probe-secret' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, provider);
    assert.equal(result.model, `${provider}-explicit-model`);
    assert.ok(result.latencyMs >= 0);
    const request = requests.at(-1);
    assert.equal(request.headers[provider === 'anthropic' ? 'x-api-key' : 'authorization'], provider === 'anthropic' ? 'unsaved-probe-secret' : 'Bearer unsaved-probe-secret');
    assert.equal(request.body[provider === 'responses' ? 'max_output_tokens' : 'max_tokens'], 128);
    if (provider !== 'responses') assert.equal(request.body.tools, undefined);
    assert.equal(request.body.model, `${provider}-explicit-model`);
  }
  assert.deepEqual(harness.getSettings(), beforeSettings);
  assert.deepEqual(harness.getSession(session.id), beforeSession);
  assert.equal(harness.listSessions().length, 1);
  assert.equal(requests.length, 3);
});

test('connection failures redact unsaved API keys and never change saved settings', async context => {
  const { baseUrl } = await mock(context, (request, response) => { response.writeHead(401); response.end(`Rejected ${request.headers.authorization}`); });
  const { harness } = await fixture(context, { provider: 'responses', baseUrl });
  const before = harness.getSettings();
  await assert.rejects(harness.testConnection({ apiKey: 'unsaved-sensitive-probe-key' }), error => error.statusCode === 502 && /HTTP 401/.test(error.message) && !error.message.includes('unsaved-sensitive-probe-key'));
  assert.deepEqual(harness.getSettings(), before);
});

test('connection checks obey timeouts and close cancels an active native request', async context => {
  let markRequested = () => {};
  const { baseUrl } = await mock(context, (request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); markRequested(); });
  const { harness } = await fixture(context, { provider: 'responses', baseUrl, providerTimeoutMs: 150 });
  await assert.rejects(harness.testConnection(), error => error.statusCode === 504 && /超时/.test(error.message));
  await harness.updateSettings({ providerTimeoutMs: 5000 });
  const requested = new Promise(resolve => { markRequested = resolve; });
  const probe = harness.testConnection();
  const rejected = assert.rejects(probe, error => error.name === 'AbortError' && error.statusCode === 499);
  await requested;
  await harness.close();
  await rejected;
});

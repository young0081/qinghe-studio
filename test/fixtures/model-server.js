import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { testCompletion } from './completion.js';

function textContent(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter(block => ['text', 'input_text', 'output_text'].includes(block.type)).map(block => block.text ?? '').join('');
}

function commonMessages(provider, body) {
  if (provider === 'openai') {
    return body.messages.map(message => ({ role: message.role, content: textContent(message.content), ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}), ...(message.tool_calls?.length ? { toolCalls: message.tool_calls.map(call => ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) })) } : {}) }));
  }
  if (provider === 'anthropic') {
    const messages = [];
    for (const message of body.messages) {
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      for (const block of blocks.filter(item => item.type === 'tool_result')) messages.push({ role: 'tool', toolCallId: block.tool_use_id, content: textContent(block.content) });
      const content = textContent(blocks);
      const toolCalls = blocks.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, args: block.input }));
      if (content || toolCalls.length) messages.push({ role: message.role, content, ...(toolCalls.length ? { toolCalls } : {}) });
    }
    return messages;
  }
  const messages = [];
  for (const item of typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input ?? []) {
    if (item.type === 'function_call_output') messages.push({ role: 'tool', toolCallId: item.call_id, content: item.output });
    else if (item.type === 'function_call') {
      const previous = messages.at(-1);
      const message = previous?.role === 'assistant' ? previous : { role: 'assistant', content: '' };
      if (message !== previous) messages.push(message);
      message.toolCalls ??= [];
      message.toolCalls.push({ id: item.call_id, name: item.name, args: JSON.parse(item.arguments) });
    } else if (item.role) messages.push({ role: item.role, content: textContent(item.content) });
  }
  return messages;
}

function responseOutput(result) {
  const output = [];
  if (result.content) output.push({ id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: result.content, annotations: [] }] });
  for (const call of result.toolCalls) output.push({ id: `fc_${randomUUID()}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
  return output;
}

async function sendResponse(response, provider, result, model, stream, chunkDelayMs) {
  const id = `test_${randomUUID()}`;
  const usage = { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens };
  const chunks = result.content.match(/.{1,24}/gs) ?? [];
  const chatCalls = result.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }));
  const blocks = [...(result.content ? [{ type: 'text', text: result.content }] : []), ...result.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))];
  const finishReason = result.toolCalls.length ? 'tool_calls' : 'stop';
  const output = responseOutput(result);
  if (!stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    const body = provider === 'responses'
      ? { id, object: 'response', status: 'completed', output, usage }
      : provider === 'openai'
        ? { id, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: result.content, ...(chatCalls.length ? { tool_calls: chatCalls } : {}) }, finish_reason: finishReason }], usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens } }
        : { id, type: 'message', role: 'assistant', model, content: blocks, usage, stop_reason: result.toolCalls.length ? 'tool_use' : 'end_turn' };
    response.end(JSON.stringify(body));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const sendChunks = async createEvent => {
    for (const chunk of chunks) {
      if (response.destroyed) return;
      if (chunkDelayMs) await new Promise(resolve => setTimeout(resolve, chunkDelayMs));
      send(createEvent(chunk));
    }
  };
  if (provider === 'responses') {
    for (const [index, item] of output.entries()) {
      send({ type: 'response.output_item.added', output_index: index, item: item.type === 'function_call' ? { ...item, arguments: '' } : item });
      if (item.type === 'message') await sendChunks(chunk => ({ type: 'response.output_text.delta', output_index: index, content_index: 0, delta: chunk }));
      else send({ type: 'response.function_call_arguments.delta', output_index: index, delta: item.arguments });
      send({ type: 'response.output_item.done', output_index: index, item });
    }
    send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output, usage } });
  } else if (provider === 'openai') {
    for (const chunk of chunks) send({ id, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
    for (const [index, call] of chatCalls.entries()) send({ id, model, choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] }, finish_reason: null }] });
    send({ id, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens } });
    response.write('data: [DONE]\n\n');
  } else {
    send({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } });
    for (const [index, block] of blocks.entries()) {
      send({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
      if (block.type === 'text') for (const chunk of chunks) send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } });
      else send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      send({ type: 'content_block_stop', index });
    }
    send({ type: 'message_delta', delta: { stop_reason: result.toolCalls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: usage.output_tokens } });
    send({ type: 'message_stop' });
  }
  response.end();
}

export async function startModelServer({ port = 0, apiKey = 'test-key', chunkDelayMs = 0, models = [{ id: 'test-model', name: 'Test Model' }, { id: 'discovered-small', name: 'Discovered Small' }, { id: 'discovered-large', name: 'Discovered Large' }] } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/automation-fixture') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><title>Harness Browser Fixture</title><body style="background:#f7f9e9;color:#4c6839;font:22px sans-serif;padding:50px"><h1>Pixel Browser</h1><label>Name <input aria-label="Name" style="font:20px sans-serif;padding:8px"></label><button style="font:20px sans-serif;padding:8px 18px" onclick="const value=document.querySelector(\'input\').value;document.querySelector(\'output\').textContent=value;document.title=\'Saved: \'+value">Save</button><p><output style="font-size:28px"></output></p><div id="clock" style="padding:20px;width:270px;font:22px monospace;background:#e7edd5"></div><script>let tick=0;setInterval(()=>{const clock=document.getElementById(\'clock\');clock.textContent=\'LIVE FRAME \'+(++tick);clock.style.borderLeft=\'12px solid hsl(\'+tick*19+\',40%,55%)\'},120)</script></body></html>');
        return;
      }
      if (request.method === 'GET' && new URL(request.url, 'http://localhost').pathname === '/v1/models') {
        const authentication = request.headers['x-api-key'] === undefined ? 'bearer' : 'x-api-key';
        requests.push({ path: '/v1/models', method: 'GET', body: null, authentication, anthropicVersion: request.headers['anthropic-version'] ?? null });
        const authorized = authentication === 'x-api-key' ? request.headers['x-api-key'] === apiKey && request.headers['anthropic-version'] === '2023-06-01' : request.headers.authorization === `Bearer ${apiKey}`;
        response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
        response.end(JSON.stringify(authorized ? { object: 'list', data: models.map(model => ({ id: model.id, name: model.name, display_name: model.name, object: 'model', type: 'model', owned_by: 'harness-test', created: 1704067200, created_at: '2024-01-01T00:00:00Z' })), has_more: false, first_id: models[0]?.id ?? null, last_id: models.at(-1)?.id ?? null } : { error: { message: 'Invalid test API key' }, type: 'error' }));
        return;
      }
      const provider = { '/v1/responses': 'responses', '/v1/chat/completions': 'openai', '/v1/messages': 'anthropic', '/v1/systemone': 'systemone' }[request.url];
      if (request.method !== 'POST' || !provider) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Unknown test endpoint' } }));
        return;
      }
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 8 * 1024 * 1024) throw new Error('Test request is too large');
      }
      const body = JSON.parse(raw);
      requests.push({ path: request.url, body });
      const authorized = provider === 'anthropic' ? request.headers['x-api-key'] === apiKey : request.headers.authorization === `Bearer ${apiKey}`;
      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Invalid test API key' }, type: 'error' }));
        return;
      }
      if (provider === 'systemone') {
        const answers = Object.fromEntries(Object.entries(body.questions).map(([name, question]) => {
          const preferred = name === 'model' ? body.state.phase === 'start' ? 'm0' : body.state.phase === 'summary' ? 'm2' : 'm1' : name === 'direction' ? body.state.phase === 'summary' ? 'summarize' : 'inspect' : name === 'tool' && body.state.phase === 'start' ? 'list_files' : 'none';
          return [name, { type: 'choice', choice: Object.hasOwn(question.criteria, preferred) ? preferred : Object.keys(question.criteria)[0], confidence: 0.95 }];
        }));
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 12, output_tokens: 0 } }));
        return;
      }
      if (body.model.startsWith('route-')) {
        const tools = body.model === 'route-reader' ? [{ id: 'route-list', name: 'list_files', args: { path: '.' } }] : [];
        const content = body.model === 'route-writer' ? '智能路由验证完成：已查看工作区，由总结模型汇报结果。' : body.model === 'route-coder' ? '工作区检查已完成。' : '';
        await sendResponse(response, provider, { content, toolCalls: tools, usage: { inputTokens: 11, outputTokens: 5 }, finishReason: tools.length ? 'tool_calls' : 'stop' }, body.model, body.stream !== false, chunkDelayMs);
        return;
      }
      const result = body.tools?.length
        ? await testCompletion({ provider, model: body.model }, { messages: commonMessages(provider, body), system: body.instructions ?? body.system ?? '', tools: body.tools, signal: new AbortController().signal, onDelta() {} })
        : { content: 'Connection ready.', toolCalls: [], usage: { inputTokens: 3, outputTokens: 3 }, finishReason: 'stop' };
      await sendResponse(response, provider, result, body.model, body.stream !== false, chunkDelayMs);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    }),
  };
}

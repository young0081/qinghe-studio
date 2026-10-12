import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { attachMcp } from '../src/integrations/mcp.js';

test('MCP discovers and executes real stdio tools, requiring explicit enablement and approval', async context => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'harness-mcp-'));
  const tools = new Map();
  const cleanup = [];
  const harness = {
    workspace,
    registerTool(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
    registerCleanup(callback) { cleanup.push(callback); },
  };
  context.after(async () => { for (const close of cleanup) await close(); await rm(workspace, { recursive: true, force: true }); });
  await mkdir(path.join(workspace, '.harness'));
  await writeFile(path.join(workspace, '.harness', 'mcp.json'), JSON.stringify({ mcpServers: {
    disabled: { command: 'nonexistent-command' },
    example: { enabled: true, command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url))] },
  } }));
  await attachMcp(harness);
  assert.equal(harness.extensions.find(extension => extension.name === 'disabled').status, 'disabled');
  assert.equal(harness.extensions.find(extension => extension.name === 'example').status, 'connected');
  const tool = tools.get('mcp_example_echo');
  assert.equal(tool.requiresApproval, true);
  assert.deepEqual(await tool.execute({ message: 'MCP round trip' }, { signal: new AbortController().signal }), { content: 'MCP round trip' });
});

test('MCP malformed config reports an actionable state without breaking startup', async context => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'harness-mcp-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, '.harness'));
  await writeFile(path.join(workspace, '.harness', 'mcp.json'), '{');
  const harness = { workspace };
  await attachMcp(harness);
  assert.equal(harness.extensions[0].status, 'error');
  await writeFile(path.join(workspace, '.harness', 'mcp.json'), 'null');
  await attachMcp(harness);
  assert.equal(harness.extensions[0].status, 'error');
});

test('MCP Streamable HTTP discovers remote tools and returns real results', async context => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'harness-mcp-http-'));
  const service = new Server({ name: 'http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  service.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'status', description: 'Get test status', inputSchema: { type: 'object', properties: {} } }] }));
  service.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'HTTP transport verified' }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await service.connect(transport);
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      await transport.handleRequest(request, response, body);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tools = new Map();
  const cleanup = [];
  context.after(async () => {
    for (const close of cleanup) await close();
    await service.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(workspace, { recursive: true, force: true });
  });
  await mkdir(path.join(workspace, '.harness'));
  await writeFile(path.join(workspace, '.harness', 'mcp.json'), JSON.stringify({ mcpServers: { remote: { enabled: true, url: `http://127.0.0.1:${server.address().port}/mcp` } } }));
  const harness = { workspace, registerTool(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); }, registerCleanup(callback) { cleanup.push(callback); } };
  await attachMcp(harness);
  assert.equal(harness.extensions[0].status, 'connected');
  assert.deepEqual(await tools.get('mcp_remote_status').execute({}, { signal: new AbortController().signal }), { content: 'HTTP transport verified' });
});

test('legacy SSE connects with configured headers and does not return credentials', async context => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'harness-mcp-sse-'));
  const service = new Server({ name: 'sse-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  service.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
  service.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'SSE verified' }] }));
  let transport;
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer sse-private') { response.writeHead(401); response.end(); return; }
    try {
      if (request.method === 'GET') { transport = new SSEServerTransport('/messages', response); await service.connect(transport); }
      else await transport.handlePostMessage(request, response);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tools = new Map();
  const harness = { workspace, registerTool(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } };
  context.after(async () => { await harness.mcp?.close(); await service.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(workspace, { recursive: true, force: true }); });
  await mkdir(path.join(workspace, '.harness'));
  await writeFile(path.join(workspace, '.harness', 'mcp.json'), JSON.stringify({ mcpServers: { legacy: { enabled: true, transport: 'sse', url: `http://127.0.0.1:${server.address().port}/sse`, headers: { Authorization: 'Bearer sse-private' } } } }));
  await attachMcp(harness);
  assert.equal(harness.mcp.publicState().servers[0].status, 'connected');
  assert.doesNotMatch(JSON.stringify(harness.mcp.publicState()), /sse-private/);
  assert.deepEqual(await tools.get('mcp_legacy_echo').execute({}, { signal: new AbortController().signal }), { content: 'SSE verified' });
});

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'test-tools', version: '1.0.0' }, { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } });
let extraTool = false;
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Return a supplied message', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }, ...(extraTool ? [{ name: 'extra', inputSchema: { type: 'object' } }] : [])] }));
server.setRequestHandler(CallToolRequestSchema, async (request, { signal }) => {
  const message = request.params.arguments.message;
  if (message === '__slow__') await new Promise(resolve => { const timer = setTimeout(resolve, 10000); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
  if (message === '__shutdown__') setTimeout(() => process.exit(0), 50);
  if (message === '__refresh__') { extraTool = true; await server.notification({ method: 'notifications/tools/list_changed' }); }
  return { content: [{ type: 'text', text: message === 'credential' ? process.env.MCP_FIXTURE_SECRET || 'missing' : message || 'extra' }] };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'fixture://guide', name: 'Fixture guide' }] }));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: 'fixture://guide', text: 'Resource round trip verified' }] }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'review', description: 'Review fixture', arguments: [{ name: 'topic', required: true }] }] }));
server.setRequestHandler(GetPromptRequestSchema, async request => ({ messages: [{ role: 'user', content: { type: 'text', text: `Review ${request.params.arguments.topic}` } }] }));
await server.connect(new StdioServerTransport());

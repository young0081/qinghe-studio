import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { atomicJson } from '../core/settings.js';
import { VERSION } from '../version.js';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 10);
const serverName = name => {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_ .-]{1,80}$/u.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) fail('MCP 名称须为 1–80 个字母、数字、空格、点、下划线或连字符');
  return name;
};
const token = (value, length) => /^[a-zA-Z0-9_-]+$/.test(value) && value.length <= length ? value : `${value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, length - 11)}_${hash(value)}`;

function configuration(input, previous = {}) {
  if (!object(input)) fail('MCP 配置必须是对象');
  const next = { ...previous };
  for (const key of ['command', 'args', 'url', 'transport', 'envAllow', 'tokenEnv', 'enabled']) if (Object.hasOwn(input, key)) next[key] = input[key];
  if (input.type && !input.transport) next.transport = input.type;
  next.transport ||= next.url ? 'http' : 'stdio';
  if (next.transport === 'streamable-http') next.transport = 'http';
  if (!['stdio', 'http', 'sse'].includes(next.transport)) fail('MCP transport 必须是 stdio、http 或 sse');
  if (next.enabled !== undefined && typeof next.enabled !== 'boolean') fail('enabled 必须为布尔值');
  next.enabled = next.enabled === true;
  if (next.transport === 'stdio') {
    if (typeof next.command !== 'string' || !next.command.trim() || next.command.length > 4096 || next.command.includes('\0')) fail('请填写 MCP 启动命令');
    if (next.args !== undefined && (!Array.isArray(next.args) || next.args.length > 128 || next.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')))) fail('MCP args 必须是字符串数组');
    delete next.url;
  } else {
    let url;
    try { url = new URL(next.url); } catch { fail('请填写有效的 MCP URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('MCP URL 须为 HTTP(S)，认证请使用 headers 或 tokenEnv，不要写入 URL');
    delete next.command;
    delete next.args;
  }
  if (next.envAllow !== undefined && (!Array.isArray(next.envAllow) || next.envAllow.length > 64 || next.envAllow.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))) fail('envAllow 必须是环境变量名称数组');
  if (next.tokenEnv !== undefined && (typeof next.tokenEnv !== 'string' || next.tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(next.tokenEnv))) fail('tokenEnv 必须是环境变量名称');
  for (const key of ['env', 'headers']) {
    const values = input.clearSecrets === true ? {} : { ...(previous[key] || {}) };
    if (input[key] !== undefined) {
      if (!object(input[key]) || Object.keys(input[key]).length > 64) fail(`${key} 必须是至多 64 项的对象`);
      for (const [name, value] of Object.entries(input[key])) {
        if (!(key === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z0-9_-]+$/).test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) fail(`${key} 包含无效名称`);
        if (value === null) { delete values[name]; continue; }
        if (typeof value !== 'string' || value.length > 8192 || /\x00/.test(value) || key === 'headers' && /[\r\n]/.test(value)) fail(`${key} 值无效`);
        if (value || !Object.hasOwn(values, name)) values[name] = value;
      }
    }
    if (Object.keys(values).length > 64) fail(`${key} 超过 64 项`);
    next[key] = values;
  }
  return next;
}

export class McpManager {
  constructor(harness) {
    this.harness = harness;
    this.filename = path.join(harness.dataDir || path.join(harness.workspace, '.harness'), 'mcp.json');
    this.servers = {};
    this.connections = new Map();
    this.states = new Map();
    this.queue = Promise.resolve();
    this.error = null;
    this.closed = false;
  }

  changed() {
    const values = [...this.states.values()].map(value => structuredClone(value));
    this.harness.extensions = this.harness.sanitize ? this.harness.sanitize(values) : values;
    if (this.error) this.harness.extensions.unshift({ name: 'MCP', status: 'error', error: this.error });
    this.harness.extensionsChanged?.();
  }

  rememberSecrets(config) {
    for (const value of [...Object.values(config.env || {}), ...Object.values(config.headers || {}), ...(config.envAllow || []).map(key => process.env[key]), process.env[config.tokenEnv]]) {
      if (value) this.harness.redactionSecrets?.add(value);
      if (value?.startsWith('Bearer ')) this.harness.redactionSecrets?.add(value.slice(7));
    }
  }

  publicState() {
    const result = { error: this.error, servers: Object.entries(this.servers).map(([name, config]) => {
      const { env, headers, ...safe } = config;
      return { name, configuration: safe, envKeys: Object.keys(env || {}), headerKeys: Object.keys(headers || {}), ...(this.states.get(name) || { status: 'disabled', tools: [] }) };
    }) };
    return this.harness.sanitize ? this.harness.sanitize(result) : result;
  }

  async safeFile() {
    for (const target of [path.dirname(this.filename), this.filename]) {
      try { if ((await lstat(target)).isSymbolicLink()) fail('MCP 配置不能是符号链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async start() {
    try {
      await this.safeFile();
      let text;
      try {
        if ((await lstat(this.filename)).size > 1024 * 1024) throw new Error();
        text = await readFile(this.filename, 'utf8');
      } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const stored = JSON.parse(text);
      if (!object(stored?.mcpServers) || Object.keys(stored.mcpServers).length > 16) throw new Error();
      for (const [name, config] of Object.entries(stored.mcpServers)) {
        serverName(name);
        this.servers[name] = configuration(config);
        this.rememberSecrets(this.servers[name]);
      }
    } catch {
      this.servers = {};
      this.error = '无法读取 mcp.json：请检查 JSON 格式、服务器配置、文件大小及符号链接；修复后点击重新加载。';
      this.changed();
      return;
    }
    await Promise.all(Object.keys(this.servers).map(name => this.connect(name)));
    this.changed();
  }

  serial(operation) {
    const pending = this.queue.catch(() => {}).then(async () => {
      if (this.closed || this.harness.closed) fail('工作区已关闭', 409);
      await operation();
      return this.publicState();
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  async persist(next) {
    if (this.error) fail('请先修复 mcp.json 并重新加载，以免覆盖现有配置', 409);
    await this.safeFile();
    if (Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024) fail('MCP 配置超过 1 MiB');
    await atomicJson(this.filename, { mcpServers: next });
    this.servers = next;
    for (const config of Object.values(next)) this.rememberSecrets(config);
  }

  save(name, input, create = false) {
    return this.serial(async () => {
      serverName(name);
      if (create && Object.hasOwn(this.servers, name)) fail('同名 MCP 已存在', 409);
      if (!create && !Object.hasOwn(this.servers, name)) fail('MCP 不存在', 404);
      if (create && Object.keys(this.servers).length >= 16) fail('最多配置 16 个 MCP 服务器');
      const next = configuration(input, this.servers[name]);
      await this.persist({ ...this.servers, [name]: next });
      await this.disconnect(name);
      await this.connect(name);
    });
  }

  import(input) {
    return this.serial(async () => {
      if (!object(input.mcpServers) || !Object.keys(input.mcpServers).length) fail('请提供包含 mcpServers 的 JSON 对象');
      const next = { ...this.servers };
      for (const [name, config] of Object.entries(input.mcpServers)) {
        serverName(name);
        if (Object.hasOwn(next, name)) fail('导入存在同名 MCP，请先重命名', 409);
        next[name] = configuration({ ...config, enabled: false });
      }
      if (Object.keys(next).length > 16) fail('最多配置 16 个 MCP 服务器');
      await this.persist(next);
      for (const name of Object.keys(input.mcpServers)) this.states.set(name, { name, status: 'disabled', tools: [] });
      this.changed();
    });
  }

  remove(name) {
    return this.serial(async () => {
      if (!Object.hasOwn(this.servers, name)) fail('MCP 不存在', 404);
      const next = { ...this.servers };
      delete next[name];
      await this.persist(next);
      await this.disconnect(name);
      this.states.delete(name);
      this.changed();
    });
  }

  reconnect(name) {
    return this.serial(async () => {
      if (!this.servers[name]?.enabled) fail('请先启用 MCP', 409);
      await this.disconnect(name);
      await this.connect(name);
    });
  }

  reload() { return this.serial(async () => { for (const name of this.connections.keys()) await this.disconnect(name); this.states.clear(); this.servers = {}; this.error = null; await this.start(); }); }

  async disconnect(name) {
    const connection = this.connections.get(name);
    this.connections.delete(name);
    if (!connection) return;
    connection.unregister.splice(0).forEach(remove => remove());
    connection.client.onclose = undefined;
    await connection.client.close().catch(() => {});
  }

  async pages(client, method, key) {
    const results = [];
    const seen = new Set();
    let cursor;
    for (let pageNumber = 0; pageNumber < 16; pageNumber++) {
      const page = await client[method](cursor ? { cursor } : {}, { timeout: 5000 });
      results.push(...page[key]);
      cursor = page.nextCursor;
      if (!cursor || results.length >= 128) return results.slice(0, 128);
      if (seen.has(cursor)) throw new Error('MCP pagination repeated');
      seen.add(cursor);
    }
    return results.slice(0, 128);
  }

  async discover(name, connection) {
    const { client } = connection;
    const capabilities = client.getServerCapabilities() || {};
    const discovered = capabilities.tools ? await this.pages(client, 'listTools', 'tools') : [];
    const resources = capabilities.resources ? await this.pages(client, 'listResources', 'resources') : [];
    const prompts = capabilities.prompts ? await this.pages(client, 'listPrompts', 'prompts') : [];
    if (this.connections.get(name) !== connection) return;
    const prefix = `mcp_${token(name, 24)}_`;
    const definitions = discovered.map(tool => ({
      name: prefix + token(tool.name, 64 - prefix.length),
      description: `[MCP: ${name}] ${(tool.description || tool.name).slice(0, 4000)}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} }, requiresApproval: true,
      execute: async (args, { signal }) => {
        const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: 60000 });
        const content = (result.content || []).map(item => item.type === 'text' ? item.text : item.type === 'resource_link' ? `${item.name}: ${item.uri}` : item.type === 'resource' && item.resource?.text ? item.resource.text : `[${item.type} content]`).join('\n');
        if (result.isError) throw new Error(content.slice(0, 16000) || 'MCP tool failed');
        return { content: content.slice(0, 64000) };
      },
    }));
    if (capabilities.resources) definitions.push({
      name: `${prefix}resource_${hash(name)}`, description: `读取 MCP ${name} 资源。可用资源：${JSON.stringify(resources.map(item => ({ uri: item.uri, name: item.name }))).slice(0, 6000)}`,
      parameters: { type: 'object', properties: { uri: { type: 'string', description: 'MCP 资源 URI' } }, required: ['uri'], additionalProperties: false }, requiresApproval: true,
      execute: async (args, { signal }) => {
        const result = await client.readResource({ uri: args.uri }, { signal, timeout: 60000 });
        return { content: result.contents.map(item => item.text || `[二进制资源 ${item.mimeType || ''}: ${item.uri}]`).join('\n').slice(0, 64000) };
      },
    });
    if (capabilities.prompts) definitions.push({
      name: `${prefix}prompt_${hash(name)}`, description: `读取 MCP ${name} 提示模板（作为任务参考）。可用模板：${JSON.stringify(prompts).slice(0, 6000)}`,
      parameters: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['name'], additionalProperties: false }, requiresApproval: true,
      execute: async (args, { signal }) => ({ content: JSON.stringify(await client.getPrompt(args, { signal, timeout: 60000 })).slice(0, 64000) }),
    });
    if (new Set(definitions.map(tool => tool.name)).size !== definitions.length) throw new Error('MCP tool names collide');
    connection.unregister.splice(0).forEach(remove => remove());
    try {
      for (const tool of definitions) {
        const execute = tool.execute;
        connection.unregister.push(this.harness.registerTool({ ...tool, execute: (...args) => {
          if (this.connections.get(name) !== connection) fail('MCP 已断开连接，请重连后重试', 409);
          return execute(...args);
        } }));
      }
    } catch (error) { connection.unregister.splice(0).forEach(remove => remove()); throw error; }
    this.states.set(name, { name, status: 'connected', tools: definitions.map(tool => tool.name), resources: resources.map(item => ({ name: item.name, uri: item.uri })), prompts: prompts.map(item => ({ name: item.name, description: item.description })) });
    this.changed();
  }

  async connect(name) {
    const config = this.servers[name];
    this.states.set(name, { name, status: config.enabled ? 'connecting' : 'disabled', tools: [] });
    this.changed();
    if (!config.enabled) return;
    const client = new Client({ name: 'qinghe-studio', version: VERSION }, { capabilities: {} });
    const connection = { client, unregister: [] };
    this.connections.set(name, connection);
    let timer;
    try {
      let transport;
      if (config.transport === 'stdio') {
        const env = { ...config.env };
        for (const key of config.envAllow || []) if (process.env[key] !== undefined && !Object.hasOwn(env, key)) env[key] = process.env[key];
        transport = new StdioClientTransport({ command: config.command, args: config.args || [], cwd: this.harness.workspace, env, stderr: 'pipe' });
      } else {
        const headers = { ...config.headers };
        if (config.tokenEnv && process.env[config.tokenEnv]) headers.Authorization = `Bearer ${process.env[config.tokenEnv]}`;
        const options = { requestInit: { headers, redirect: 'error' }, eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, ...headers }, redirect: 'error' }) } };
        transport = config.transport === 'sse' ? new SSEClientTransport(new URL(config.url), options) : new StreamableHTTPClientTransport(new URL(config.url), options);
      }
      const connecting = client.connect(transport);
      transport.stderr?.resume();
      const operation = async () => { await connecting; await this.discover(name, connection); };
      await Promise.race([operation(), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('MCP connection timed out')), 15000); timer.unref(); })]);
      client.onclose = () => {
        if (this.connections.get(name) !== connection) return;
        this.connections.delete(name);
        connection.unregister.splice(0).forEach(remove => remove());
        this.states.set(name, { name, status: 'error', tools: [], error: '连接已断开，请检查服务后重连。' });
        this.changed();
      };
      if (client.getServerCapabilities()?.tools?.listChanged) client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.serial(async () => {
        if (this.connections.get(name) !== connection) return;
        try { await this.discover(name, connection); }
        catch { await this.disconnect(name); this.states.set(name, { name, status: 'error', tools: [], error: '工具列表更新失败，请重连。' }); this.changed(); }
      }).catch(() => {}));
    } catch (error) {
      await this.disconnect(name);
      this.states.set(name, { name, status: 'error', tools: [], error: error.message.includes('timed out') ? 'MCP 连接超时，请检查服务是否可用。' : 'MCP 连接失败，请检查命令、依赖、传输协议、地址和认证配置。' });
      this.changed();
    } finally { clearTimeout(timer); }
  }

  async close() { this.closed = true; await this.queue; for (const name of this.connections.keys()) await this.disconnect(name); }
}

export async function attachMcp(harness) {
  await harness.mcp?.close();
  harness.extensions = [];
  harness.mcp = new McpManager(harness);
  harness.registerCleanup?.(() => harness.mcp.close());
  await harness.mcp.start();
}

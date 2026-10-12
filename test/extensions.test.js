import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { createHarness } from '../src/core/harness.js';
import { startServer } from '../src/server.js';

const content = '---\nname: reviewer\ndescription: Review a project carefully.\n---\n\nUnique full instructions; read references/check.md.\n';
const mcpFixture = fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url));
const config = { command: process.execPath, args: [mcpFixture], enabled: true };

async function fixture(context, options = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'qinghe-extensions-'));
  const harness = await createHarness({ workspace, globalConfigDir: path.join(workspace, 'global'), settings: { provider: 'responses', model: 'test-model', apiKey: 'test-key' }, ...options });
  context.after(async () => { await harness.close(); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { workspace, harness };
}

test('skill packages import atomically, enable on demand, read references and persist across restart', async context => {
  const { harness, workspace } = await fixture(context);
  const events = [];
  harness.on('event', event => events.push(event));
  const zip = Buffer.from(zipSync({ 'reviewer/SKILL.md': strToU8(content), 'reviewer/references/check.md': strToU8('Check real tests first.') })).toString('base64');
  const skill = await harness.importSkill({ zip });
  assert.equal(skill.files.length, 2);
  assert.equal((await harness.listSkills())[0].enabled, false);
  await assert.rejects(harness.readSkill('reviewer'), /已停用/);
  await harness.updateSkill('reviewer', { enabled: true });
  const system = await harness.systemContext(harness.settings);
  assert.match(system, /Review a project carefully/);
  assert.doesNotMatch(system, /Unique full instructions/);
  assert.match((await harness.readSkill('reviewer')).content, /Unique full instructions/);
  assert.equal((await harness.readSkillFile({ name: 'reviewer', path: 'references/check.md', offset: 6, limit: 4 })).content, 'real');
  await harness.updateSkill('reviewer', { content: content + '\nUpdated' });
  assert.equal((await harness.getSkill('reviewer')).files.length, 2);
  assert.ok(events.some(event => event.type === 'extensions.updated' && !event.sessionId));
  await harness.close();
  const reopened = await createHarness({ workspace, globalConfigDir: path.join(workspace, 'global') });
  context.after(() => reopened.close());
  assert.equal((await reopened.listSkills())[0].enabled, true);
  await reopened.deleteSkill('reviewer');
  assert.deepEqual(await reopened.listSkills(), []);
  await reopened.close();
});

test('skill import rejects traversal, duplicates, oversize packages and symbolic links without overwriting', async context => {
  const { harness, workspace } = await fixture(context);
  await harness.importSkill({ content });
  await assert.rejects(harness.importSkill({ content: content + 'overwrite' }), { statusCode: 409 });
  await assert.rejects(harness.importSkill({ name: '__proto__', content }), /技能名称/);
  assert.equal((await harness.getSkill('reviewer')).content, content);
  const encode = value => Buffer.from(value).toString('base64');
  for (const extra of ['../escape.txt', 'references/../../escape', 'CON', 'x:stream', 'references\\file']) {
    await assert.rejects(harness.importSkill({ name: 'another', files: [{ path: 'SKILL.md', data: encode(content) }, { path: extra, data: encode('no') }] }));
  }
  await assert.rejects(harness.importSkill({ name: 'another', files: [{ path: 'SKILL.md', data: encode(content) }, { path: 'skill.md', data: encode('no') }] }), /重复/);
  const zip = Buffer.from(zipSync({ 'SKILL.md': strToU8(content), 'bomb.txt': new Uint8Array(3 * 1024 * 1024) })).toString('base64');
  await assert.rejects(harness.importSkill({ name: 'another', zip }), /超过/);
  await harness.updateSkill('reviewer', { enabled: true });
  await mkdir(path.join(workspace, 'outside'));
  await writeFile(path.join(workspace, 'outside', 'private.txt'), 'private');
  await symlink(path.join(workspace, 'outside'), path.join(harness.dataDir, 'skills', 'reviewer', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(harness.readSkillFile({ name: 'reviewer', path: 'linked/private.txt' }), /符号链接/);
  await assert.rejects(harness.readSkillFile({ name: 'reviewer', path: '../outside' }), /路径/);
  await harness.deleteSkill('reviewer');
  assert.equal(await readFile(path.join(workspace, 'outside', 'private.txt'), 'utf8'), 'private');
});

test('MCP live CRUD handles real tools/resources/prompts, preserves credentials and removes stale handles', async context => {
  const { harness, workspace } = await fixture(context);
  await harness.saveMcp('local', { ...config, env: { MCP_FIXTURE_SECRET: 'mcp-secret-never-return' } }, true);
  let state = harness.getMcp();
  assert.equal(state.servers[0].status, 'connected');
  assert.doesNotMatch(JSON.stringify(state), /mcp-secret-never-return/);
  assert.equal(state.servers[0].resources.length, 1);
  const oldTool = harness.toolRegistry.get('mcp_local_echo');
  const options = { signal: new AbortController().signal };
  assert.deepEqual(await oldTool.execute({ message: 'real echo' }, options), { content: 'real echo' });
  const resource = harness.getTools().find(tool => tool.name.startsWith('mcp_local_resource_'));
  assert.match((await harness.toolRegistry.get(resource.name).execute({ uri: 'fixture://guide' }, options)).content, /Resource round trip/);
  const prompt = harness.getTools().find(tool => tool.name.startsWith('mcp_local_prompt_'));
  assert.match((await harness.toolRegistry.get(prompt.name).execute({ name: 'review', arguments: { topic: 'tests' } }, options)).content, /Review tests/);
  await harness.saveMcp('local', { enabled: false });
  assert.ok(!harness.getTools().some(tool => tool.name.startsWith('mcp_local_')));
  assert.throws(() => oldTool.execute({ message: 'stale' }, options), /断开/);
  await harness.saveMcp('local', { enabled: true, env: { MCP_FIXTURE_SECRET: '' } });
  assert.equal((await harness.toolRegistry.get('mcp_local_echo').execute({ message: 'credential' }, options)).content, 'mcp-secret-never-return');
  assert.doesNotMatch(harness.sanitize('mcp-secret-never-return'), /mcp-secret-never-return/);
  await harness.reconnectMcp('local');
  assert.equal(harness.getTools().filter(tool => tool.name === 'mcp_local_echo').length, 1);
  await harness.saveMcp('local', { env: { MCP_FIXTURE_SECRET: null } });
  assert.deepEqual(harness.getMcp().servers[0].envKeys, []);
  await harness.importMcp({ mcpServers: { imported: config } });
  assert.equal(harness.getMcp().servers.find(item => item.name === 'imported').status, 'disabled');
  await assert.rejects(harness.importMcp({ mcpServers: { fresh: config, imported: config } }), { statusCode: 409 });
  assert.ok(!harness.getMcp().servers.some(item => item.name === 'fresh'));
  await harness.saveMcp('a.b', config, true);
  await harness.saveMcp('a b', config, true);
  assert.equal(new Set(harness.getTools().map(tool => tool.name)).size, harness.getTools().length);
  await harness.deleteMcp('local');
  state = JSON.parse(await readFile(path.join(workspace, '.harness', 'mcp.json'), 'utf8'));
  assert.ok(!state.mcpServers.local);
});

test('extensions HTTP API validates inputs, retains broken config and reloads after repair', async context => {
  const { harness } = await fixture(context);
  const server = await startServer({ harness, port: 0 });
  context.after(() => server.close());
  const base = server.url;
  const request = (url, method = 'GET', body) => fetch(`${base}/api${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/skills', 'POST', { content })).status, 201);
  assert.equal((await (await request('/skills')).json())[0].name, 'reviewer');
  assert.equal((await request('/skills/reviewer', 'PATCH', { enabled: 'yes' })).status, 400);
  assert.equal((await request('/mcp', 'POST', { name: 'service', configuration: { ...config, enabled: false } })).status, 201);
  assert.equal((await request('/mcp/service/reconnect', 'POST', {})).status, 409);
  await writeFile(path.join(harness.dataDir, 'mcp.json'), '{broken');
  const invalid = await (await request('/mcp/reload', 'POST', {})).json();
  assert.ok(invalid.error);
  assert.equal((await request('/mcp', 'POST', { name: 'other', configuration: config })).status, 409);
  assert.equal(await readFile(path.join(harness.dataDir, 'mcp.json'), 'utf8'), '{broken');
  await writeFile(path.join(harness.dataDir, 'mcp.json'), '{"mcpServers":{}}');
  assert.equal((await (await request('/mcp/reload', 'POST', {})).json()).error, null);
});

test('MCP tool notifications, cancellation and unexpected process shutdown update the live registry', async context => {
  const { harness } = await fixture(context);
  await harness.saveMcp('live', config, true);
  const call = (message, signal = new AbortController().signal) => harness.toolRegistry.get('mcp_live_echo').execute({ message }, { signal });
  await call('__refresh__');
  for (let attempt = 0; attempt < 50 && !harness.toolRegistry.has('mcp_live_extra'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(harness.toolRegistry.has('mcp_live_extra'));
  const controller = new AbortController();
  const slow = call('__slow__', controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(slow);
  await call('__shutdown__');
  for (let attempt = 0; attempt < 100 && harness.toolRegistry.has('mcp_live_echo'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!harness.toolRegistry.has('mcp_live_echo'));
  assert.equal(harness.getMcp().servers[0].status, 'error');
  await harness.reconnectMcp('live');
  assert.equal(harness.getMcp().servers[0].status, 'connected');
});

test('runtime reads skill references and calls MCP under ask, exemptions and readonly', async context => {
  const completion = async (settings, { messages }) => {
    const results = messages.filter(message => message.role === 'tool');
    const calls = [{ name: 'read_skill', args: { name: 'reviewer' } }, { name: 'read_skill_file', args: { name: 'reviewer', path: 'references/check.md' } }, { name: 'mcp_local_echo', args: { message: 'Round trip task complete' } }];
    const call = calls[results.length];
    return { content: call ? '' : results.at(-1).content, toolCalls: call ? [{ id: `extension-${results.length}`, ...call }] : [], usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const { harness } = await fixture(context, { completion });
  await harness.importSkill({ enabled: true, files: [{ path: 'SKILL.md', data: Buffer.from(content).toString('base64') }, { path: 'references/check.md', data: Buffer.from('Verified real file').toString('base64') }] });
  await harness.saveMcp('local', config, true);
  const run = async (policy, autoApproveTools = []) => {
    await harness.updateSettings({ approval: policy, autoApproveTools });
    const session = await harness.createSession();
    let approvals = 0;
    const done = new Promise(resolve => {
      const listener = event => {
        if (event.sessionId !== session.id) return;
        if (event.type === 'approval.required') { approvals++; harness.resolveApproval(event.data.id, true); }
        if (/^run\.(completed|failed)$/.test(event.type)) { harness.off('event', listener); resolve(event); }
      };
      harness.on('event', listener);
    });
    await harness.run(session.id, 'Use reviewer and local echo');
    const terminal = await done;
    assert.equal(terminal.type, 'run.completed', JSON.stringify(terminal.data));
    return { session: harness.getSession(session.id), approvals };
  };
  const ask = await run('ask');
  assert.equal(ask.approvals, 1);
  assert.match(ask.session.messages.at(-1).content, /Round trip task complete/);
  assert.equal((await run('ask', ['mcp_local_echo'])).approvals, 0);
  const readonly = await run('readonly', ['mcp_local_echo']);
  assert.equal(readonly.approvals, 0);
  assert.doesNotMatch(readonly.session.messages.at(-1).content, /Round trip task complete/);
});

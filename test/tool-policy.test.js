import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarness } from '../src/core/harness.js';
import { validateSettings } from '../src/core/settings.js';
import { testCompletion } from './fixtures/completion.js';

function eventOnce(harness, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harness.off('event', listener); reject(new Error('event timeout')); }, 10000);
    const listener = event => { if (predicate(event)) { clearTimeout(timer); harness.off('event', listener); resolve(event); } };
    harness.on('event', listener);
  });
}

async function fixture(context, settings = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'qinghe-policy-'));
  const harness = await createHarness({ workspace, globalConfigDir: path.join(workspace, 'shared'), completion: testCompletion, settings: { provider: 'responses', model: 'test-model', apiKey: 'test-key', ...settings } });
  context.after(async () => { await harness.close(); await rm(workspace, { recursive: true, force: true, maxRetries: 5 }); });
  return { workspace, harness };
}

test('tool exemptions validate exact names and never accept wildcard or object policies', () => {
  assert.deepEqual(validateSettings({ autoApproveTools: ['browser', 'write_file', 'browser'] }).autoApproveTools, ['browser', 'write_file']);
  for (const value of [null, '*', ['*'], ['browser.*'], {}, [''], Array(257).fill('browser')]) assert.throws(() => validateSettings({ autoApproveTools: value }), /autoApproveTools/);
  assert.deepEqual(validateSettings({}).autoApproveTools, []);
});

test('one exempt tool executes while a different tool still requires approval', async context => {
  const { harness, workspace } = await fixture(context, { autoApproveTools: ['write_file'] });
  const approval = eventOnce(harness, event => event.type === 'approval.required');
  const done = eventOnce(harness, event => event.type === 'run.completed');
  const session = await harness.createSession();
  await harness.run(session.id, '[test:write] [test:command]');
  const pending = await approval;
  assert.equal(pending.data.tool, 'run_command');
  assert.match(await readFile(path.join(workspace, 'harness-test.txt'), 'utf8'), /Hello/);
  await harness.resolveApproval(pending.data.id, false);
  await done;
  assert.equal(harness.getSession(session.id).events.filter(event => event.type === 'approval.required').length, 1);
});

test('saving an exemption releases matching pending requests and persists across restart and scope changes', async context => {
  const { harness, workspace } = await fixture(context);
  const approval = eventOnce(harness, event => event.type === 'approval.required');
  const done = eventOnce(harness, event => event.type === 'run.completed');
  const session = await harness.createSession();
  await harness.run(session.id, '[test:write]');
  const pending = await approval;
  assert.equal(pending.data.tool, 'write_file');
  await harness.updateSettings({ autoApproveTools: ['write_file', 'browser'] });
  await done;
  assert.equal(harness.approvals.size, 0);
  const stored = JSON.parse(await readFile(path.join(workspace, '.harness/settings.json'), 'utf8'));
  assert.equal(stored.autoApproveTools, undefined);
  assert.deepEqual(stored.providerCatalog.autoApproveTools, ['browser', 'write_file']);
  await harness.setProviderScope('global');
  assert.deepEqual(harness.getSettings().autoApproveTools, ['browser', 'write_file']);
  await harness.setProviderScope('workspace');
  await harness.close();
  const reopened = await createHarness({ workspace, globalConfigDir: path.join(workspace, 'shared'), completion: testCompletion });
  try {
    assert.deepEqual(reopened.getSettings().autoApproveTools, ['browser', 'write_file']);
    await reopened.updateSettings({ autoApproveTools: [] });
    const next = await reopened.createSession();
    const request = eventOnce(reopened, event => event.type === 'approval.required');
    await reopened.run(next.id, '[test:write]');
    assert.equal((await request).data.tool, 'write_file');
    await reopened.cancelRun(next.id);
  } finally { await reopened.close(); }
});

test('readonly overrides exemptions, and tool policies include disabled automation and registered tools', async context => {
  const { harness, workspace } = await fixture(context, { approval: 'readonly', autoApproveTools: ['write_file', 'browser'] });
  const session = await harness.createSession();
  const done = eventOnce(harness, event => event.type === 'run.completed');
  await harness.run(session.id, '[test:write]');
  await done;
  await assert.rejects(readFile(path.join(workspace, 'harness-test.txt')), { code: 'ENOENT' });
  assert.equal(harness.autoApproves('write_file'), false);
  assert.equal(harness.getTools().some(tool => tool.name === 'browser'), false);
  assert.deepEqual(harness.getToolPolicies().find(tool => tool.name === 'browser').available, false);
  assert.equal(harness.getToolPolicies().find(tool => tool.name === 'web_fetch').requiresApproval, false);
  harness.registerTool({ name: 'mcp_fixture_read', description: 'MCP fixture', parameters: { type: 'object', properties: {} }, execute: () => ({ ok: true }) });
  assert.equal(harness.getToolPolicies().find(tool => tool.name === 'mcp_fixture_read').requiresApproval, true);
});

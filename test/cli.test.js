import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import { createHarness } from '../src/core/harness.js';
import { VERSION } from '../src/version.js';
import { startModelServer } from './fixtures/model-server.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function workspace(context) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-cli-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function configuredWorkspace(context, provider = 'responses') {
  const directory = await workspace(context);
  const model = await startModelServer();
  context.after(() => model.close());
  const harness = await createHarness({ workspace: directory });
  await harness.updateSettings({ provider, model: 'test-model', apiKey: 'test-key', baseUrl: model.url });
  await harness.close();
  return { directory, model };
}

function invoke(args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const environment = { ...process.env };
    for (const name of ['HARNESS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete environment[name];
    const child = spawn(process.execPath, [cliPath, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment, ...options });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); rejectRun(new Error(`CLI timed out: ${args[0]}\n${stderr}`)); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); rejectRun(error); });
    child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
    child.stdin.end();
  });
}

function events(result) {
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('argument parser accepts explicit literal prompts and rejects invalid or ambiguous options', () => {
  assert.equal(parseArgs(['run', 'hello', '--browser', '--computer']).options.computer, true);
  assert.deepEqual(parseArgs(['run', '--json', '--', '--this is prompt']), { command: 'run', args: ['--this is prompt'], options: { json: true } });
  assert.equal(parseArgs(['run', 'hello', '--provider', 'responses']).options.provider, 'responses');
  assert.throws(() => parseArgs(['run', 'hello', '--auto', '--readonly']), /不能同时/);
  assert.throws(() => parseArgs(['run', 'hello', '--provider', 'unknown']), /provider/);
  assert.throws(() => parseArgs(['run', 'hello', '--provider', 'demo']), /provider/);
  assert.throws(() => parseArgs(['run', 'hello', '--max-steps', '9']), /未知选项/);
  assert.throws(() => parseArgs(['run', '--session']), /需要一个值/);
  assert.throws(() => parseArgs(['web', '--port', '65536']), /整数/);
  assert.throws(() => parseArgs(['run', 'hello', '--wat']), /未知选项/);
});

test('non-interactive desktop operations are denied under ask', { skip: process.platform !== 'win32' }, async context => {
  const { directory } = await configuredWorkspace(context);
  const result = await invoke(['run', '[test:computer-deny]', '--workspace', directory, '--computer', '--json']);
  const output = events(result);
  assert.ok(output.some(event => event.type === 'approval.required'));
  assert.ok(output.some(event => event.type === 'approval.resolved' && event.data.status === 'denied'));
  assert.equal(output.some(event => event.type === 'tool.completed' && event.data.name === 'computer'), false);
});

test('help and version work without initializing a workspace', async context => {
  const directory = await workspace(context);
  const help = await invoke(['--help'], { cwd: directory });
  assert.equal(help.code, 0);
  assert.ok(help.stdout.startsWith(`青禾 Studio CLI ${VERSION}`));
  assert.match(help.stdout, /用法：harness/);
  assert.match(help.stdout, /OpenAI Responses/);
  assert.match(help.stdout, /Anthropic Messages/);
  assert.match(help.stdout, /sessions delete/);
  const version = await invoke(['--version'], { cwd: directory });
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), VERSION);
  assert.doesNotMatch(help.stdout, /demo/i);
  await assert.rejects(access(join(directory, '.harness')));
});

test('initialization and config persist safely without printing API credentials', async context => {
  const directory = await workspace(context);
  const project = join(directory, 'new project');
  const initialized = await invoke(['init', project, '--json']);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).workspace, project);
  const secret = 'test-cli-secret-that-must-not-appear';
  const changed = await invoke(['config', 'set', 'apiKey', secret, '--workspace', project, '--json']);
  assert.equal(changed.code, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).hasApiKey, true);
  assert.equal(changed.stdout.includes(secret), false);
  const provider = await invoke(['config', 'set', 'provider', 'responses', '--workspace', project]);
  assert.equal(JSON.parse(provider.stdout).provider, 'responses');
  const limits = await invoke(['config', 'set', 'maxContextTokens', '9000', '--workspace', project]);
  assert.equal(JSON.parse(limits.stdout).maxContextTokens, 9000);
  const current = await invoke(['config', '--workspace', project, '--json']);
  assert.equal(JSON.parse(current.stdout).provider, 'responses');
  assert.equal(current.stdout.includes(secret), false);
  const invalid = await invoke(['config', 'set', 'maxContextTokens', 'NaN', '--workspace', project, '--json']);
  assert.equal(invalid.code, 1);
  assert.match(JSON.parse(invalid.stderr).error, /数值/);
});

test('CLI tool exemptions accept comma separated names and can be cleared', async context => {
  const directory = await workspace(context);
  const added = await invoke(['config', 'set', 'autoApproveTools', 'browser,write_file', '--workspace', directory, '--json']);
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout).autoApproveTools, ['browser', 'write_file']);
  const cleared = await invoke(['config', 'set', 'autoApproveTools', '[]', '--workspace', directory, '--json']);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.deepEqual(JSON.parse(cleared.stdout).autoApproveTools, []);
});

test('CLI scopes share global providers across projects and preserve local credentials', async context => {
  const directory = await workspace(context);
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  const environment = { ...process.env, HARNESS_CONFIG_DIR: join(directory, 'global') };
  for (const key of ['HARNESS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete environment[key];
  const configure = async (project, args) => {
    const result = await invoke(['config', ...args, '--workspace', project, '--json'], { env: environment });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.includes('global-scope-private-key'), false);
    assert.equal(result.stdout.includes('workspace-scope-private-key'), false);
    return JSON.parse(result.stdout);
  };
  await configure(first, ['set', 'model', 'workspace-model']);
  await configure(first, ['set', 'apiKey', 'workspace-scope-private-key']);
  assert.equal((await configure(first, ['scope', 'global'])).activeScope, 'global');
  await configure(first, ['set', 'apiKey', 'global-scope-private-key']);
  assert.equal((await configure(first, ['set', 'model', 'global-model'])).model, 'global-model');
  await configure(second, ['scope', 'global']);
  const shared = await configure(second, []);
  assert.equal(shared.providerScope, 'global');
  assert.equal(shared.model, 'global-model');
  assert.equal(shared.hasApiKey, true);
  await configure(first, ['scope', 'workspace']);
  const local = await configure(first, []);
  assert.equal(local.model, 'workspace-model');
  assert.equal(local.hasApiKey, true);
  assert.equal(local.providerScope, 'workspace');
  const stored = await readFile(join(first, '.harness', 'settings.json'), 'utf8');
  assert.equal(stored.includes('global-scope-private-key'), false);
  const invalid = await invoke(['config', 'scope', 'both', '--workspace', first, '--json'], { env: environment });
  assert.equal(invalid.code, 1);
  assert.equal((await configure(first, ['scope'])).activeScope, 'workspace');
});

test('native Responses JSON events include tools, completion and persisted session continuation', async context => {
  const { directory, model } = await configuredWorkspace(context);
  await writeFile(join(directory, 'README.md'), '# Test workspace\n', 'utf8');
  const first = events(await invoke(['run', 'inspect project', '--json', '--workspace', directory]));
  assert.ok(first.some(event => event.type === 'tool.completed' && event.data.name === 'read_file'));
  assert.ok(first.some(event => event.type === 'assistant.delta'));
  assert.equal(first.at(-1).type, 'run.completed');
  assert.ok(model.requests.every(request => request.path === '/v1/responses'));
  const sessionId = first.at(-1).sessionId;
  const second = events(await invoke(['run', 'continue', '--session', sessionId, '--json', '--workspace', directory]));
  assert.equal(second.at(-1).sessionId, sessionId);
  const list = await invoke(['sessions', '--json', '--workspace', directory]);
  assert.equal(JSON.parse(list.stdout).length, 1);
  const shown = await invoke(['sessions', 'show', sessionId, '--workspace', directory]);
  const session = JSON.parse(shown.stdout);
  assert.equal(session.messages.filter(message => message.role === 'user').length, 2);
  assert.ok(session.plan.every(step => step.status === 'completed'));
  const deleted = await invoke(['sessions', 'delete', sessionId, '--workspace', directory, '--json']);
  assert.equal(JSON.parse(deleted.stdout).ok, true);
  const missing = await invoke(['sessions', 'show', sessionId, '--workspace', directory, '--json']);
  assert.equal(missing.code, 1);
  assert.ok(JSON.parse(missing.stderr).error);
});

test('non-interactive approval denies writes, explicit auto permits them and readonly blocks them', async context => {
  const { directory } = await configuredWorkspace(context);
  const denied = events(await invoke(['run', '[test:write]', '--json', '--workspace', directory]));
  assert.ok(denied.some(event => event.type === 'approval.resolved' && event.data.status === 'denied'));
  await assert.rejects(access(join(directory, 'harness-test.txt')));
  const allowed = events(await invoke(['run', '[test:write]', '--auto', '--json', '--workspace', directory]));
  assert.ok(allowed.some(event => event.type === 'checkpoint.created'));
  assert.match(await readFile(join(directory, 'harness-test.txt'), 'utf8'), /Harness test/);
  const { directory: readonlyDirectory } = await configuredWorkspace(context);
  const readonly = events(await invoke(['run', '[test:write]', '--readonly', '--json', '--workspace', readonlyDirectory]));
  assert.ok(readonly.some(event => event.type === 'tool.failed'));
  await assert.rejects(access(join(readonlyDirectory, 'harness-test.txt')));
});

test('release requires configuration and doctor reports missing model credentials', async context => {
  const directory = await workspace(context);
  const run = await invoke(['run', 'implement feature', '--workspace', directory, '--json']);
  assert.equal(run.code, 1);
  assert.match(JSON.parse(run.stderr).error, /配置/);
  assert.equal(run.stdout, '');
  const sessions = await invoke(['sessions', '--workspace', directory, '--json']);
  assert.deepEqual(JSON.parse(sessions.stdout), []);
  const report = await invoke(['doctor', '--workspace', directory, '--json']);
  assert.equal(report.code, 1);
  const diagnostics = JSON.parse(report.stdout);
  assert.equal(diagnostics.version, VERSION);
  assert.equal(diagnostics.configured, false);
  assert.equal(diagnostics.checks.find(check => check.name === 'API 密钥').ok, false);
  assert.equal(diagnostics.checks.find(check => check.name === '模型名').ok, false);
});

test('config test uses each native protocol and returns actionable failures without leaking keys', async context => {
  for (const [provider, endpoint] of [['responses', '/v1/responses'], ['openai', '/v1/chat/completions'], ['anthropic', '/v1/messages']]) {
    const { directory, model } = await configuredWorkspace(context, provider);
    const ping = await invoke(['config', 'test', '--workspace', directory, '--json']);
    assert.equal(ping.code, 0, ping.stderr);
    assert.equal(JSON.parse(ping.stdout).ok, true);
    assert.equal(model.requests.length, 1);
    assert.equal(model.requests[0].path, endpoint);
    assert.ok(!model.requests[0].body.tools?.length);
    const written = events(await invoke(['run', '[test:write]', '--auto', '--workspace', directory, '--json']));
    assert.ok(written.some(event => event.type === 'checkpoint.created'));
    assert.match(await readFile(join(directory, 'harness-test.txt'), 'utf8'), /Harness test/);
    assert.ok(model.requests.every(request => request.path === endpoint));
    await invoke(['config', 'set', 'apiKey', 'invalid-key', '--workspace', directory]);
    const failure = await invoke(['config', 'test', '--workspace', directory, '--json']);
    assert.equal(failure.code, 1);
    assert.match(JSON.parse(failure.stderr).error, /401/);
    assert.doesNotMatch(failure.stderr, /invalid-key/);
  }
});

test('non-TTY TUI exits with actionable help and unknown commands produce structured errors', async context => {
  const directory = await workspace(context);
  const fallback = await invoke(['tui', '--workspace', directory]);
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.match(fallback.stdout, /交互终端/);
  assert.match(fallback.stdout, /--json/);
  const unknown = await invoke(['nonexistent', '--json', '--workspace', directory]);
  assert.equal(unknown.code, 1);
  assert.match(JSON.parse(unknown.stderr).error, /未知命令/);
  const noPrompt = await invoke(['run', '--json', '--workspace', directory]);
  assert.equal(noPrompt.code, 1);
  assert.match(JSON.parse(noPrompt.stderr).error, /prompt/);
});

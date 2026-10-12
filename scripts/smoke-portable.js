import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createHarness } from '../src/core/harness.js';
import { VERSION } from '../src/version.js';
import { zipSync, strToU8 } from 'fflate';
import { startModelServer } from '../test/fixtures/model-server.js';
import { modelRow, openProviders, providerPage, readCatalog, returnToStudio, testModel } from '../test/browser/provider-helpers.js';
import { setReasoning } from '../test/browser/reasoning-helpers.js';
import { docx, documentText, dropFiles, pasteFiles, pdf, png, upload } from '../test/fixtures/attachments.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const delay = duration => new Promise(resolve => setTimeout(resolve, duration));

function optionsFor(argumentsList) {
  const options = { executable: process.env.HARNESS_GUI_EXECUTABLE || process.env.HARNESS_PORTABLE_EXECUTABLE || path.join(projectRoot, 'release', `runtime-${VERSION}`, 'win-unpacked', 'Harness Studio.exe'), screenshot: path.join(projectRoot, 'docs', 'screenshots', 'qinghe-gui-unpacked.png') };
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (argument === '--no-screenshot') { options.screenshot = null; continue; }
    if (!['--exe', '--screenshot'].includes(argument) || !argumentsList[index + 1] || argumentsList[index + 1].startsWith('--')) throw new Error('用法：node scripts/smoke-portable.js [--exe PATH] [--screenshot PATH | --no-screenshot]');
    options[argument === '--exe' ? 'executable' : 'screenshot'] = path.resolve(argumentsList[++index]);
  }
  options.executable = path.resolve(options.executable);
  return options;
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function freeDebugPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function poll(action, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`等待超时：${description}`);
}

async function cleanupProcesses(userData, child, exitState) {
  if (process.platform !== 'win32') return;
  await new Promise(resolve => {
    const helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($env:HARNESS_PORTABLE_SMOKE_DATA) -and ($_.Name -eq 'Harness Studio.exe' -or $_.Name -like 'Harness-Studio-*.exe' -or $_.Name -like 'Qinghe-Studio-*.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { windowsHide: true, stdio: 'ignore', env: { ...process.env, HARNESS_PORTABLE_SMOKE_DATA: userData } });
    const timer = setTimeout(() => { helper.kill(); resolve(); }, 10000);
    helper.once('error', () => { clearTimeout(timer); resolve(); });
    helper.once('close', () => { clearTimeout(timer); resolve(); });
  });
  if (child && !exitState()) child.kill();
}

async function smokePortable(options) {
  if (process.platform !== 'win32') throw new Error('桌面成品原生 GUI 验证需要 Windows');
  await access(options.executable);
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'harness-portable-smoke-'));
  const workspace = path.join(directory, '桌面成品像素项目');
  const userData = path.join(directory, 'application-data');
  let model;
  let child;
  let browser;
  let page;
  let exitResult;
  let authenticatedWorkspace = false;
  let completed = false;
  const pageErrors = [];
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'README.md'), '# Portable Harness project\nA real isolated desktop verification workspace.\n');
    model = await startModelServer();
    const harness = await createHarness({ workspace });
    try { await harness.updateSettings({ provider: 'responses', model: 'portable-test-model', apiKey: 'test-key', baseUrl: model.url }); }
    finally { await harness.close(); }
    const port = await freeDebugPort();
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    child = spawn(options.executable, [`--remote-debugging-port=${port}`, '--user-data', userData, '--workspace', workspace], { cwd: directory, env: environment, stdio: 'ignore', windowsHide: false });
    child.once('error', error => { exitResult = { error }; });
    child.once('exit', (code, signal) => { exitResult = { code, signal }; });
    process.stdout.write('已启动最终桌面成品 EXE，等待原生窗口…\n');
    const endpoint = `http://127.0.0.1:${port}`;
    await poll(async () => {
      if (exitResult) throw exitResult.error || new Error(`桌面成品在连接前退出：${exitResult.code}`);
      try {
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
        return response.ok && Boolean((await response.json()).webSocketDebuggerUrl);
      } catch { return false; }
    }, 120000, '桌面成品启动 Chrome 调试端口');
    browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
    page = await poll(async () => browser.contexts().flatMap(context => context.pages()).find(candidate => /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(candidate.url())), 30000, '现有 Electron 窗口');
    page.on('pageerror', error => pageErrors.push(error.message));
    page.setDefaultTimeout(15000);
    await expect(page.locator('.desktop-shell')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.harnessDesktop.getState()), { timeout: 30000 }).toMatchObject({ status: 'ready', workspace, version: VERSION });
    authenticatedWorkspace = true;
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), { require: 'undefined', process: 'undefined' });
    assert.equal((await fetch(new URL('/api/settings', page.url()))).status, 401);
    assert.equal((await fetch(new URL('/api/providers', page.url()))).status, 401);
    assert.equal((await fetch(new URL('/api/tool-policies', page.url()))).status, 401);
    const toolPolicies = await page.evaluate(async () => (await fetch('/api/tool-policies')).json());
    for (const name of ['web_fetch', 'web_search']) assert.equal(toolPolicies.find(tool => tool.name === name)?.requiresApproval, false);
    assert.equal(toolPolicies.find(tool => tool.name === 'browser')?.available, false);
    await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
    const usageTrigger = page.getByRole('complementary', { name: '会话侧栏', exact: true }).getByRole('button', { name: '使用声明', exact: true });
    await usageTrigger.click();
    const usage = page.getByRole('dialog', { name: '使用声明与免责声明', exact: true });
    await expect(usage).toBeVisible();
    const closeUsage = usage.getByRole('button', { name: '关闭使用声明', exact: true });
    await expect(closeUsage).toBeFocused();
    for (const name of ['合法与授权使用', '使用者责任', 'AI 与自动操作风险', '第三方服务与数据', '责任范围']) await expect(usage.getByRole('heading', { name, exact: true })).toBeVisible();
    await closeUsage.click();
    await expect(usage).toBeHidden();
    await expect(usageTrigger).toBeFocused();
    await usageTrigger.click();
    await page.keyboard.press('Escape');
    await expect(usage).toBeHidden();
    await expect(usageTrigger).toBeFocused();
    await page.getByRole('button', { name: '支持项目', exact: true }).click();
    const sponsorship = page.getByRole('dialog', { name: '支持项目', exact: true });
    await expect(sponsorship).toBeVisible();
    await expect(sponsorship.getByRole('link', { name: /爱发电/ })).toHaveAttribute('href', 'https://afdian.com/a/qnqinghe');
    await expect(sponsorship.getByRole('link', { name: '前往爱发电主页', exact: true })).toBeInViewport();
    await expect(sponsorship.locator('img')).toHaveCount(0);
    await sponsorship.getByRole('button', { name: '关闭支持项目', exact: true }).click();
    await expect(sponsorship).toBeHidden();
    await expect(page.getByRole('button', { name: '支持项目', exact: true })).toBeFocused();
    const draft = '验证桌面成品原生工作流 [test:write]';
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(draft);
    await openProviders(page);
    const management = providerPage(page);
    await management.getByRole('button', { name: '新增供应商', exact: true }).click();
    await management.getByRole('textbox', { name: '供应商名称', exact: true }).fill('桌面成品原生供应商');
    await management.getByRole('textbox', { name: 'API Base URL', exact: true }).fill(model.url);
    await management.getByLabel('API 密钥', { exact: true }).fill('test-key');
    await management.getByRole('button', { name: '保存并获取模型列表', exact: true }).click();
    await management.getByRole('checkbox', { name: '导入模型 test-model', exact: true }).check();
    await management.getByRole('button', { name: /^导入所选模型/ }).click();
    await expect(modelRow(page, 'test-model')).toBeVisible();
    await testModel(page, 'test-model');
    await expect(providerPage(page).getByLabel('API 密钥', { exact: true })).toHaveValue('');
    await returnToStudio(page);
    const workspaceUrl = page.url();
    await page.getByRole('button', { name: '选择默认模型', exact: true }).click();
    await page.getByRole('dialog', { name: '选择默认模型', exact: true }).getByRole('button', { name: '选择模型 桌面成品原生供应商 / test-model', exact: true }).click();
    await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toContainText('桌面成品原生供应商 / test-model');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(page.url(), workspaceUrl);
    const catalog = await readCatalog(page);
    assert.ok(catalog.active);
    assert.equal(catalog.active.modelId, 'test-model');
    assert.deepEqual(catalog.providers.find(provider => provider.id === catalog.active.providerId).models.map(model => model.id), ['test-model']);
    assert.equal(JSON.stringify(catalog).includes('test-key'), false);
    await setReasoning(page, 'max');
    assert.deepEqual(await page.evaluate(async () => (await (await fetch('/api/settings')).json()).reasoning), { mode: 'effort', effort: 'max' });
    await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toHaveValue(draft);
    process.stdout.write('真实桌面成品窗口已连接，验证审批和文件工具…\n');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible({ timeout: 30000 });
    assert.equal(await exists(path.join(workspace, 'harness-test.txt')), false);
    await page.getByRole('button', { name: '批准执行' }).click();
    await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible({ timeout: 30000 });
    assert.match(await readFile(path.join(workspace, 'harness-test.txt'), 'utf8'), /Hello from Harness test/);
    await page.getByRole('tab', { name: /^变更/ }).click();
    await expect(page.locator('.diff-view')).toContainText('Hello from Harness test');
    if (options.screenshot) {
      await mkdir(path.dirname(options.screenshot), { recursive: true });
      await page.screenshot({ path: options.screenshot });
    }
    await page.getByRole('button', { name: '恢复到修改前' }).click();
    await page.getByRole('button', { name: '确认恢复' }).click();
    await expect(page.locator('.change-card')).toContainText('已恢复');
    assert.equal(await exists(path.join(workspace, 'harness-test.txt')), false);
    process.stdout.write('验证消息重发、独立分支与原会话保留…\n');
    const savedSessions = () => page.evaluate(async () => (await fetch('/api/sessions')).json());
    const source = (await savedSessions())[0];
    assert.deepEqual(source.run.reasoning, { mode: 'effort', effort: 'max' });
    const branchEditor = page.getByRole('form', { name: '消息分支编辑器', exact: true });
    const branchPanel = page.getByRole('region', { name: '会话分支', exact: true });
    await page.locator(`[data-message-id="${source.messages[0].id}"]`).getByRole('button', { name: '编辑并重发', exact: true }).click();
    await branchEditor.getByRole('textbox', { name: '重发消息', exact: true }).fill('桌面成品改写消息：只查看项目');
    await branchEditor.getByRole('textbox', { name: '分支名称', exact: true }).fill('桌面成品重发分支');
    await branchEditor.getByRole('button', { name: '新建分支并发送', exact: true }).click();
    await expect.poll(async () => (await savedSessions()).find(session => session.branch?.parentSessionId === source.id)?.run?.status, { timeout: 30000 }).toBe('completed');
    const retry = (await savedSessions()).find(session => session.branch?.parentSessionId === source.id);
    assert.equal(retry.branch.inheritedMessageCount, 0);
    assert.deepEqual(retry.messages.filter(message => message.role === 'user').map(message => message.content), ['桌面成品改写消息：只查看项目']);
    await page.locator(`[data-message-id="${retry.messages.at(-1).id}"]`).getByRole('button', { name: '从这里分支', exact: true }).click();
    await branchEditor.getByRole('textbox', { name: '分支名称', exact: true }).fill('桌面成品会话分支');
    await branchEditor.getByRole('button', { name: '创建分支', exact: true }).click();
    await expect(branchEditor).toHaveCount(0);
    const nested = (await savedSessions()).find(session => session.branch?.parentSessionId === retry.id);
    assert.equal(nested.branch.rootSessionId, source.id);
    assert.equal(nested.run, null);
    assert.deepEqual(nested.checkpoints, []);
    assert.deepEqual(nested.messages.map(message => message.content), retry.messages.map(message => message.content));
    assert.deepEqual((await savedSessions()).find(session => session.id === source.id), source);
    assert.equal(await exists(path.join(workspace, 'harness-test.txt')), false);
    await expect(branchPanel).toContainText('各分支对话独立');
    await branchPanel.locator('summary').click();
    await page.getByRole('tab', { name: /^概览/ }).click();
    if (options.screenshot) await page.screenshot({ path: options.screenshot });
    assert.ok(model.requests.length >= 2);
    assert.ok(model.requests.some(request => request.path === '/v1/models' && request.method === 'GET' && request.authentication === 'bearer'));
    assert.ok(model.requests.filter(request => request.path !== '/v1/models').every(request => request.path === '/v1/responses'));
    assert.ok(model.requests.filter(request => request.body?.tools?.length).every(request => request.body.reasoning?.effort === 'max' && request.body.temperature === undefined));
    await page.getByRole('button', { name: /新建会话/ }).click();
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('[test:markdown]');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    const markdown = page.locator('.message-assistant .markdown').last();
    await expect(markdown.getByRole('table')).toHaveCount(1);
    await expect(markdown.locator('tbody tr')).toHaveCount(4);
    await expect(markdown.locator('.hljs-keyword').first()).toHaveText('const');
    await page.getByRole('button', { name: /新建会话/ }).click();
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('[test:math]');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(markdown.locator('.katex')).toHaveCount(9);
    await expect(markdown.locator('.katex-error')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => [...document.fonts].some(font => font.family.startsWith('KaTeX_') && font.status === 'loaded')));
    await page.getByRole('button', { name: /新建会话/ }).click();
    await pasteFiles(page, [upload('便携图片.png', png)]);
    await dropFiles(page, [upload('便携说明.docx', docx), upload('便携设计.pdf', pdf)]);
    const attachments = page.locator('form.composer').getByRole('group', { name: '待发送附件' });
    await expect(attachments.getByRole('button', { name: '预览附件 便携设计.pdf', exact: true })).toBeEnabled();
    await attachments.getByRole('button', { name: '预览附件 便携说明.docx', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(documentText);
    await page.getByRole('button', { name: '关闭预览' }).click();
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.message-assistant').last()).toContainText('测试任务已完成', { timeout: 30000 });
    assert.ok(model.requests.some(request => request.body?.input?.some(item => Array.isArray(item.content) && item.content.some(block => block.type === 'input_file'))));
    await page.reload();
    await expect(page.getByRole('group', { name: '消息附件' }).locator('.attachment-chip')).toHaveCount(3);
    process.stdout.write('桌面成品附件：粘贴、拖入、本地文档提取、原生图片 / PDF 与历史预览通过。\n');
    await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approval: 'auto' }) }));
    await page.getByRole('switch', { name: 'Browser-Use', exact: true }).click();
    await page.getByRole('button', { name: '同意并启用 Browser-Use', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Browser-Use', exact: true })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Computer-Use', exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: /新建会话/ }).click();
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(`[test:browser] ${model.url.replace('/v1', '/automation-fixture')}`);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.message-assistant').last()).toContainText('浏览器测试已完成', { timeout: 30000 });
    await page.getByRole('button', { name: '电脑与浏览器', exact: true }).click();
    await expect.poll(() => page.getByRole('img', { name: '工具截图' }).evaluate(element => element.naturalWidth)).toBe(1280);
    await page.getByRole('button', { name: '停止自动化', exact: true }).click();
    await expect(page.getByRole('img', { name: '工具截图' })).toHaveCount(0);
    process.stdout.write('桌面成品 Browser：真实页面操作、截图和停止通过。\n');
    await page.getByRole('button', { name: '技能与 MCP', exact: true }).click();
    const extensions = page.getByRole('region', { name: '技能与 MCP 管理' });
    const skillPackage = Buffer.from(zipSync({ 'review/SKILL.md': strToU8('---\nname: project-review\ndescription: Review the packaged desktop.\n---\nRead references/guide.md.'), 'review/references/guide.md': strToU8('最终 ZIP 内技能参考文件验证成功') }));
    await extensions.locator('input[type=file][accept=".md,.zip"]').setInputFiles({ name: 'review.zip', mimeType: 'application/zip', buffer: skillPackage });
    const skillCard = extensions.getByRole('article', { name: 'project-review', exact: true });
    await expect(skillCard).toContainText('已停用');
    await skillCard.getByRole('button', { name: '启用', exact: true }).click();
    await expect(skillCard).toContainText('已启用');
    await expect(skillCard.getByRole('button', { name: '停用', exact: true })).toBeEnabled();
    await extensions.getByRole('tab', { name: /MCP 服务/ }).click();
    await extensions.getByRole('button', { name: '粘贴 JSON 配置', exact: true }).click();
    await extensions.getByLabel('mcpServers JSON', { exact: true }).fill(JSON.stringify({ mcpServers: { browser: { command: process.execPath, args: [path.join(projectRoot, 'test/fixtures/mcp-server.js')] } } }));
    await extensions.getByRole('button', { name: '确认导入', exact: true }).click();
    const mcpCard = extensions.getByRole('article', { name: 'browser', exact: true });
    await mcpCard.getByRole('button', { name: '启用', exact: true }).click();
    await expect(mcpCard).toContainText('已连接');
    await expect(mcpCard.getByRole('button', { name: '停用', exact: true })).toBeEnabled();
    await mcpCard.locator('summary').click();
    await expect(mcpCard).toContainText('mcp_browser_echo');
    if (options.screenshot) await page.screenshot({ path: options.screenshot.replace(/\.png$/, '-extensions.png'), fullPage: true });
    await extensions.getByRole('button', { name: '返回工作台', exact: true }).click();
    await page.getByRole('button', { name: /新建会话/ }).click();
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('[test:extensions]');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.message-assistant').last()).toContainText('MCP 与 Skill 会话验证成功', { timeout: 30000 });
    await expect(page.locator('.message-assistant').last()).toContainText('最终 ZIP 内技能参考文件验证成功');
    const routingConfig = await page.evaluate(async baseUrl => {
      const api = async (method, pathname, body) => {
        const response = await fetch(`/api${pathname}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
        return result;
      };
      const references = [];
      for (const [protocol, id] of [['responses', 'route-reader'], ['openai', 'route-coder'], ['anthropic', 'route-writer'], ['systemone', 'jev-latest']]) {
        const result = await api('POST', '/providers', { name: `成品协作 ${protocol}`, protocol, baseUrl, apiKey: 'test-key', models: [{ id, reasoning: { mode: 'default' } }] });
        references.push({ scope: 'workspace', providerId: result.providers.at(-1).id, modelId: id });
      }
      await api('POST', '/providers/active', references[0]);
      const modelOrchestration = { compressionModel: references[0], decision: { enabled: true, model: references[3], minConfidence: 0.65 }, routing: { enabled: true, candidates: references.slice(0, 3).map((ref, index) => ({ ...ref, specialty: ['查看资料', '执行与验证', '最终总结'][index] })) } };
      await api('PATCH', '/settings', { modelOrchestration });
      return modelOrchestration;
    }, model.url);
    await page.getByRole('button', { name: '运行策略', exact: true }).click();
    await expect(page.getByLabel('启用智能模型路由', { exact: true })).toBeChecked();
    await expect(page.getByLabel('决策模型', { exact: true })).toHaveValue(JSON.stringify(['workspace', routingConfig.decision.model.providerId, 'jev-latest']));
    await page.getByRole('button', { name: '返回工作台', exact: true }).click();
    await page.getByRole('button', { name: /新建会话/ }).click();
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('检查工作区并汇报结果');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByText('智能路由验证完成：已查看工作区，由总结模型汇报结果。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await savedSessions()).find(session => session.run?.model === 'route-writer')?.run.status).toBe('completed');
    const routed = (await savedSessions()).find(session => session.run?.model === 'route-writer');
    assert.deepEqual(routed.events.filter(event => event.type === 'decision.completed').map(event => event.data.phase), ['start', 'progress', 'summary']);
    assert.equal(routed.run.modelUsage.find(entry => entry.purpose === 'decision').requests, 3);
    await page.reload();
    await expect(page.getByText('智能路由验证完成：已查看工作区，由总结模型汇报结果。', { exact: true })).toBeVisible();
    if (options.screenshot) await page.screenshot({ path: options.screenshot });
    process.stdout.write('桌面成品模型协作：配置保留、原生 System One 决策、Responses → Chat → Messages 动态路由与分用途用量通过。\n');
    assert.deepEqual(pageErrors, []);
    process.stdout.write('文件写入、差异和检查点恢复通过，关闭原生窗口…\n');
    await page.getByRole('button', { name: '关闭窗口' }).click();
    const result = await poll(async () => exitResult, 45000, '桌面进程正常退出');
    if (result.error) throw result.error;
    assert.equal(result.code, 0);
    assert.equal(await exists(path.join(workspace, '.harness', 'lock.json')), false);
    const sessionFiles = await readdir(path.join(workspace, '.harness', 'sessions'));
    const sessions = await Promise.all(sessionFiles.filter(filename => filename.endsWith('.json')).map(async filename => JSON.parse(await readFile(path.join(workspace, '.harness', 'sessions', filename), 'utf8'))));
    assert.ok(sessions.some(saved => saved.run?.status === 'completed' && saved.checkpoints.some(checkpoint => checkpoint.path === 'harness-test.txt' && checkpoint.restored === true)));
    assert.deepEqual(sessions.find(saved => saved.id === nested.id), nested);
    assert.deepEqual(sessions.find(saved => saved.id === source.id), source);
    completed = true;
    process.stdout.write(`桌面成品验证通过：接口模型获取与导入、工作台直接选择模型、思考强度保存与原生参数传递、密钥脱敏、草稿保留、原生窗口、审批、真实文件、检查点恢复、消息重发、嵌套分支、原会话保留、会话持久化、退出码 0。${options.screenshot ? `\n截图：${options.screenshot}` : ''}\n`);
  } finally {
    if (!completed && authenticatedWorkspace && page && !page.isClosed()) {
      await page.evaluate(async () => {
        const sessions = await fetch('/api/sessions').then(response => response.json());
        await Promise.all(sessions.filter(saved => ['running', 'waiting_approval'].includes(saved.run?.status)).map(saved => fetch(`/api/sessions/${saved.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })));
        await window.harnessDesktop.close();
      }).catch(() => {});
      await poll(async () => exitResult, 10000, '失败后关闭原生窗口').catch(() => {});
    }
    await browser?.close().catch(() => {});
    await cleanupProcesses(userData, child, () => exitResult);
    await model?.close();
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('harness-portable-smoke-')) throw new Error('拒绝清理意外的临时目录');
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}

try { await smokePortable(optionsFor(process.argv.slice(2))); }
catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }

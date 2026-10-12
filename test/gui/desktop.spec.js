import { test, expect, _electron } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../../src/core/harness.js';
import { startModelServer } from '../fixtures/model-server.js';
import { launchGui } from '../../scripts/launch-gui.js';
import { addModel, addProvider, expectProviders, openProviders, providerPage, readCatalog, returnToStudio, testModel } from '../browser/provider-helpers.js';
import { setReasoning } from '../browser/reasoning-helpers.js';
import { docx, documentText, dropFiles, pasteFiles, pdf, png, upload } from '../fixtures/attachments.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const packagedExecutable = process.env.HARNESS_GUI_EXECUTABLE;
const electronExecutable = createRequire(import.meta.url)('electron');
let fixture;

async function exists(location) {
  try { await access(location); return true; } catch { return false; }
}

test('GUI imports pasted and dropped files, previews them and keeps native attachments across restart', async () => {
  let { application, page } = await launch(fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  await pasteFiles(page, [upload('GUI截图.png', png)]);
  await dropFiles(page, [upload('GUI说明.docx', docx)]);
  await page.getByLabel('导入附件文件', { exact: true }).setInputFiles({ name: 'GUI设计.pdf', mimeType: 'application/pdf', buffer: pdf });
  const pending = page.locator('form.composer').getByRole('group', { name: '待发送附件' });
  await expect(pending.getByRole('button', { name: '预览附件 GUI设计.pdf', exact: true })).toBeEnabled();
  await expect.poll(() => pending.locator('img').evaluate(element => element.naturalWidth)).toBe(1);
  await pending.getByRole('button', { name: '预览附件 GUI说明.docx', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(documentText);
  await page.getByRole('button', { name: '关闭预览' }).click();
  await send(page, '分析导入的用户附件');
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  const blocks = fixture.model.requests.find(request => request.body?.input?.some(item => Array.isArray(item.content) && item.content.some(block => block.type === 'input_file'))).body.input.find(item => item.role === 'user').content;
  expect(blocks.find(block => block.type === 'input_image').image_url).toBe(`data:image/png;base64,${png.toString('base64')}`);
  expect(blocks.find(block => block.type === 'input_file').filename).toBe('GUI设计.pdf');
  const closed = application.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await closed;
  ({ application, page } = await launch());
  await currentWorkspace(page, fixture.workspace);
  await expect(page.getByRole('group', { name: '消息附件' }).locator('.attachment-chip')).toHaveCount(3);
  await page.getByRole('button', { name: '预览附件 GUI说明.docx', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(documentText);
  expect(fixture.errors).toEqual([]);
});

test('GUI runs an isolated Browser task and releases automation with the emergency control', async () => {
  const { application, page } = await launch(fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  await page.evaluate(async () => {
    await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approval: 'auto' }) });
  });
  await page.getByRole('switch', { name: 'Browser-Use', exact: true }).click();
  await page.getByRole('button', { name: '同意并启用 Browser-Use', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Browser-Use', exact: true })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Computer-Use', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '电脑与浏览器', exact: true }).click();
  const card = page.getByRole('region', { name: 'Browser 网页操作' });
  await expect(card.getByText('已启用', { exact: true })).toBeVisible();
  expect(await application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+F12'))).toBe(true);
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await send(page, `[test:browser] ${fixture.model.url.replace('/v1', '/automation-fixture')}`);
  await expect(page.locator('.message-assistant').last()).toContainText('浏览器测试已完成', { timeout: 25000 });
  const last = fixture.model.requests.filter(request => request.path === '/v1/responses').at(-1);
  expect(last.body.input.at(-1).content.at(-1).type).toBe('input_image');
  await page.getByRole('button', { name: '电脑与浏览器', exact: true }).click();
  await expect.poll(() => page.getByRole('img', { name: '工具截图' }).evaluate(element => element.naturalWidth)).toBe(1280);
  await page.getByRole('button', { name: '停止自动化', exact: true }).click();
  await expect(page.getByRole('img', { name: '工具截图' })).toHaveCount(0);
  await expect.poll(() => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+F12'))).toBe(false);
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Browser-Use', exact: true })).not.toBeChecked();
});

async function launch(workspace) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({
    executablePath: packagedExecutable ? path.resolve(packagedExecutable) : electronExecutable,
    args: [...(packagedExecutable ? [] : [projectRoot]), '--user-data', fixture.userData, ...(workspace ? ['--workspace', workspace] : [])],
    cwd: fixture.directory,
    env: environment,
    timeout: 45000,
  });
  fixture.applications.push(application);
  const page = await application.firstWindow();
  page.on('pageerror', error => fixture.errors.push(error.message));
  await application.evaluate(({ dialog }) => {
    globalThis.desktopTestDialogs = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.desktopTestDialogs.push(options);
      return { response: 0, checkboxChecked: false };
    };
  });
  await expect(page.locator('.desktop-shell')).toBeVisible();
  return { application, page };
}

async function choose(application, directory) {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: !selected, filePaths: selected ? [selected] : [] });
  }, directory);
}

async function confirm(application, response) {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showMessageBox = async (_window, options) => {
      globalThis.desktopTestDialogs.push(options);
      return { response: selected, checkboxChecked: false };
    };
  }, response);
}

async function send(page, prompt) {
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

async function currentWorkspace(page, workspace) {
  await expect.poll(() => page.evaluate(() => window.harnessDesktop.getState())).toMatchObject({ status: 'ready', workspace });
  await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
}

test.beforeEach(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-gui-test-'));
  const workspace = path.join(directory, '像素项目');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'README.md'), '# Pixel project\nA real isolated desktop test workspace.\n');
  const model = await startModelServer();
  const harness = await createHarness({ workspace });
  await harness.updateSettings({ provider: 'responses', model: 'test-model', apiKey: 'test-key', baseUrl: model.url });
  await harness.close();
  fixture = { directory, workspace, model, userData: path.join(directory, 'application-data'), applications: [], harnesses: [], errors: [] };
});

test.afterEach(async ({}, testInfo) => {
  for (const application of fixture?.applications || []) {
    try {
      if (testInfo.status !== testInfo.expectedStatus) {
        const page = application.windows()[0];
        if (page && !page.isClosed()) await page.screenshot({ path: testInfo.outputPath('failure.png') });
      }
      await confirm(application, 1);
      await application.close();
    } catch {}
  }
  for (const harness of fixture?.harnesses || []) await harness.close();
  await fixture?.model.close();
  if (fixture?.directory && path.dirname(fixture.directory) === path.resolve(os.tmpdir()) && path.basename(fixture.directory).startsWith('harness-gui-test-')) {
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('native launcher is isolated, chooses a folder and controls the real window', async ({}, testInfo) => {
  const { application, page } = await launch();
  await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toBeVisible();
  expect(await exists(path.join(fixture.directory, '.harness'))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('gui-launcher.png') });
  expect(await page.evaluate(() => ({ require: typeof require, process: typeof process, bridge: Object.keys(window.harnessDesktop).sort() }))).toEqual({
    require: 'undefined', process: 'undefined',
    bridge: ['chooseWorkspace', 'close', 'getState', 'minimize', 'onState', 'openExternal', 'openRecentWorkspace', 'platform', 'revealWorkspace', 'setUnsavedChanges', 'toggleMaximize'].sort(),
  });
  expect(await application.evaluate(({ BrowserWindow, app }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, isolated: preferences.contextIsolation, node: preferences.nodeIntegration, packaged: app.isPackaged };
  })).toEqual({ sandbox: true, isolated: true, node: false, packaged: Boolean(packagedExecutable) });
  for (const route of ['/', '/api/settings', '/api/events']) expect((await fetch(new URL(route, page.url()))).status).toBe(401);
  const originalUrl = page.url();
  await page.evaluate(() => window.open('https://example.com', '_blank'));
  expect(application.windows()).toHaveLength(1);
  await choose(application, null);
  await page.getByRole('button', { name: '选择工作区', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toBeEnabled();
  await choose(application, fixture.workspace);
  await page.getByRole('button', { name: '选择工作区', exact: true }).click();
  await currentWorkspace(page, fixture.workspace);
  await page.screenshot({ path: testInfo.outputPath('gui-workspace.png') });
  await application.evaluate(({ shell }) => { shell.openPath = async directory => { globalThis.desktopTestRevealed = directory; return ''; }; });
  await page.getByRole('button', { name: '在文件管理器中打开' }).click();
  await expect.poll(() => application.evaluate(() => globalThis.desktopTestRevealed)).toBe(fixture.workspace);
  await page.getByRole('button', { name: '最大化窗口' }).click();
  await expect(page.getByRole('button', { name: '还原窗口' })).toBeVisible();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
  await page.getByRole('button', { name: '还原窗口' }).click();
  await expect(page.getByRole('button', { name: '最大化窗口' })).toBeVisible();
  await page.getByRole('button', { name: '最小化窗口' }).click();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.once('will-navigate', event => { globalThis.desktopTestNavigationBlocked = event.defaultPrevented; }));
  await page.evaluate(() => { const link = document.createElement('a'); link.href = 'https://example.com'; document.body.append(link); link.click(); link.remove(); });
  await expect.poll(() => application.evaluate(() => globalThis.desktopTestNavigationBlocked)).toBe(true);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe(originalUrl);
  expect(fixture.errors).toEqual([]);
});

test('native approvals write a real file, restore its checkpoint and survive restart', async ({}, testInfo) => {
  let { application, page } = await launch(fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  await send(page, '检查桌面项目 [test:write]');
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  expect(await exists(path.join(fixture.workspace, 'harness-test.txt'))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('gui-approval.png') });
  await page.reload();
  await page.getByRole('button', { name: '批准执行' }).click();
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  expect(await readFile(path.join(fixture.workspace, 'harness-test.txt'), 'utf8')).toContain('Hello from Harness test');
  await page.getByRole('tab', { name: /^变更/ }).click();
  await expect(page.locator('.diff-view')).toContainText('Hello from Harness test');
  await page.screenshot({ path: testInfo.outputPath('gui-completed.png') });
  await page.getByRole('button', { name: '恢复到修改前' }).click();
  await page.getByRole('button', { name: '确认恢复' }).click();
  await expect(page.locator('.change-card')).toContainText('已恢复');
  expect(await exists(path.join(fixture.workspace, 'harness-test.txt'))).toBe(false);
  const savedBounds = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ width: 1080, height: 720 });
    return window.getNormalBounds();
  });
  const closed = application.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await closed;
  await expect.poll(() => exists(path.join(fixture.workspace, '.harness', 'lock.json'))).toBe(false);
  const preferences = JSON.parse(await readFile(path.join(fixture.userData, 'desktop-settings.json'), 'utf8'));
  expect(preferences.lastWorkspace).toBe(fixture.workspace);
  expect(preferences.windowBounds).toEqual(savedBounds);
  ({ application, page } = await launch());
  await currentWorkspace(page, fixture.workspace);
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  const restoredBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
  for (const dimension of ['width', 'height']) expect(Math.abs(restoredBounds[dimension] - savedBounds[dimension])).toBeLessThanOrEqual(2);
  expect(fixture.errors).toEqual([]);
});

test('native thinking controls send all three protocol parameters and persist after restart', async ({}, testInfo) => {
  let { application, page } = await launch(fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  for (const protocol of ['responses', 'openai', 'anthropic']) {
    await page.evaluate(async configuration => {
      const response = await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(configuration) });
      if (!response.ok) throw new Error('Failed to configure isolated GUI fixture');
    }, { provider: protocol, apiKey: 'test-key', model: 'test-model', baseUrl: fixture.model.url, reasoning: { mode: 'default' } });
    const picker = page.locator('.workspace-reasoning');
    await expect(picker.getByRole('slider')).toHaveAttribute('aria-valuetext', '模型默认');
    await setReasoning(page, 'max');
    await page.getByRole('button', { name: /新建会话/ }).click();
    await send(page, `验证 ${protocol} 思考参数`);
    await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
    const body = fixture.model.requests.at(-1).body;
    expect(body.temperature).toBeUndefined();
    if (protocol === 'responses') expect(body.reasoning).toEqual({ effort: 'max' });
    else if (protocol === 'openai') expect(body.reasoning_effort).toBe('max');
    else {
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'max' });
    }
  }
  await page.screenshot({ path: testInfo.outputPath('gui-reasoning.png') });
  const closed = application.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await closed;
  ({ application, page } = await launch());
  await currentWorkspace(page, fixture.workspace);
  await expect(page.locator('.workspace-reasoning').getByRole('slider')).toHaveAttribute('aria-valuetext', '自适应 · 最大');
  expect(await page.evaluate(async () => (await (await fetch('/api/settings')).json()).reasoning)).toEqual({ mode: 'adaptive', effort: 'max' });
  expect(fixture.errors).toEqual([]);
});

test('native rich text renders tables and only opens validated external links after confirmation', async ({}, testInfo) => {
  const { application, page } = await launch(fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  await application.evaluate(({ shell }) => {
    globalThis.desktopTestExternalLinks = [];
    shell.openExternal = async url => { globalThis.desktopTestExternalLinks.push(url); };
  });
  await send(page, '[test:markdown]');
  const markdown = page.locator('.message-assistant .markdown').last();
  await expect(markdown.getByRole('table')).toHaveCount(1);
  await expect(markdown.locator('tbody tr')).toHaveCount(4);
  await expect(markdown.locator('.hljs-keyword').first()).toHaveText('const');
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.markdownTestClipboard = value; } } }); });
  await markdown.getByRole('button', { name: '复制代码' }).click();
  await expect.poll(() => page.evaluate(() => window.markdownTestClipboard)).toContain('const status = { cpu: 6, healthy: true };');
  await expect(markdown.getByRole('button', { name: '复制代码' })).toContainText('已复制');
  const link = markdown.getByRole('link', { name: '参考文档', exact: true });
  await link.click();
  await expect.poll(() => application.evaluate(() => globalThis.desktopTestDialogs.length)).toBe(1);
  expect(await application.evaluate(() => globalThis.desktopTestExternalLinks)).toEqual([]);
  await confirm(application, 1);
  await link.click();
  await expect.poll(() => application.evaluate(() => globalThis.desktopTestExternalLinks)).toEqual(['https://example.com/docs']);
  const rejected = await page.evaluate(async () => {
    const values = ['javascript:alert(1)', 'file:///C:/Windows/system.ini', 'data:text/html,attack', 'https://user:pass@example.com', '/api/settings'];
    return Promise.all(values.map(async value => { try { await window.harnessDesktop.openExternal(value); return false; } catch { return true; } }));
  });
  expect(rejected).toEqual([true, true, true, true, true]);
  expect(await application.evaluate(() => globalThis.desktopTestExternalLinks)).toEqual(['https://example.com/docs']);
  await markdown.getByRole('heading', { name: '机器状态报告' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('gui-markdown.png') });
  expect(fixture.errors).toEqual([]);
});

test('native message retries and nested branches preserve history and survive restart', async ({}, testInfo) => {
  let { application, page } = await launch(fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  const sessions = () => page.evaluate(async () => (await fetch('/api/sessions')).json());
  const saved = id => page.evaluate(async sessionId => (await fetch(`/api/sessions/${sessionId}`)).json(), id);
  const prompt = () => page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
  const editor = () => page.getByRole('form', { name: '消息分支编辑器', exact: true });
  const branches = () => page.getByRole('region', { name: '会话分支', exact: true });
  await send(page, '桌面第一轮');
  await expect.poll(async () => (await sessions())[0]?.run?.status).toBe('completed');
  const first = (await sessions())[0];
  await send(page, '桌面后续消息不进入重发');
  await expect.poll(async () => { const session = await saved(first.id); return session.run.id !== first.run.id && session.run.status; }).toBe('completed');
  const source = await saved(first.id);
  await prompt().fill('桌面原会话草稿');
  await page.locator(`[data-message-id="${first.messages[0].id}"]`).getByRole('button', { name: '编辑并重发', exact: true }).click();
  await editor().getByRole('textbox', { name: '重发消息', exact: true }).fill('桌面修改后重发');
  await editor().getByRole('textbox', { name: '分支名称', exact: true }).fill('桌面重试分支');
  await editor().getByRole('button', { name: '新建分支并发送', exact: true }).click();
  await expect.poll(async () => (await sessions()).find(session => session.branch?.parentSessionId === source.id)?.run?.status).toBe('completed');
  const retry = (await sessions()).find(session => session.branch?.parentSessionId === source.id);
  expect(retry.branch).toMatchObject({ rootSessionId: source.id, mode: 'retry', inheritedMessageCount: 0 });
  expect(retry.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['桌面修改后重发']);
  expect(await saved(source.id)).toEqual(source);
  await branches().getByRole('button', { name: '返回上级会话', exact: true }).click();
  await expect(prompt()).toHaveValue('桌面原会话草稿');
  await branches().locator('summary').click();
  await branches().locator(`[data-branch-session="${retry.id}"]`).click();
  await page.locator(`[data-message-id="${retry.messages.at(-1).id}"]`).getByRole('button', { name: '从这里分支', exact: true }).click();
  await editor().getByRole('textbox', { name: '分支名称', exact: true }).fill('桌面子分支');
  await editor().getByRole('button', { name: '创建分支', exact: true }).click();
  await expect(editor()).toHaveCount(0);
  const child = (await sessions()).find(session => session.branch?.parentSessionId === retry.id);
  expect(child.branch.rootSessionId).toBe(source.id);
  expect(child.run).toBeNull();
  expect(child.messages.map(message => message.content)).toEqual(retry.messages.map(message => message.content));
  expect(child.checkpoints).toEqual([]);
  await expect(branches()).toContainText('来自：桌面重试分支');
  await page.screenshot({ path: testInfo.outputPath('gui-conversation-branches.png') });
  const closed = application.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await closed;
  ({ application, page } = await launch());
  await currentWorkspace(page, fixture.workspace);
  await expect(branches()).toContainText('来自：桌面重试分支');
  expect(await saved(child.id)).toEqual(child);
  expect(await saved(source.id)).toEqual(source);
  await branches().getByRole('button', { name: '返回上级会话', exact: true }).click();
  await expect(branches()).toContainText(`来自：${source.title}`);
  expect(fixture.errors).toEqual([]);
});

test('native LaTeX renders accessible formulas with authenticated local fonts and persists after reload', async ({}, testInfo) => {
  const { page } = await launch(fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  await send(page, '[test:math]');
  const markdown = page.locator('.message-assistant .markdown').last();
  await expect(markdown.locator('.katex')).toHaveCount(9);
  await expect(markdown.locator('math')).toHaveCount(9);
  await expect(markdown.locator('.katex-error')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => [...document.fonts].some(font => font.family.startsWith('KaTeX_') && font.status === 'loaded'))).toBe(true);
  await page.reload();
  await currentWorkspace(page, fixture.workspace);
  await expect(markdown.locator('.katex')).toHaveCount(9);
  await markdown.getByRole('heading', { name: '数学公式', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('gui-math.png') });
  expect(fixture.errors).toEqual([]);
});

test('GUI provider catalog uses all native protocols and persists across native restart', async () => {
  let { application, page } = await launch(fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  for (const protocol of ['responses', 'openai', 'anthropic']) {
    await openProviders(page);
    await addProvider(page, { name: `${protocol} 原生供应商`, protocol, baseUrl: fixture.model.url });
    await addModel(page, { id: `${protocol}-gui-test` });
    await providerPage(page).getByRole('button', { name: '从接口获取模型列表', exact: true }).click();
    await expect(providerPage(page).getByRole('checkbox', { name: '导入模型 discovered-small', exact: true })).toBeVisible();
    await testModel(page, `${protocol}-gui-test`);
    await returnToStudio(page);
    const workspaceUrl = page.url();
    await page.getByRole('button', { name: '选择默认模型', exact: true }).click();
    await page.getByRole('dialog', { name: '选择默认模型', exact: true }).getByRole('button', { name: `选择模型 ${protocol} 原生供应商 / ${protocol}-gui-test`, exact: true }).click();
    await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toContainText(`${protocol} 原生供应商 / ${protocol}-gui-test`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(page.url()).toBe(workspaceUrl);
    await page.getByRole('button', { name: /新建会话/ }).click();
    await send(page, `使用 ${protocol} 阅读项目`);
    await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  }
  expect(new Set(fixture.model.requests.map(request => request.path))).toEqual(new Set(['/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/models']));
  expect(fixture.model.requests.filter(request => request.path === '/v1/models').map(request => request.authentication)).toEqual(['bearer', 'bearer', 'x-api-key']);
  expect(fixture.model.requests.find(request => request.path === '/v1/models' && request.authentication === 'x-api-key').anthropicVersion).toBe('2023-06-01');
  expect(await page.evaluate(async () => JSON.stringify(await (await fetch('/api/settings')).json()))).not.toContain('test-key');
  const before = await readCatalog(page);
  expect(JSON.stringify(before)).not.toContain('test-key');
  const closed = application.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await closed;
  ({ application, page } = await launch());
  await currentWorkspace(page, fixture.workspace);
  await openProviders(page);
  await expectProviders(page);
  expect(await readCatalog(page)).toEqual(before);
  await providerPage(page).getByRole('button', { name: '选择供应商 anthropic 原生供应商', exact: true }).click();
  await expect(providerPage(page).getByLabel('API 密钥', { exact: true })).toHaveValue('');
  expect(fixture.errors).toEqual([]);
});

test('locked projects preserve the old workspace and active work requires confirmation', async () => {
  const alternate = path.join(fixture.directory, '另一个项目');
  await mkdir(alternate);
  const lock = await createHarness({ workspace: alternate });
  fixture.harnesses.push(lock);
  const { application, page } = await launch(fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  const denied = await page.evaluate(async directory => {
    try { await window.harnessDesktop.openRecentWorkspace(directory); return false; } catch { return true; }
  }, alternate);
  expect(denied).toBe(true);
  await choose(application, alternate);
  await page.getByRole('button', { name: '切换工作区' }).click();
  await expect(page.locator('.desktop-error-banner')).toContainText('无法打开工作区');
  await currentWorkspace(page, fixture.workspace);
  await lock.close();
  await send(page, '需要确认切换 [test:write]');
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  await page.getByRole('button', { name: '切换工作区' }).click();
  await currentWorkspace(page, fixture.workspace);
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await currentWorkspace(page, fixture.workspace);
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  await confirm(application, 1);
  await page.getByRole('button', { name: '切换工作区' }).click();
  await currentWorkspace(page, alternate);
  expect(await exists(path.join(fixture.workspace, '.harness', 'lock.json'))).toBe(false);
  expect(await exists(path.join(fixture.workspace, 'harness-test.txt'))).toBe(false);
  expect(await page.evaluate(() => window.harnessDesktop.getState())).toMatchObject({ recentWorkspaces: [alternate, fixture.workspace] });
  await page.evaluate(directory => window.harnessDesktop.openRecentWorkspace(directory), fixture.workspace);
  await currentWorkspace(page, fixture.workspace);
  await expect(page.getByText('运行已停止。你可以继续发送消息。')).toBeVisible();
  await send(page, '关闭前确认 [test:write]');
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  const closed = application.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await closed;
  expect(await exists(path.join(fixture.workspace, '.harness', 'lock.json'))).toBe(false);
  expect(await exists(path.join(fixture.workspace, 'harness-test.txt'))).toBe(false);
});

test('second launch reuses the native window without taking the project lock in the launcher', async () => {
  const { application, page } = await launch();
  await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toBeVisible();
  let result;
  if (packagedExecutable) {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    result = await new Promise((resolve, reject) => {
      const child = spawn(path.resolve(packagedExecutable), ['--user-data', fixture.userData, '--workspace', path.basename(fixture.workspace)], { cwd: fixture.directory, env: environment, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } else {
    result = await launchGui({ workspace: fixture.workspace, args: ['--user-data', fixture.userData], stdio: 'ignore' });
  }
  expect(result).toBe(0);
  await currentWorkspace(page, fixture.workspace);
  expect(application.windows()).toHaveLength(1);
  expect(await exists(path.join(fixture.directory, '.harness'))).toBe(false);
  expect(fixture.errors).toEqual([]);
});

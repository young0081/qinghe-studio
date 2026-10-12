import { test, expect, _electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../../src/core/harness.js';
import { startModelServer } from '../fixtures/model-server.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const executablePath = createRequire(import.meta.url)('electron');
let fixture;

test.beforeEach(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-orb-test-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'README.md'), '# Orb fixture\n');
  const model = await startModelServer({ chunkDelayMs: 30 });
  fixture = { directory, workspace, model, errors: [] };
  const harness = await createHarness({ workspace });
  await harness.updateSettings({ provider: 'responses', model: 'test-model', apiKey: 'test-key', baseUrl: model.url });
  await harness.close();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath, args: [projectRoot, '--workspace', workspace, '--user-data', path.join(directory, 'profile')], cwd: directory, env, timeout: 45000 });
  const page = await application.firstWindow();
  fixture.application = application;
  fixture.page = page;
  page.on('pageerror', error => fixture.errors.push(error.message));
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await expect.poll(() => page.evaluate(() => window.harnessDesktop.getState())).toMatchObject({ status: 'ready', workspace });
  await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
});

test.afterEach(async () => {
  await fixture?.application?.close().catch(() => {});
  await fixture?.model.close();
  if (fixture?.directory && path.dirname(fixture.directory) === path.resolve(os.tmpdir()) && path.basename(fixture.directory).startsWith('harness-orb-test-')) await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

async function send(prompt) {
  await fixture.page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(prompt);
  await fixture.page.getByRole('button', { name: '发送任务', exact: true }).click();
}

async function orbPage() {
  await expect.poll(() => fixture.application.windows().find(page => new URL(page.url()).hash === '#orb')?.url()).toBeTruthy();
  const orb = fixture.application.windows().find(page => new URL(page.url()).hash === '#orb');
  orb.on('pageerror', error => fixture.errors.push(error.message));
  await expect(orb.getByRole('main', { name: '青禾 Studio 悬浮助手' })).toBeVisible();
  return orb;
}

async function windowState() {
  return fixture.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ orb: window.webContents.getURL().endsWith('#orb'), visible: window.isVisible(), bounds: window.getBounds(), alwaysOnTop: window.isAlwaysOnTop() })));
}

test('background question orb answers, animates completion and restores the unchanged main window', async () => {
  const { application, page } = fixture;
  const before = (await windowState())[0].bounds;
  await send('[test:question]');
  await expect(page.getByRole('form', { name: '回答 青禾 Studio 的问题' })).toBeVisible();
  await page.getByRole('button', { name: '最小化窗口' }).click();
  const orb = await orbPage();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'question');
  expect(await orb.title()).toBe('青禾 Studio · 悬浮球');
  expect((await windowState()).find(window => !window.orb).visible).toBe(false);
  expect((await windowState()).find(window => window.orb).alwaysOnTop).toBe(true);
  expect(await orb.evaluate(() => ({ require: typeof require, process: typeof process, workspace: typeof window.harnessDesktop.chooseWorkspace }))).toEqual({ require: 'undefined', process: 'undefined', workspace: 'undefined' });
  await expect(orb.getByText('你希望使用哪个方案？', { exact: true })).toBeVisible();
  await orb.getByRole('button', { name: /保留现有布局/ }).click();
  await expect(orb.getByRole('textbox')).toHaveValue('保留现有布局');
  await orb.screenshot({ path: path.join(os.tmpdir(), 'harness-orb-question.png') });
  await orb.getByRole('button', { name: '提交并继续 →' }).click();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'completed');
  await expect(orb.getByRole('button', { name: '查看任务 ↗' })).toBeVisible();
  const animation = await orb.locator('.orb-core').evaluate(element => getComputedStyle(element).animationName);
  expect(animation).toBe('orb-celebrate');
  await orb.screenshot({ path: path.join(os.tmpdir(), 'harness-orb-completed.png') });
  await orb.getByRole('button', { name: '恢复 青禾 Studio 窗口' }).click();
  await expect.poll(async () => (await windowState()).find(window => !window.orb).visible).toBe(true);
  expect((await windowState()).find(window => !window.orb).bounds).toEqual(before);
  await expect(page.locator('.message-assistant').last()).toContainText('已收到补充：保留现有布局');
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('#orb')).isVisible())).toBe(false);
  expect(fixture.errors).toEqual([]);
});

test('computer approval automatically collapses and denial never operates the real desktop', async () => {
  await fixture.page.evaluate(async () => {
    const response = await fetch('/api/automation', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ desktop: true }) });
    if (!response.ok) throw new Error(await response.text());
  });
  await send('[test:computer-deny]');
  const orb = await orbPage();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'approval');
  await expect(orb.getByText('将操作真实桌面并向当前模型发送截图。批准后请勿同时操作。')).toBeVisible();
  expect((await windowState()).find(window => !window.orb).visible).toBe(false);
  await orb.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'completed');
  expect(fixture.errors).toEqual([]);
});

test('computer presentation hides the main window and keeps a protected click-through orb during the desktop helper', async () => {
  const { application, page } = fixture;
  await application.evaluate(({ BrowserWindow }, root) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const { Automation } = require(`${root}/src/automation/index.js`);
    const execute = Automation.prototype.execute;
    globalThis.orbDesktopObservations = [];
    Automation.prototype.execute = function (kind, args, context) {
      if (kind === 'desktop') this.desktop = async () => {
        globalThis.orbDesktopObservations.push(BrowserWindow.getAllWindows().map(window => ({ orb: window.webContents.getURL().endsWith('#orb'), visible: window.isVisible(), focusable: window.isFocusable(), protected: window.isContentProtected() })));
        await new Promise(resolve => setTimeout(resolve, 150));
        return { note: 'Isolated helper stub: no screenshot or desktop input' };
      };
      return execute.call(this, kind, args, context);
    };
  }, projectRoot);
  await page.evaluate(async () => {
    for (const [route, body] of [['settings', { approval: 'auto' }], ['automation', { desktop: true }]]) {
      const response = await fetch(`/api/${route}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await response.text());
    }
  });
  await send('[test:computer-deny]');
  const orb = await orbPage();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'completed');
  const observations = await application.evaluate(() => globalThis.orbDesktopObservations);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toHaveLength(2);
  expect(observations[0].find(window => !window.orb).visible).toBe(false);
  expect(observations[0].find(window => window.orb).visible).toBe(Number(os.release().split('.')[2]) >= 19041);
  expect(observations[0].find(window => window.orb).focusable).toBe(false);
  expect(observations[0].find(window => window.orb).protected).toBe(true);
  expect((await windowState()).find(window => window.orb).visible).toBe(true);
  expect((await windowState()).find(window => !window.orb).visible).toBe(false);
  expect(fixture.errors).toEqual([]);
});

test('orb handles task cancellation, status animation variants, reduced motion and edge dragging', async () => {
  const { application, page } = fixture;
  await send('[test:question]');
  await expect(page.getByRole('form', { name: '回答 青禾 Studio 的问题' })).toBeVisible();
  await page.getByRole('button', { name: '最小化窗口' }).click();
  const orb = await orbPage();
  const drag = orb.getByRole('button', { name: '拖动悬浮球', exact: true });
  await drag.focus();
  const before = (await windowState()).find(window => window.orb).bounds;
  await drag.press('ArrowUp');
  await expect.poll(async () => (await windowState()).find(window => window.orb).bounds.y).toBe(before.y - 24);
  await orb.getByRole('button', { name: '停止当前任务' }).click();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'error');
  expect(await orb.locator('.orb-core').evaluate(element => getComputedStyle(element).animationName)).toBe('orb-error');
  for (const mode of ['running', 'compacting']) {
    await application.evaluate(({ BrowserWindow }, nextMode) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('#orb')).webContents.send('harness-desktop:orb-state', { mode: nextMode, activeCount: 1, steps: 8 });
    }, mode);
    await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', mode);
    expect(await orb.locator('.orb-core').evaluate(element => getComputedStyle(element).animationIterationCount)).toBe('infinite');
    await orb.screenshot({ path: path.join(os.tmpdir(), `harness-orb-${mode}.png`) });
  }
  await orb.emulateMedia({ reducedMotion: 'reduce' });
  expect(await orb.locator('.orb-core').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await orb.locator('.orb-compression i').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(fixture.errors).toEqual([]);
});

test('native focus loss shows pending questions from multiple tasks and accepts free text without stealing focus', async () => {
  const { application, page } = fixture;
  await send('[test:question]');
  await expect(page.getByRole('form', { name: '回答 青禾 Studio 的问题' })).toBeVisible();
  await page.evaluate(async () => {
    const session = await (await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Second pending task' }) })).json();
    const response = await fetch(`/api/sessions/${session.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '[test:question]' }) });
    if (!response.ok) throw new Error(await response.text());
  });
  await expect.poll(() => page.evaluate(async () => (await (await fetch('/api/questions')).json()).length)).toBe(2);
  await application.evaluate(({ BrowserWindow }) => {
    const background = new BrowserWindow({ width: 260, height: 160, title: 'Harness background fixture', skipTaskbar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    globalThis.orbBackgroundWindow = background;
    background.show();
    background.focus();
  });
  const orb = await orbPage();
  await expect(orb.getByText('还有 1 项等待处理；提交后显示下一项。')).toBeVisible();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === globalThis.orbBackgroundWindow)).toBe(true);
  await orb.getByRole('textbox').fill('使用我输入的第三种方案');
  await orb.getByRole('button', { name: '提交并继续 →' }).click();
  await expect.poll(() => page.evaluate(async () => (await (await fetch('/api/questions')).json()).length)).toBe(1);
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'question');
  await expect(orb.locator('.orb-notice')).toContainText('一项任务已完成');
  await orb.getByRole('textbox').fill('第二项任务使用另一个答案');
  await orb.getByRole('button', { name: '提交并继续 →' }).click();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'completed');
  const sessions = await page.evaluate(async () => (await (await fetch('/api/sessions')).json()));
  expect(sessions.filter(session => session.run?.status === 'completed')).toHaveLength(2);
  expect(JSON.stringify(sessions)).toContain('使用我输入的第三种方案');
  expect(JSON.stringify(sessions)).toContain('第二项任务使用另一个答案');
  await orb.getByRole('button', { name: '恢复 青禾 Studio 窗口' }).click();
  await application.evaluate(async () => { globalThis.orbBackgroundWindow.focus(); await new Promise(resolve => setTimeout(resolve, 250)); });
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http:') && !window.webContents.getURL().endsWith('#orb')).isVisible())).toBe(true);
  await page.evaluate(async () => {
    const headers = { 'content-type': 'application/json' };
    const session = await (await fetch('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ title: 'Started while already in background' }) })).json();
    const response = await fetch(`/api/sessions/${session.id}/run`, { method: 'POST', headers, body: JSON.stringify({ prompt: '[test:question]' }) });
    if (!response.ok) throw new Error(await response.text());
  });
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'question');
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === globalThis.orbBackgroundWindow)).toBe(true);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http:') && !window.webContents.getURL().endsWith('#orb')).isVisible())).toBe(false);
  await orb.getByRole('button', { name: '停止当前任务' }).click();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'error');
  await application.evaluate(() => globalThis.orbBackgroundWindow.destroy());
  expect(fixture.errors).toEqual([]);
});

test('real context compaction streams through the orb and a crashed orb can be recreated', async () => {
  const { application, page } = fixture;
  await send('[test:question]');
  await expect(page.getByRole('form', { name: '回答 青禾 Studio 的问题' })).toBeVisible();
  await page.getByRole('button', { name: '最小化窗口' }).click();
  let orb = await orbPage();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('#orb')).webContents.forcefullyCrashRenderer());
  await expect.poll(async () => (await windowState()).some(window => window.orb)).toBe(false);
  await page.getByRole('button', { name: '最小化窗口' }).click();
  orb = await orbPage();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'question');
  await orb.getByRole('button', { name: '停止当前任务' }).click();
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'error');
  await fixture.model.close();
  fixture.model = await startModelServer({ chunkDelayMs: 500 });
  const sessionId = await page.evaluate(async baseUrl => {
    const headers = { 'content-type': 'application/json' };
    const configured = await fetch('/api/settings', { method: 'PATCH', headers, body: JSON.stringify({ baseUrl, maxContextTokens: 16000, maxTokens: 256 }) });
    if (!configured.ok) throw new Error(await configured.text());
    const session = await (await fetch('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ title: 'Context compaction fixture' }) })).json();
    const response = await fetch(`/api/sessions/${session.id}/run`, { method: 'POST', headers, body: JSON.stringify({ prompt: '请阅读以下记录并概括。' + '历史上下文记录。'.repeat(7000) }) });
    if (!response.ok) throw new Error(await response.text());
    return session.id;
  }, fixture.model.url);
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'compacting');
  await expect(orb.getByRole('status').first()).toHaveText('上下文压缩中');
  await orb.screenshot({ path: path.join(os.tmpdir(), 'harness-orb-real-compaction.png') });
  await expect(orb.locator('.orb-shell')).toHaveAttribute('data-mode', 'completed', { timeout: 30000 });
  const session = await page.evaluate(async id => (await (await fetch(`/api/sessions/${id}`)).json()), sessionId);
  expect(session.run.compactions).toBeGreaterThan(0);
  expect(session.events.some(event => event.type === 'context.compacting')).toBe(true);
  expect(session.events.some(event => event.type === 'context.compacted')).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('native Browser-Use opens authenticated live frames, observes fill and click, and clears after completion', async () => {
  const { page } = fixture;
  await page.evaluate(async () => {
    const response = await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approval: 'auto' }) });
    if (!response.ok) throw new Error(await response.text());
  });
  await page.getByRole('switch', { name: 'Browser-Use', exact: true }).click();
  await page.getByRole('button', { name: '同意并启用 Browser-Use', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Browser-Use', exact: true })).toBeChecked();
  await send(`[test:browser-live] ${fixture.model.url.replace('/v1', '/automation-fixture')}`);
  const live = page.getByRole('complementary', { name: 'Browser 实时画面' });
  await expect(live).toBeVisible();
  const frame = live.getByRole('img', { name: '青禾 Studio 正在操作的浏览器实时画面' });
  await expect.poll(() => frame.evaluate(image => image.naturalWidth)).toBe(1280);
  expect(await frame.getAttribute('src')).toMatch(/^blob:http:\/\/127\.0\.0\.1:/);
  await expect(page.getByText('请确认直播画面，然后继续网页操作。', { exact: true })).toBeVisible();
  const firstSequence = await page.evaluate(async () => (await (await fetch('/api/automation/browser-live')).json()).sequence);
  await expect.poll(() => page.evaluate(async () => (await (await fetch('/api/automation/browser-live')).json()).sequence)).toBeGreaterThan(firstSequence);
  expect((await fetch(new URL('/api/automation/browser-live/frame', page.url()))).status).toBe(401);
  await page.screenshot({ path: path.join(os.tmpdir(), 'harness-gui-browser-live.png') });
  await page.getByRole('form', { name: '回答 青禾 Studio 的问题' }).getByRole('button', { name: /继续操作网页/ }).click();
  await page.getByRole('button', { name: '提交并继续 →' }).click();
  await expect(page.getByText('页面已填写并保存，是否结束观察？', { exact: true })).toBeVisible();
  await expect(live).toContainText('Saved: 实时操作已完成');
  await expect.poll(() => frame.evaluate(image => image.naturalWidth)).toBe(1280);
  await page.screenshot({ path: path.join(os.tmpdir(), 'harness-gui-browser-live-saved.png') });
  await page.getByRole('form', { name: '回答 青禾 Studio 的问题' }).getByRole('button', { name: /完成观察/ }).click();
  await page.getByRole('button', { name: '提交并继续 →' }).click();
  await expect(page.locator('.message-assistant').last()).toContainText('浏览器实时观察已完成。');
  await expect(frame).toHaveCount(0);
  await expect(live).toHaveAttribute('data-active', 'false');
  expect(fixture.errors).toEqual([]);
});

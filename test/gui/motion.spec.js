import { test, expect, _electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../../src/core/harness.js';
import { startModelServer } from '../fixtures/model-server.js';
import { expectProviders, openProviders, providerPage, returnToStudio } from '../browser/provider-helpers.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const packagedExecutable = process.env.HARNESS_GUI_EXECUTABLE;
const electronExecutable = createRequire(import.meta.url)('electron');
let fixture;

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
  fixture.application = application;
  const page = await application.firstWindow();
  page.on('pageerror', error => fixture.errors.push(error.message));
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await expect(page.locator('.desktop-shell')).toBeVisible();
  return { application, page };
}

async function expectReady(page) {
  await expect(page.locator('.desktop-shell')).toHaveAttribute('data-desktop-status', 'ready');
  await expect(page.locator('.studio')).toHaveAttribute('data-phase', 'ready');
  await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toBeEnabled();
}

async function infiniteAnimations(page) {
  return page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity).map(animation => animation.animationName || animation.effect.target?.className || 'unnamed'));
}

async function expectNoMotion(page) {
  const violations = await page.evaluate(() => {
    const failures = [];
    for (const element of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        if (style.animationName !== 'none' || style.transitionDuration.split(',').some(duration => parseFloat(duration) > 0)) failures.push(`${element.tagName}.${element.getAttribute('class') || ''}${pseudo || ''}`);
      }
    }
    return failures;
  });
  expect(violations).toEqual([]);
}

async function expectStableControl(page, control, releasePoint) {
  await page.mouse.move(releasePoint.x, releasePoint.y);
  const bounds = await control.boundingBox();
  await control.hover();
  await expect(control).toHaveCSS('transform', 'none');
  expect(await control.boundingBox()).toEqual(bounds);
  await page.mouse.down();
  try {
    await expect(control).toHaveCSS('transform', 'none');
    expect(await control.boundingBox()).toEqual(bounds);
  } finally {
    await page.mouse.move(releasePoint.x, releasePoint.y);
    await page.mouse.up();
  }
}

test.beforeEach(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-gui-motion-'));
  const workspace = path.join(directory, '动效项目');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'README.md'), '# Motion project\nAn isolated native animation regression workspace.\n');
  const model = await startModelServer();
  const harness = await createHarness({ workspace });
  await harness.updateSettings({ provider: 'responses', model: 'test-model', apiKey: 'test-key', baseUrl: model.url });
  await harness.close();
  fixture = { directory, workspace, model, userData: path.join(directory, 'application-data'), errors: [] };
});

test.afterEach(async ({}, testInfo) => {
  if (fixture?.application) {
    try {
      if (testInfo.status !== testInfo.expectedStatus) {
        const page = fixture.application.windows()[0];
        if (page && !page.isClosed()) await page.screenshot({ path: testInfo.outputPath('failure.png') });
      }
      await fixture.application.close();
    } catch {}
  }
  await fixture?.model.close();
  if (fixture?.directory && path.dirname(fixture.directory) === path.resolve(os.tmpdir()) && path.basename(fixture.directory).startsWith('harness-gui-motion-')) {
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('native titlebar controls stay fixed and chooser activity follows pending IPC', async () => {
  const { application, page } = await launch();
  await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toBeVisible();
  const titlebarBounds = await page.locator('.desktop-titlebar').boundingBox();
  for (const label of ['最小化窗口', '最大化窗口', '关闭窗口']) {
    await expectStableControl(page, page.getByRole('button', { name: label }), { x: 800, y: 100 });
    expect(await page.locator('.desktop-titlebar').boundingBox()).toEqual(titlebarBounds);
  }
  await expect.poll(() => infiniteAnimations(page)).toEqual([]);
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => new Promise(resolve => { globalThis.motionTestChoose = resolve; });
  });
  const chooser = page.getByRole('button', { name: '选择工作区', exact: true });
  await chooser.click();
  try {
    await expect(chooser).toHaveAttribute('aria-busy', 'true');
    await expect(chooser).toBeDisabled();
    await expect(chooser.locator('.spinner')).toBeVisible();
    await expect.poll(() => infiniteAnimations(page)).toContain('spin');
  } finally {
    await application.evaluate(() => globalThis.motionTestChoose?.({ canceled: true, filePaths: [] }));
  }
  await expect(chooser).toHaveAttribute('aria-busy', 'false');
  await expect(chooser).toBeEnabled();
  await expect(chooser.locator('.spinner')).toHaveCount(0);
  await expect.poll(() => infiniteAnimations(page)).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('native reduced motion keeps pending loaders visible and buttons stationary', async () => {
  const { application, page } = await launch();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectNoMotion(page);
  await expectStableControl(page, page.getByRole('button', { name: '选择工作区', exact: true }), { x: 800, y: 100 });
  let release;
  let received;
  const gate = new Promise(resolve => { release = resolve; });
  const responseReady = new Promise(resolve => { received = resolve; });
  await page.route('**/api/settings', async route => {
    received();
    await gate;
    await route.continue();
  }, { times: 1 });
  await application.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, fixture.workspace);
  try {
    await page.getByRole('button', { name: '选择工作区', exact: true }).click();
    await responseReady;
    const loader = page.getByRole('status', { name: '正在载入工作区', exact: true });
    await expect(loader).toBeVisible();
    await expect(loader.locator('.pixel-loader-track > span')).toBeVisible();
    await expectNoMotion(page);
    release();
    await expectReady(page);
    await expect(loader).toHaveCount(0);
    await expectStableControl(page, page.getByRole('button', { name: '切换工作区' }), { x: 800, y: 100 });
    await openProviders(page);
    await expectStableControl(page, providerPage(page).getByRole('button', { name: '新增供应商', exact: true }), { x: 700, y: 100 });
    await expectStableControl(page, providerPage(page).getByRole('button', { name: '返回工作台', exact: true }), { x: 700, y: 100 });
    await expectNoMotion(page);
    await returnToStudio(page);
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('减少动态效果时仍然可以输入任务');
    await expectStableControl(page, page.getByRole('button', { name: '发送任务', exact: true }), { x: 800, y: 100 });
    await expectNoMotion(page);
  } finally { release(); }
  expect(fixture.errors).toEqual([]);
});

test('native provider page navigation preserves draft input and pointer access', async () => {
  const { page } = await launch(fixture.workspace);
  await expectReady(page);
  const composer = page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
  const draft = '跨供应商页面切换保留的原生任务草稿';
  await composer.fill(draft);
  const opener = page.getByRole('button', { name: '管理供应商', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await expectProviders(page);
    await providerPage(page).getByRole('button', { name: '返回工作台', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(providerPage(page)).not.toBeVisible();
    await expect(composer).toHaveValue(draft);
    await opener.focus();
    await page.keyboard.press('Enter');
  }
  await expectProviders(page);
  await returnToStudio(page);
  await expect(composer).toHaveValue(draft);
  expect(await composer.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === element;
  })).toBe(true);
  await composer.click();
  await expect(composer).toBeFocused();
  expect(fixture.errors).toEqual([]);
});

test('native stopped runs preserve unfinished plans without indefinite activity', async () => {
  const { page } = await launch(fixture.workspace);
  await expectReady(page);
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('检查停止后的计划动效 [test:write]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  await expect(page.locator('.plan-in_progress')).toContainText('查看工作区文件');
  await page.getByRole('button', { name: '停止运行' }).click();
  await expect(page.getByText('运行已停止。你可以继续发送消息。')).toBeVisible();
  await expect(page.locator('.plan-in_progress')).toContainText('查看工作区文件');
  await expect(page.locator('.plan-in_progress .mini-pulse')).toHaveCSS('animation-name', 'none');
  await expect.poll(() => infiniteAnimations(page)).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

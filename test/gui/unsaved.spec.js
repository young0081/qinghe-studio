import { test, expect, _electron } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../../src/core/harness.js';
import { startModelServer } from '../fixtures/model-server.js';
import { expectProviders, openProviders, providerPage, readCatalog } from '../browser/provider-helpers.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const packagedExecutable = process.env.HARNESS_GUI_EXECUTABLE;
const electronExecutable = createRequire(import.meta.url)('electron');
let fixture;

async function exists(location) {
  try { await access(location); return true; } catch { return false; }
}

async function launch() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: packagedExecutable ? path.resolve(packagedExecutable) : electronExecutable, args: [...(packagedExecutable ? [] : [projectRoot]), '--user-data', fixture.userData, '--workspace', fixture.first], cwd: fixture.directory, env: environment, timeout: 45000 });
  fixture.application = application;
  const page = await application.firstWindow();
  page.on('pageerror', error => fixture.errors.push(error.message));
  page.on('dialog', pending => { if (pending.type() !== 'beforeunload') void pending.dismiss(); });
  await application.evaluate(({ dialog }) => {
    globalThis.unsavedTestDialogs = [];
    globalThis.unsavedTestResponses = [];
    const respond = options => {
      globalThis.unsavedTestDialogs.push(options);
      return globalThis.unsavedTestResponses.shift() ?? 0;
    };
    dialog.showMessageBox = async (_window, options) => ({ response: respond(options), checkboxChecked: false });
    dialog.showMessageBoxSync = (_window, options) => respond(options);
  });
  await ready(page, fixture.first);
  return { application, page };
}

async function responses(application, values) {
  await application.evaluate((_electron, selected) => { globalThis.unsavedTestResponses = selected; }, values);
}

async function ready(page, workspace) {
  await expect.poll(() => page.evaluate(() => window.harnessDesktop.getState())).toMatchObject({ status: 'ready', workspace });
  await expect.poll(() => page.evaluate(async () => { const response = await fetch('/api/health'); return { status: response.status, ...await response.json() }; })).toMatchObject({ status: 200, ok: true, workspace });
}

async function editProvider(page, name) {
  if (!await providerPage(page).isVisible()) await openProviders(page);
  await expectProviders(page);
  await providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true }).fill(name);
}

test.beforeEach(async () => {
  const tempParent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(tempParent, 'harness-unsaved-gui-'));
  fixture = { directory, tempParent, first: path.join(directory, 'first-project'), second: path.join(directory, 'second-project'), userData: path.join(directory, 'desktop-profile'), errors: [] };
  fixture.model = await startModelServer();
  for (const [workspace, name] of [[fixture.first, '第一项目供应商'], [fixture.second, '第二项目供应商']]) {
    await mkdir(workspace);
    const harness = await createHarness({ workspace });
    try {
      const catalog = await harness.createProvider({ name, protocol: 'responses', baseUrl: fixture.model.url, apiKey: 'test-key', models: [{ id: 'test-model' }] });
      await harness.activateModel(catalog.providers[0].id, 'test-model');
    } finally { await harness.close(); }
  }
});

test.afterEach(async ({}, testInfo) => {
  if (fixture?.application) {
    try {
      if (testInfo.status !== testInfo.expectedStatus) {
        const page = fixture.application.windows()[0];
        if (page && !page.isClosed()) await page.screenshot({ path: testInfo.outputPath('unsaved-failure.png') });
      }
      await responses(fixture.application, [1, 1, 1, 1]);
      await fixture.application.close();
    } catch {}
  }
  await fixture?.model.close();
  if (fixture?.directory) {
    const target = await realpath(fixture.directory);
    expect(path.dirname(target)).toBe(fixture.tempParent);
    expect(path.basename(target).startsWith('harness-unsaved-gui-')).toBe(true);
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('dirty native close cancellations preserve drafts and live backend before accepted shutdown', async () => {
  const { application, page } = await launch();
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('等待审批 [test:write]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  await editProvider(page, '尚未保存的关闭草稿');
  await responses(application, [0]);
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.unsavedTestDialogs.length)).toBe(1);
  await ready(page, fixture.first);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('尚未保存的关闭草稿');
  expect(await exists(path.join(fixture.first, '.harness', 'lock.json'))).toBe(true);
  expect(await application.evaluate(() => globalThis.unsavedTestDialogs[0])).toMatchObject({ message: '放弃未保存的更改并关闭窗口？', defaultId: 0, cancelId: 0 });
  await responses(application, [1, 0]);
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.unsavedTestDialogs.length)).toBe(3);
  await ready(page, fixture.first);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('尚未保存的关闭草稿');
  await page.evaluate(() => { window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; }); });
  await responses(application, [1, 1]);
  const closed = application.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await closed;
  await expect.poll(() => exists(path.join(fixture.first, '.harness', 'lock.json'))).toBe(false);
  expect(await exists(path.join(fixture.first, 'harness-test.txt'))).toBe(false);
  const settings = JSON.parse(await readFile(path.join(fixture.first, '.harness', 'settings.json'), 'utf8'));
  expect(settings.providerCatalog.providers[0].name).toBe('第一项目供应商');
  expect(fixture.errors).toEqual([]);
});

test('dirty folder and recent workspace switches cancel without losing edits and accept into isolated projects', async () => {
  const { application, page } = await launch();
  const invalid = await page.evaluate(async () => {
    const results = [];
    for (const args of [[], ['not-a-boolean'], [null], [1], [true, false]]) {
      try { await window.harnessDesktop.setUnsavedChanges(...args); results.push(false); } catch { results.push(true); }
    }
    return results;
  });
  expect(invalid).toEqual([true, true, true, true, true]);
  await editProvider(page, '第一项目未保存草稿');
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, fixture.second);
  await responses(application, [0]);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.unsavedTestDialogs.length)).toBe(1);
  await ready(page, fixture.first);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('第一项目未保存草稿');
  await responses(application, [1]);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await ready(page, fixture.second);
  await expectProviders(page);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('第二项目供应商');
  expect((await readCatalog(page)).providers.map(provider => provider.name)).toEqual(['第二项目供应商']);
  expect(await exists(path.join(fixture.first, '.harness', 'lock.json'))).toBe(false);
  await editProvider(page, '第二项目未保存草稿');
  await responses(application, [0]);
  await page.evaluate(directory => window.harnessDesktop.openRecentWorkspace(directory), fixture.first);
  await ready(page, fixture.second);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('第二项目未保存草稿');
  await responses(application, [1]);
  await page.evaluate(directory => window.harnessDesktop.openRecentWorkspace(directory), fixture.first);
  await ready(page, fixture.first);
  await expectProviders(page);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('第一项目供应商');
  expect((await readCatalog(page)).providers.map(provider => provider.name)).toEqual(['第一项目供应商']);
  expect(fixture.errors).toEqual([]);
});

test('dirty native reload asks before discarding edits without shutting down the core', async () => {
  const { application, page } = await launch();
  await editProvider(page, '重新加载前未保存草稿');
  await responses(application, [0]);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
  await expect.poll(() => application.evaluate(() => globalThis.unsavedTestDialogs.length)).toBe(1);
  await ready(page, fixture.first);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('重新加载前未保存草稿');
  await responses(application, [1]);
  const reloaded = page.waitForEvent('domcontentloaded');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
  await reloaded;
  await ready(page, fixture.first);
  await expectProviders(page);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('第一项目供应商');
  expect(await exists(path.join(fixture.first, '.harness', 'lock.json'))).toBe(true);
  expect(fixture.errors).toEqual([]);
});

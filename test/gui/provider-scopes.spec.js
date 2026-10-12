import { test, expect, _electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../../src/core/harness.js';
import { startModelServer } from '../fixtures/model-server.js';
import { addModel, modelRow, openProviders, providerPage, returnToStudio } from '../browser/provider-helpers.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const packagedExecutable = process.env.HARNESS_GUI_EXECUTABLE;
const electronExecutable = createRequire(import.meta.url)('electron');
let fixture;

test.beforeEach(async () => {
  const temporaryParent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryParent, 'harness-provider-scopes-gui-'));
  fixture = { directory, temporaryParent, userData: path.join(directory, 'desktop-profile'), first: path.join(directory, 'first-workspace'), second: path.join(directory, 'second-workspace'), errors: [], applications: [] };
  fixture.globalConfigDir = path.join(fixture.userData, 'shared-config');
  fixture.localModel = await startModelServer({ apiKey: 'gui-local-secret-123456' });
  fixture.globalModel = await startModelServer({ apiKey: 'gui-global-secret-123456' });
  for (const [workspace, model] of [[fixture.first, 'first-workspace-model'], [fixture.second, 'second-workspace-model']]) {
    await mkdir(workspace);
    const harness = await createHarness({ workspace, globalConfigDir: fixture.globalConfigDir });
    try { await harness.updateSettings({ provider: 'responses', baseUrl: fixture.localModel.url, model, apiKey: 'gui-local-secret-123456' }); }
    finally { await harness.close(); }
  }
});

test.afterEach(async () => {
  for (const application of fixture?.applications || []) {
    try { await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }); await application.close(); }
    catch {}
  }
  await fixture?.localModel?.close();
  await fixture?.globalModel?.close();
  if (fixture?.directory) {
    const resolved = await realpath(fixture.directory);
    expect(path.dirname(resolved)).toBe(fixture.temporaryParent);
    expect(path.basename(resolved).startsWith('harness-provider-scopes-gui-')).toBe(true);
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

async function launch(workspace = fixture.first, globalConfigDir) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HARNESS_CONFIG_DIR;
  if (globalConfigDir) env.HARNESS_CONFIG_DIR = globalConfigDir;
  const application = await _electron.launch({ executablePath: packagedExecutable ? path.resolve(packagedExecutable) : electronExecutable, args: [...(packagedExecutable ? [] : [projectRoot]), '--user-data', fixture.userData, '--workspace', workspace], cwd: fixture.directory, env, timeout: 45000 });
  fixture.applications.push(application);
  const page = await application.firstWindow();
  page.on('pageerror', error => fixture.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') fixture.errors.push(message.text()); });
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await expect.poll(() => page.evaluate(() => window.harnessDesktop.getState())).toMatchObject({ status: 'ready', workspace });
  await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
  return { application, page };
}

async function api(page, route) {
  return page.evaluate(async pathname => {
    const response = await fetch(`/api${pathname}`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, route);
}

async function switchSource(page, scope) {
  const group = providerPage(page).getByRole('group', { name: '当前工作区使用的供应商配置', exact: true });
  const button = group.getByRole('button', { name: scope === 'global' ? '使用全局配置' : '使用工作区配置', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await api(page, '/settings')).providerScope).toBe(scope);
}

async function addGlobalSource(page) {
  await openProviders(page);
  const management = providerPage(page);
  await management.getByRole('button', { name: '编辑全局配置', exact: true }).click();
  await expect(management.getByRole('button', { name: '编辑全局配置', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await api(page, '/provider-scopes')).activeScope).toBe('workspace');
  await management.getByRole('button', { name: '新增供应商', exact: true }).click();
  await management.getByRole('textbox', { name: '供应商名称', exact: true }).fill('跨项目全局供应商');
  await management.getByRole('combobox', { name: 'API 协议', exact: true }).selectOption('responses');
  await management.getByRole('textbox', { name: 'API Base URL', exact: true }).fill(fixture.globalModel.url);
  await management.getByLabel('API 密钥', { exact: true }).fill('gui-global-secret-123456');
  await management.getByRole('button', { name: '保存供应商', exact: true }).click();
  await expect(management.getByRole('button', { name: '选择供应商 跨项目全局供应商', exact: true })).toBeVisible();
  await addModel(page, { id: 'shared-global-model', name: '全局共享模型' });
  await modelRow(page, 'shared-global-model').getByRole('button', { name: '设为默认', exact: true }).click();
  await expect.poll(async () => (await api(page, '/providers?scope=global')).active?.modelId).toBe('shared-global-model');
  expect((await api(page, '/settings')).model).toBe('first-workspace-model');
  expect((await api(page, '/provider-scopes')).activeScope).toBe('workspace');
  await expect(management.getByLabel('API 密钥', { exact: true })).toHaveValue('');
}

async function send(page, prompt) {
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

async function answer(page, value) {
  const question = page.getByRole('form', { name: '回答 青禾 Studio 的问题', exact: true });
  await expect(question).toBeVisible();
  await question.getByRole('textbox').fill(value);
  await question.getByRole('button', { name: '提交并继续 →' }).click();
  await expect(question).toHaveCount(0);
  await expect.poll(async () => (await api(page, '/sessions')).some(session => ['running', 'waiting_input', 'waiting_approval'].includes(session.run?.status))).toBe(false);
}

test('native scope management keeps both defaults, snapshots running tasks and shares the global catalog across workspaces and restart', async () => {
  test.setTimeout(90000);
  let { application, page } = await launch();
  expect((await api(page, '/provider-scopes')).global.providers).toEqual([]);
  await addGlobalSource(page);
  const initial = await api(page, '/provider-scopes');
  expect(initial.workspace.active.modelId).toBe('first-workspace-model');
  expect(initial.global.active.modelId).toBe('shared-global-model');
  await page.screenshot({ path: path.join(os.tmpdir(), 'harness-gui-provider-scopes.png') });
  await returnToStudio(page);
  await send(page, '[test:question] preserve a local native run');
  await expect(page.getByRole('form', { name: '回答 青禾 Studio 的问题' })).toBeVisible();
  await openProviders(page);
  await switchSource(page, 'global');
  await returnToStudio(page);
  await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toContainText('shared-global-model');
  await answer(page, '原任务继续使用工作区供应商');
  expect(fixture.localModel.requests.length).toBeGreaterThanOrEqual(2);
  expect(fixture.localModel.requests.every(request => request.body.model === 'first-workspace-model')).toBe(true);
  expect(fixture.globalModel.requests).toHaveLength(0);
  const localRequests = fixture.localModel.requests.length;
  await send(page, '[test:question] use the global source for a new task');
  await answer(page, '新任务使用全局供应商');
  expect(fixture.localModel.requests).toHaveLength(localRequests);
  expect(fixture.globalModel.requests.length).toBeGreaterThanOrEqual(2);
  expect(fixture.globalModel.requests.every(request => request.body.model === 'shared-global-model')).toBe(true);
  expect(await readFile(path.join(fixture.first, '.harness/settings.json'), 'utf8')).not.toContain('gui-global-secret-123456');
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, fixture.second);
  await page.getByRole('button', { name: '切换工作区', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.harnessDesktop.getState())).toMatchObject({ status: 'ready', workspace: fixture.second });
  const second = await api(page, '/provider-scopes');
  expect(second.activeScope).toBe('workspace');
  expect(second.workspace.active.modelId).toBe('second-workspace-model');
  expect(second.global).toEqual(initial.global);
  await openProviders(page);
  await switchSource(page, 'global');
  await returnToStudio(page);
  const closed = application.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await closed;
  ({ application, page } = await launch(fixture.second));
  await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toContainText('shared-global-model');
  expect((await api(page, '/provider-scopes')).activeScope).toBe('global');
  await openProviders(page);
  await switchSource(page, 'workspace');
  await returnToStudio(page);
  expect((await api(page, '/settings')).model).toBe('second-workspace-model');
  expect(fixture.errors).toEqual([]);
});

test('explicit HARNESS_CONFIG_DIR takes precedence over a desktop profile shared-config directory', async () => {
  const override = path.join(fixture.directory, 'explicit-shared-config');
  const staging = path.join(fixture.directory, 'seed-global-profile');
  await mkdir(staging);
  const harness = await createHarness({ workspace: staging, globalConfigDir: override });
  try {
    const catalog = await harness.createProvider({ name: '环境指定的全局供应商', protocol: 'responses', baseUrl: fixture.globalModel.url, apiKey: 'gui-global-secret-123456', models: [{ id: 'environment-global-model' }] }, 'global');
    await harness.activateModel(catalog.providers[0].id, 'environment-global-model', 'global');
  } finally { await harness.close(); }
  const { page } = await launch(fixture.first, override);
  const scopes = await api(page, '/provider-scopes');
  expect(scopes.global.providers.map(provider => provider.name)).toEqual(['环境指定的全局供应商']);
  expect(scopes.workspace.active.modelId).toBe('first-workspace-model');
  await openProviders(page);
  await switchSource(page, 'global');
  expect((await api(page, '/settings')).model).toBe('environment-global-model');
  expect(fixture.errors).toEqual([]);
});

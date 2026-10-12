import { test, expect } from '@playwright/test';

const modelUrl = 'http://127.0.0.1:3418/v1';
const management = page => page.getByRole('main', { name: '供应商与模型', exact: true });
const scopeLabel = scope => scope === 'global' ? '全局配置' : '工作区配置';
const catalog = async (request, scope) => (await request.get(`/api/providers?scope=${scope}`)).json();
const settings = async request => (await request.get('/api/settings')).json();

test.beforeEach(async ({ request }) => {
  for (const session of await (await request.get('/api/sessions')).json()) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await request.post('/api/provider-scopes', { data: { scope: 'workspace' } });
  for (const scope of ['global', 'workspace']) {
    await request.post(`/api/providers/active?scope=${scope}`, { data: { providerId: null, modelId: null } });
    for (const provider of (await catalog(request, scope)).providers) await request.delete(`/api/providers/${provider.id}?scope=${scope}`);
  }
  await request.patch('/api/settings', { data: { approval: 'auto' } });
});

test.afterEach(async ({ request }) => {
  await request.post('/api/provider-scopes', { data: { scope: 'workspace' } });
});

async function seed(request, scope, name = scope === 'global' ? '全局模型站' : '项目模型站') {
  const result = await request.post(`/api/providers?scope=${scope}`, { data: { name, protocol: 'responses', baseUrl: modelUrl, apiKey: 'test-key', models: [{ id: `${scope}-model`, name: `${scopeLabel(scope)}默认模型` }, { id: `${scope}-extra`, name: '备用模型' }] } });
  expect(result.ok()).toBe(true);
  const provider = (await result.json()).providers.find(item => item.name === name);
  expect((await request.post(`/api/providers/active?scope=${scope}`, { data: { providerId: provider.id, modelId: `${scope}-model` } })).ok()).toBe(true);
  return provider;
}

async function openManagement(page) {
  await page.goto('/#/providers');
  await expect(page).toHaveTitle('青禾 Studio');
  await expect(management(page).getByRole('heading', { name: '供应商与模型', exact: true })).toBeVisible();
  await expect(management(page).getByRole('button', { name: '编辑全局配置', exact: true })).toBeEnabled();
  await expect(page.locator('vite-error-overlay, nextjs-portal')).toHaveCount(0);
}

async function editScope(page, scope) {
  await management(page).getByRole('button', { name: `编辑${scopeLabel(scope)}`, exact: true }).click();
  await expect(management(page).getByRole('heading', { name: `正在编辑${scopeLabel(scope)}`, exact: true })).toBeVisible();
}

async function useScope(page, request, scope) {
  await management(page).getByRole('button', { name: `使用${scopeLabel(scope)}`, exact: true }).click();
  await expect.poll(async () => (await settings(request)).providerScope).toBe(scope);
  await expect(management(page).getByRole('button', { name: `使用${scopeLabel(scope)}`, exact: true })).toBeEnabled();
  await expect(management(page).getByRole('button', { name: `使用${scopeLabel(scope)}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
}

test('both configuration sources support independent provider and model CRUD without copying credentials', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await openManagement(page);
  for (const scope of ['global', 'workspace']) {
    await editScope(page, scope);
    await management(page).getByRole('button', { name: '新增供应商', exact: true }).click();
    await management(page).getByRole('textbox', { name: '供应商名称', exact: true }).fill(`${scope}独立连接`);
    await management(page).getByRole('textbox', { name: 'API Base URL', exact: true }).fill(modelUrl);
    await management(page).getByLabel('API 密钥', { exact: true }).fill(`${scope}-secret`);
    await management(page).getByRole('button', { name: '保存供应商', exact: true }).click();
    await expect(management(page).getByRole('button', { name: `选择供应商 ${scope}独立连接`, exact: true })).toBeVisible();
    await expect(management(page).getByLabel('API 密钥', { exact: true })).toHaveValue('');
    await management(page).getByRole('button', { name: '添加模型', exact: true }).click();
    await management(page).getByRole('textbox', { name: '模型 ID', exact: true }).fill('same-model');
    await management(page).getByRole('textbox', { name: '模型显示名称', exact: true }).fill(`${scope}模型`);
    await management(page).getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(management(page).getByRole('row', { name: 'same-model', exact: true })).toContainText(`${scope}模型`);
    await management(page).getByRole('textbox', { name: '供应商名称', exact: true }).fill(`${scope}已更新`);
    await management(page).getByRole('button', { name: '保存供应商', exact: true }).click();
    await expect(management(page).getByRole('button', { name: `选择供应商 ${scope}已更新`, exact: true })).toBeVisible();
  }
  expect((await settings(request)).providerScope).toBe('workspace');
  for (const scope of ['global', 'workspace']) {
    const saved = await catalog(request, scope);
    expect(saved.providers.map(item => item.name)).toEqual([`${scope}已更新`]);
    expect(saved.providers[0].hasApiKey).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(`${scope}-secret`);
    await editScope(page, scope);
    await management(page).getByRole('row', { name: 'same-model', exact: true }).getByRole('button', { name: '删除模型', exact: true }).click();
    await management(page).getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(management(page).getByRole('row', { name: 'same-model', exact: true })).toHaveCount(0);
    await management(page).getByRole('button', { name: '删除供应商', exact: true }).click();
    await management(page).getByRole('button', { name: '确认删除', exact: true }).click();
    await expect.poll(async () => (await catalog(request, scope)).providers.length).toBe(0);
  }
  expect(errors).toEqual([]);
});

test('active source persists and the workbench model picker follows only the enabled source', async ({ page, request }, testInfo) => {
  await seed(request, 'global');
  await seed(request, 'workspace');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openManagement(page);
  await editScope(page, 'global');
  expect((await settings(request)).providerScope).toBe('workspace');
  await management(page).getByRole('link', { name: '运行策略', exact: true }).click();
  const policy = page.getByRole('main', { name: '运行策略', exact: true });
  await expect(policy.getByRole('region', { name: '当前默认模型', exact: true })).toContainText('项目模型站');
  await expect(policy.getByRole('region', { name: '当前默认模型', exact: true })).not.toContainText('全局模型站');
  await policy.getByRole('link', { name: '供应商与模型', exact: true }).click();
  await expect(management(page).getByRole('button', { name: '编辑全局配置', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await useScope(page, request, 'global');
  await page.screenshot({ path: testInfo.outputPath('provider-scopes-desktop.png'), fullPage: false });
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  const trigger = page.getByRole('button', { name: '选择默认模型', exact: true });
  await expect(trigger).toContainText('global-model');
  await expect(trigger).toContainText('全局');
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '选择默认模型', exact: true });
  await expect(picker.getByRole('button', { name: '选择模型 全局模型站 / global-extra', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: /项目模型站/ })).toHaveCount(0);
  await picker.getByRole('button', { name: '选择模型 全局模型站 / global-extra', exact: true }).click();
  await expect(trigger).toContainText('global-extra');
  expect((await catalog(request, 'workspace')).active.modelId).toBe('workspace-model');
  await page.reload();
  await expect(trigger).toContainText('global-extra');
  await page.getByRole('button', { name: '管理供应商', exact: true }).click();
  await useScope(page, request, 'workspace');
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(trigger).toContainText('workspace-model');
  await trigger.click();
  await expect(picker.getByRole('button', { name: /全局模型站/ })).toHaveCount(0);
  await expect(picker.getByRole('button', { name: '选择模型 项目模型站 / workspace-extra', exact: true })).toBeVisible();
});

test('editing and activation preserve per-source drafts and navigation still protects unsaved secrets', async ({ page, request }) => {
  await seed(request, 'workspace');
  await openManagement(page);
  await management(page).getByLabel('API 密钥', { exact: true }).fill('unsaved-workspace-secret');
  await editScope(page, 'global');
  await management(page).getByRole('textbox', { name: '供应商名称', exact: true }).fill('未保存全局草稿');
  await management(page).getByLabel('API 密钥', { exact: true }).fill('unsaved-global-secret');
  await editScope(page, 'workspace');
  await expect(management(page).getByLabel('API 密钥', { exact: true })).toHaveValue('unsaved-workspace-secret');
  await useScope(page, request, 'global');
  await expect(management(page).getByLabel('API 密钥', { exact: true })).toHaveValue('unsaved-workspace-secret');
  await editScope(page, 'global');
  await expect(management(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('未保存全局草稿');
  await expect(management(page).getByLabel('API 密钥', { exact: true })).toHaveValue('unsaved-global-secret');
  expect((await catalog(request, 'global')).providers).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('unsaved-');
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  const guard = management(page).getByRole('region', { name: '有未保存的更改', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(management(page).getByLabel('API 密钥', { exact: true })).toHaveValue('unsaved-global-secret');
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await guard.getByRole('button', { name: '放弃更改并继续', exact: true }).click();
  await expect(management(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
});

test('source switch errors retain selection and committed synchronization failures block navigation until retry', async ({ page, request }) => {
  await seed(request, 'global');
  await seed(request, 'workspace');
  await openManagement(page);
  await page.route('**/api/provider-scopes', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: '切换服务暂时不可用' } }) : route.continue());
  await management(page).getByRole('button', { name: '使用全局配置', exact: true }).click();
  await expect(management(page).getByRole('alert')).toContainText('切换服务暂时不可用');
  await expect(management(page).getByRole('button', { name: '使用工作区配置', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await settings(request)).providerScope).toBe('workspace');
  await page.unroute('**/api/provider-scopes');
  await page.route('**/api/settings', route => route.fulfill({ status: 503, json: { error: '工作台同步暂时不可用' } }));
  await management(page).getByRole('button', { name: '重试切换配置来源', exact: true }).click();
  await expect(management(page).getByRole('alert')).toContainText('配置来源已保存，但工作台同步失败');
  expect((await settings(request)).providerScope).toBe('global');
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(management(page)).toBeVisible();
  await expect(page.locator('.send-button')).toBeDisabled();
  await page.unroute('**/api/settings');
  await management(page).getByRole('button', { name: '重试同步配置来源', exact: true }).click();
  await expect(management(page).getByRole('alert')).toHaveCount(0);
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toContainText('global-model');
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务', exact: true }).fill('同步后的任务');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

test('empty source and narrow layouts stay usable without sharing the other source models', async ({ page, request }, testInfo) => {
  await seed(request, 'workspace');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openManagement(page);
  await useScope(page, request, 'global');
  await editScope(page, 'global');
  await management(page).evaluate(element => element.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const name of ['编辑全局配置', '编辑工作区配置']) {
    const bounds = await management(page).getByRole('button', { name, exact: true }).boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  }
  await page.screenshot({ path: testInfo.outputPath('provider-scopes-mobile.png'), fullPage: false });
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  const trigger = page.getByRole('button', { name: '选择默认模型', exact: true });
  await expect(trigger).toContainText('全局');
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '选择默认模型', exact: true });
  await expect(picker).toContainText('尚未添加模型');
  await expect(picker.getByRole('button', { name: /项目模型站/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a lost response after scope save reconciles through reads and blocks sending while the source is uncertain', async ({ page, request }) => {
  await seed(request, 'global');
  await seed(request, 'workspace');
  await openManagement(page);
  let writes = 0;
  let saved = false;
  let unavailable = true;
  await page.route('**/api/provider-scopes', async route => {
    if (route.request().method() === 'POST') {
      writes++;
      await route.fetch();
      saved = true;
      await route.abort('failed');
    } else if (saved && unavailable) await route.abort('failed');
    else await route.continue();
  });
  await management(page).getByRole('button', { name: '使用全局配置', exact: true }).click();
  await expect(management(page).getByRole('alert').filter({ hasText: '暂时无法确认配置来源' })).toBeVisible();
  expect((await settings(request)).providerScope).toBe('global');
  await expect(page.locator('.send-button')).toBeDisabled();
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(management(page)).toBeVisible();
  unavailable = false;
  await management(page).getByRole('button', { name: '重试同步配置来源', exact: true }).click();
  await expect(management(page).getByRole('button', { name: '使用全局配置', exact: true })).toBeEnabled();
  expect(writes).toBe(1);
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toContainText('global-model');
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务', exact: true }).fill('来源已经确认');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

test('synchronizing a new source also clears an earlier model selection synchronization error', async ({ page, request }) => {
  await seed(request, 'global');
  await seed(request, 'workspace');
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '选择默认模型', exact: true });
  await expect(trigger).toContainText('workspace-model');
  await page.route('**/api/settings', route => route.fulfill({ status: 503, json: { error: '设置读取中断' } }));
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '选择默认模型', exact: true });
  await picker.getByRole('button', { name: '选择模型 项目模型站 / workspace-extra', exact: true }).click();
  await expect(picker.getByRole('alert')).toContainText('工作台状态同步失败');
  await picker.getByRole('button', { name: '管理供应商与模型', exact: true }).click();
  await management(page).getByRole('button', { name: '使用全局配置', exact: true }).click();
  await expect(management(page).getByRole('alert')).toContainText('配置来源已保存，但工作台同步失败');
  await page.unroute('**/api/settings');
  await management(page).getByRole('button', { name: '重试同步配置来源', exact: true }).click();
  await expect(management(page).getByRole('alert')).toHaveCount(0);
  await management(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(trigger).toContainText('global-model');
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务', exact: true }).fill('已恢复全局来源');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

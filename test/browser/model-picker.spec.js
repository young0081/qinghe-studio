import { test, expect } from '@playwright/test';
import { addModel, addProvider, clearCatalog, expectProviders, openProviders, readCatalog, returnToStudio } from './provider-helpers.js';

const modelUrl = 'http://127.0.0.1:3418/v1';
const trigger = page => page.getByRole('button', { name: '选择默认模型', exact: true });
const picker = page => page.getByRole('dialog', { name: '选择默认模型', exact: true });
const choice = (page, name, model = 'shared-model') => picker(page).getByRole('button', { name: `选择模型 ${name} / ${model}`, exact: true });

test.beforeEach(async ({ request }) => {
  const sessions = await (await request.get('/api/sessions')).json();
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await clearCatalog(request);
  await request.patch('/api/settings', { data: { approval: 'ask', maxSteps: 20 } });
});

async function createProvider(request, name, overrides = {}) {
  const response = await request.post('/api/providers', { data: { name, protocol: 'responses', baseUrl: modelUrl, apiKey: 'test-key', models: [{ id: 'shared-model', name: '共享模型' }], ...overrides } });
  expect(response.ok()).toBe(true);
  return (await response.json()).providers.find(provider => provider.name === name);
}

async function ready(page) {
  await page.goto('/');
  await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
  await expect(trigger(page)).toBeEnabled();
}

test('saved models can be selected directly after returning from management without a default', async ({ page }) => {
  await ready(page);
  const prompt = page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
  await prompt.fill('配置后保留我的任务草稿');
  await openProviders(page);
  const provider = await addProvider(page, { name: '工作台供应商', baseUrl: modelUrl });
  await addModel(page, { id: 'saved-model', name: '已经配置的模型' });
  await returnToStudio(page);
  await expect(prompt).toHaveValue('配置后保留我的任务草稿');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  const workspaceUrl = page.url();
  await trigger(page).click();
  await expect(choice(page, '工作台供应商', 'saved-model')).toBeVisible();
  expect(page.url()).toBe(workspaceUrl);
  await choice(page, '工作台供应商', 'saved-model').click();
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText('工作台供应商 / saved-model');
  await expect(prompt).toHaveValue('配置后保留我的任务草稿');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  expect((await readCatalog(page)).active).toEqual({ providerId: provider.id, modelId: 'saved-model' });
  expect(page.url()).toBe(workspaceUrl);
  await page.reload();
  await expect(trigger(page)).toContainText('工作台供应商 / saved-model');
});

test('search groups matching models by provider and prevents unusable selections', async ({ page, request }, testInfo) => {
  await createProvider(request, 'Responses 供应商');
  const anthropic = await createProvider(request, 'Messages 供应商', { protocol: 'anthropic', models: [{ id: 'shared-model', name: '消息模型' }, { id: 'disabled-model', enabled: false }] });
  await createProvider(request, '停用供应商', { enabled: false });
  await createProvider(request, '无凭据供应商', { apiKey: '' });
  await ready(page);
  await trigger(page).click();
  await expect(choice(page, '停用供应商')).toBeDisabled();
  await expect(choice(page, '无凭据供应商')).toBeDisabled();
  await expect(choice(page, 'Messages 供应商', 'disabled-model')).toBeDisabled();
  await expect(picker(page)).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('workspace-model-picker.png') });
  const search = picker(page).getByRole('searchbox', { name: '搜索已配置模型' });
  await search.fill('消息模型');
  await expect(choice(page, 'Messages 供应商')).toBeVisible();
  await expect(choice(page, 'Responses 供应商')).toHaveCount(0);
  await choice(page, 'Messages 供应商').click();
  await expect(trigger(page)).toContainText('Messages 供应商 / shared-model');
  expect((await readCatalog(page)).active).toEqual({ providerId: anthropic.id, modelId: 'shared-model' });
  await trigger(page).click();
  await expect(choice(page, 'Messages 供应商')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice(page, 'Responses 供应商')).toHaveAttribute('aria-pressed', 'false');
});

test('empty catalog stays on the workspace until management is explicitly requested', async ({ page }) => {
  await ready(page);
  const workspaceUrl = page.url();
  await trigger(page).click();
  await expect(picker(page)).toContainText('尚未添加模型');
  expect(page.url()).toBe(workspaceUrl);
  await picker(page).getByRole('button', { name: '管理供应商与模型', exact: true }).click();
  await expectProviders(page);
  await expect(picker(page)).toHaveCount(0);
});

test('loading and activation failures are retryable without losing the prompt or prior selection', async ({ page, request }) => {
  const original = await createProvider(request, '原配置');
  await createProvider(request, '新配置');
  await request.post('/api/providers/active', { data: { providerId: original.id, modelId: 'shared-model' } });
  await ready(page);
  const prompt = page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
  await prompt.fill('失败也不能丢失');
  await page.route('**/api/providers?scope=*', route => route.fulfill({ status: 503, json: { error: '列表暂时不可用' } }), { times: 1 });
  await trigger(page).click();
  await expect(picker(page).getByRole('alert')).toContainText('列表暂时不可用');
  await picker(page).getByRole('button', { name: '重试加载模型', exact: true }).click();
  await expect(choice(page, '新配置')).toBeVisible();
  await page.route('**/api/providers/active?scope=*', route => route.fulfill({ status: 409, json: { error: '模型暂时不可用' } }), { times: 1 });
  await choice(page, '新配置').click();
  await expect(picker(page).getByRole('alert')).toContainText('模型暂时不可用');
  expect((await readCatalog(page)).active.providerId).toBe(original.id);
  await expect(trigger(page)).toContainText('原配置 / shared-model');
  await expect(prompt).toHaveValue('失败也不能丢失');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  await choice(page, '新配置').click();
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText('新配置 / shared-model');
  await expect(prompt).toHaveValue('失败也不能丢失');
});

test('a committed selection with failed settings synchronization blocks sending until retry succeeds', async ({ page, request }) => {
  const original = await createProvider(request, '原配置');
  const next = await createProvider(request, '已切换配置');
  await request.post('/api/providers/active', { data: { providerId: original.id, modelId: 'shared-model' } });
  await ready(page);
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('等同步成功再发');
  await page.route('**/api/settings', route => route.fulfill({ status: 503, json: { error: '状态同步暂时不可用' } }));
  await trigger(page).click();
  await choice(page, '已切换配置').click();
  await expect(picker(page).getByRole('alert')).toContainText('模型已切换，但工作台状态同步失败');
  expect((await readCatalog(page)).active.providerId).toBe(next.id);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  await page.unroute('**/api/settings');
  await picker(page).getByRole('button', { name: '重试同步模型', exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText('已切换配置 / shared-model');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toHaveValue('等同步成功再发');
});

test('switching blocks submission until the server confirms the new default', async ({ page, request }) => {
  const original = await createProvider(request, '原配置');
  await createProvider(request, '新配置');
  await request.post('/api/providers/active', { data: { providerId: original.id, modelId: 'shared-model' } });
  await ready(page);
  const prompt = page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
  await prompt.fill('切换完成后再发送');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/providers/active?scope=*', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); }, { times: 1 });
  try {
    await trigger(page).click();
    await choice(page, '新配置').click();
    await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await prompt.press('Enter');
    expect(await (await request.get('/api/sessions')).json()).toEqual([]);
    release();
    await expect(trigger(page)).toHaveAttribute('aria-busy', 'false');
    await expect(trigger(page)).toContainText('新配置 / shared-model');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  } finally { release(); }
});

test('running tasks retain their model and draft while the next default changes in place', async ({ page, request }) => {
  const original = await createProvider(request, '任务原模型');
  const next = await createProvider(request, '下一次模型', { protocol: 'anthropic', models: [{ id: 'next-model' }] });
  await request.post('/api/providers/active', { data: { providerId: original.id, modelId: 'shared-model' } });
  await ready(page);
  const prompt = page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
  await prompt.fill('[test:write]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  const sessions = await (await request.get('/api/sessions')).json();
  const sessionId = sessions[0].id;
  await prompt.fill('下一条任务草稿');
  await trigger(page).click();
  await expect(picker(page)).toContainText('当前任务保持原模型');
  await choice(page, '下一次模型', 'next-model').click();
  await expect(trigger(page)).toContainText('下一次模型 / next-model');
  await expect(prompt).toHaveValue('下一条任务草稿');
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  expect((await (await request.get(`/api/sessions/${sessionId}`)).json()).run).toMatchObject({ providerId: original.id, model: 'shared-model', status: 'waiting_approval' });
  await page.getByRole('button', { name: '停止运行' }).click();
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  expect((await (await request.get(`/api/sessions/${sessionId}`)).json()).run).toMatchObject({ providerId: next.id, model: 'next-model', provider: 'anthropic', status: 'completed' });
});

test('mobile keyboard and outside dismissal work without overflow or unwanted navigation', async ({ page, request }, testInfo) => {
  await createProvider(request, '手机供应商', { models: [{ id: 'small-model' }, { id: 'large-model' }] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  await trigger(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect(picker(page).getByRole('searchbox')).toBeFocused();
  await expect(choice(page, '手机供应商', 'small-model')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(choice(page, '手机供应商', 'small-model')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(choice(page, '手机供应商', 'large-model')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trigger(page)).toContainText('手机供应商 / large-model');
  await trigger(page).click();
  await expect(choice(page, '手机供应商', 'large-model')).toBeVisible();
  const box = await picker(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace-model-picker-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await trigger(page).click();
  await page.locator('.breadcrumb-current').click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/#\/providers/);
});

test('an open picker follows catalog and default changes from another browser tab', async ({ page, context, request }) => {
  const first = await createProvider(request, '跨标签供应商');
  await ready(page);
  await trigger(page).click();
  await expect(choice(page, '跨标签供应商')).toBeVisible();
  const second = await context.newPage();
  await ready(second);
  await trigger(second).click();
  await choice(second, '跨标签供应商').click();
  await expect(trigger(page)).toContainText('跨标签供应商 / shared-model');
  await expect(choice(page, '跨标签供应商')).toHaveAttribute('aria-pressed', 'true');
  await request.post(`/api/providers/${first.id}/models`, { data: { models: [{ id: 'newly-added' }] } });
  await expect(choice(page, '跨标签供应商', 'newly-added')).toBeVisible();
  await request.delete(`/api/providers/${first.id}/models/newly-added`);
  await expect(choice(page, '跨标签供应商', 'newly-added')).toHaveCount(0);
  await second.close();
});

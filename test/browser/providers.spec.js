import { test, expect } from '@playwright/test';
import { activateModel, addModel, addProvider, clearCatalog, expectProviders, modelRow, openProviders, providerPage, readCatalog, returnToStudio, testModel } from './provider-helpers.js';

const modelUrl = 'http://127.0.0.1:3418/v1';

test.beforeEach(async ({ request }) => {
  const sessions = await (await request.get('/api/sessions')).json();
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await clearCatalog(request);
  await request.patch('/api/settings', { data: { approval: 'ask', maxSteps: 20, systemPrompt: '' } });
});

async function enterEmptyCatalog(page) {
  await page.goto('/#/providers');
  await expectProviders(page);
}

async function configuredProvider(page, name = '测试供应商', modelId = 'test-model', protocol = 'responses') {
  const provider = await addProvider(page, { name, protocol, baseUrl: modelUrl });
  await addModel(page, { id: modelId, name: `${modelId} 显示名称` });
  await activateModel(page, modelId);
  return provider;
}

async function confirmDelete(page, kind) {
  const confirmation = providerPage(page).getByRole('region', { name: `删除这个${kind}？`, exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toBeInViewport();
  await expect(confirmation).toBeFocused();
  await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
}

test('all native protocols discover selected models, test, activate and run without exposing keys', async ({ page, request }) => {
  await enterEmptyCatalog(page);
  for (const protocol of ['responses', 'openai', 'anthropic']) {
    const provider = await addProvider(page, { name: `${protocol} 浏览器供应商`, protocol, baseUrl: modelUrl });
    expect(provider).toMatchObject({ protocol, enabled: true, hasApiKey: true, apiKeySource: 'saved' });
    await expect(providerPage(page).getByLabel('API 密钥', { exact: true })).toHaveValue('');
    await expect(providerPage(page).getByRole('combobox', { name: 'API 协议', exact: true }).locator('option')).toHaveCount(4);
    const modelId = `${protocol}-browser-model`;
    await addModel(page, { id: modelId, name: `${protocol} 默认模型`, maxTokens: 2048, temperature: .3 });
    const beforeDiscovery = await readCatalog(page);
    await providerPage(page).getByRole('button', { name: '从接口获取模型列表', exact: true }).click();
    const small = providerPage(page).getByRole('checkbox', { name: '导入模型 discovered-small', exact: true });
    const large = providerPage(page).getByRole('checkbox', { name: '导入模型 discovered-large', exact: true });
    await expect(small).toBeVisible();
    await expect(large).toBeVisible();
    expect(await readCatalog(page)).toEqual(beforeDiscovery);
    await small.check();
    await large.uncheck();
    await providerPage(page).getByRole('button', { name: /^导入所选模型/ }).click();
    await expect(modelRow(page, 'discovered-small')).toBeVisible();
    await expect(modelRow(page, 'discovered-large')).toHaveCount(0);
    const imported = (await readCatalog(page)).providers.find(entry => entry.id === provider.id);
    expect(imported.models.map(model => model.id).sort()).toEqual(['discovered-small', modelId].sort());
    expect(imported.models.find(model => model.id === modelId)).toMatchObject({ name: `${protocol} 默认模型`, maxTokens: 2048, temperature: .3 });
    await providerPage(page).getByRole('button', { name: '从接口获取模型列表', exact: true }).click();
    await expect(providerPage(page).getByRole('checkbox', { name: '导入模型 discovered-small', exact: true })).toBeDisabled();
    await expect(providerPage(page).getByRole('checkbox', { name: '导入模型 discovered-small', exact: true })).toBeChecked();
    await providerPage(page).getByRole('button', { name: '关闭远端模型发现', exact: true }).click();
    const beforeTest = await readCatalog(page);
    await testModel(page, modelId);
    expect(await readCatalog(page)).toEqual(beforeTest);
    await activateModel(page, modelId);
    await returnToStudio(page);
    await page.getByRole('button', { name: /新建会话/ }).click();
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(`通过 ${protocol} 读取真实项目`);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
    const settings = await (await request.get('/api/settings')).json();
    expect(settings).toMatchObject({ provider: protocol, model: modelId, configured: true });
    expect(JSON.stringify(settings)).not.toContain('test-key');
    await openProviders(page);
  }
  const saved = await readCatalog(page);
  expect(saved.providers).toHaveLength(3);
  expect(JSON.stringify(saved)).not.toContain('test-key');
  expect(saved.providers.every(provider => !Object.hasOwn(provider, 'apiKey'))).toBe(true);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('test-key');
  await page.reload();
  await expectProviders(page);
  expect(await readCatalog(page)).toEqual(saved);
  await expect(providerPage(page).getByLabel('API 密钥', { exact: true })).toHaveValue('');
});

test('provider and model edits, disabling and deletion respect active selection guards', async ({ page, request }) => {
  await enterEmptyCatalog(page);
  const provider = await configuredProvider(page, '可编辑供应商', 'primary-model');
  const management = providerPage(page);
  await expect(management.getByRole('button', { name: '禁用供应商', exact: true })).toBeDisabled();
  await expect(management.getByRole('button', { name: '删除供应商', exact: true })).toBeDisabled();
  await expect(modelRow(page, 'primary-model').getByRole('button', { name: '禁用模型', exact: true })).toBeDisabled();
  await expect(modelRow(page, 'primary-model').getByRole('button', { name: '删除模型', exact: true })).toBeDisabled();
  expect((await request.delete(`/api/providers/${provider.id}`)).status()).toBe(409);
  expect((await request.patch(`/api/providers/${provider.id}`, { data: { enabled: false } })).status()).toBe(409);
  expect((await request.delete(`/api/providers/${provider.id}/models/primary-model`)).status()).toBe(409);
  expect((await request.patch(`/api/providers/${provider.id}/models/primary-model`, { data: { id: 'changed-active-id' } })).status()).toBe(409);
  await modelRow(page, 'primary-model').getByRole('button', { name: '编辑模型', exact: true }).click();
  await expect(management.getByRole('textbox', { name: '模型 ID', exact: true })).toBeDisabled();
  await management.getByRole('button', { name: '保存模型', exact: true }).click();
  await addModel(page, { id: 'spare-model', name: '待编辑模型' });
  await modelRow(page, 'spare-model').getByRole('button', { name: '禁用模型', exact: true }).click();
  await expect(modelRow(page, 'spare-model').getByRole('button', { name: '设为默认', exact: true })).toBeDisabled();
  expect((await readCatalog(page)).providers[0].models.find(model => model.id === 'spare-model').enabled).toBe(false);
  await modelRow(page, 'spare-model').getByRole('button', { name: '启用模型', exact: true }).click();
  await modelRow(page, 'spare-model').getByRole('button', { name: '编辑模型', exact: true }).click();
  await management.getByRole('textbox', { name: '模型 ID', exact: true }).fill('renamed-model');
  await management.getByRole('textbox', { name: '模型显示名称', exact: true }).fill('已经重命名的模型');
  await management.getByRole('spinbutton', { name: '模型响应 Token 上限', exact: true }).fill('1024');
  await management.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(modelRow(page, 'renamed-model')).toContainText('已经重命名的模型');
  await expect(modelRow(page, 'spare-model')).toHaveCount(0);
  await activateModel(page, 'renamed-model');
  await modelRow(page, 'primary-model').getByRole('button', { name: '删除模型', exact: true }).click();
  await confirmDelete(page, '模型');
  await expect(modelRow(page, 'primary-model')).toHaveCount(0);
  await management.getByRole('button', { name: '取消默认选择', exact: true }).click();
  await expect.poll(async () => (await readCatalog(page)).active).toBeNull();
  await management.getByRole('button', { name: '禁用供应商', exact: true }).click();
  await expect(modelRow(page, 'renamed-model').getByRole('button', { name: '设为默认', exact: true })).toBeDisabled();
  expect((await readCatalog(page)).providers[0].enabled).toBe(false);
  await management.getByRole('button', { name: '启用供应商', exact: true }).click();
  await management.getByRole('textbox', { name: '供应商名称', exact: true }).fill('已经重命名的供应商');
  await management.getByRole('button', { name: '保存供应商', exact: true }).click();
  await expect(management.getByRole('button', { name: '选择供应商 已经重命名的供应商', exact: true })).toBeVisible();
  await management.getByRole('button', { name: '删除供应商', exact: true }).click();
  await confirmDelete(page, '供应商');
  expect(await readCatalog(page)).toEqual({ providers: [], active: null });
});

test('failed discovery and connection tests report real authentication errors without changing the default', async ({ page }) => {
  await enterEmptyCatalog(page);
  await configuredProvider(page, '有效供应商', 'valid-model');
  const active = (await readCatalog(page)).active;
  const invalid = await addProvider(page, { name: '待修复供应商', baseUrl: modelUrl, apiKey: 'invalid-key' });
  await addModel(page, { id: 'invalid-model' });
  await modelRow(page, 'invalid-model').getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(providerPage(page).getByRole('alert')).toContainText('401');
  await expect(providerPage(page).getByRole('status').filter({ hasText: '连接成功' })).toHaveCount(0);
  expect((await readCatalog(page)).active).toEqual(active);
  await providerPage(page).getByRole('button', { name: '从接口获取模型列表', exact: true }).click();
  await expect(providerPage(page).getByRole('alert')).toContainText('401');
  expect((await readCatalog(page)).providers.find(provider => provider.id === invalid.id).models.map(model => model.id)).toEqual(['invalid-model']);
  expect(JSON.stringify(await readCatalog(page))).not.toContain('invalid-key');
  await providerPage(page).getByLabel('API 密钥', { exact: true }).fill('test-key');
  await providerPage(page).getByRole('button', { name: '保存供应商', exact: true }).click();
  await expect(providerPage(page).getByLabel('API 密钥', { exact: true })).toHaveValue('');
  await testModel(page, 'invalid-model');
  expect((await readCatalog(page)).active).toEqual(active);
  await providerPage(page).getByRole('checkbox', { name: '清除已保存的密钥', exact: true }).check();
  await providerPage(page).getByRole('button', { name: '保存供应商', exact: true }).click();
  await expect.poll(async () => (await readCatalog(page)).providers.find(provider => provider.id === invalid.id).apiKeySource).not.toBe('saved');
  await expect(providerPage(page).getByLabel('API 密钥', { exact: true })).toHaveValue('');
  expect((await readCatalog(page)).active).toEqual(active);
});

test('provider loading and retry states follow real catalog requests', async ({ page }) => {
  let release;
  let received;
  const gate = new Promise(resolve => { release = resolve; });
  const responseReady = new Promise(resolve => { received = resolve; });
  await page.route('**/api/provider-scopes', async route => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto('/#/providers');
    await responseReady;
    await expect(providerPage(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('status', { name: '正在载入供应商', exact: true })).toBeVisible();
    release();
    await expectProviders(page);
    await expect(providerPage(page)).toHaveAttribute('aria-busy', 'false');
  } finally { release(); }
  let unavailable = true;
  await page.route('**/api/provider-scopes', route => unavailable ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试：供应商目录暂时不可用' }) }) : route.continue());
  await page.reload();
  await expect(providerPage(page).getByRole('alert')).toContainText('供应商目录暂时不可用');
  unavailable = false;
  await providerPage(page).getByRole('button', { name: '重试载入供应商', exact: true }).click();
  await expect(providerPage(page).getByRole('alert')).toHaveCount(0);
  await expect(providerPage(page).getByRole('button', { name: '新增供应商', exact: true })).toBeVisible();
});

test('independent pages preserve drafts, session selection, running snapshots and SSE across browser history', async ({ page, request }) => {
  let eventConnections = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/events') eventConnections += 1; });
  await enterEmptyCatalog(page);
  const original = await configuredProvider(page, '运行中的原供应商', 'original-model');
  await returnToStudio(page);
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('保持后台审批运行 [test:write]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  const sessions = await (await request.get('/api/sessions')).json();
  const sessionId = sessions[0].id;
  const draft = '切换供应商页面也不能丢失的下一条任务';
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(draft);
  await openProviders(page);
  await configuredProvider(page, '后续任务的新供应商', 'next-model', 'anthropic');
  expect((await request.delete(`/api/providers/${original.id}`)).status()).toBe(409);
  expect((await request.patch(`/api/providers/${original.id}/models/original-model`, { data: { enabled: false } })).status()).toBe(409);
  const running = await (await request.get(`/api/sessions/${sessionId}`)).json();
  const approval = running.events.findLast(event => event.type === 'approval.required').data;
  expect((await request.post(`/api/approvals/${approval.id}`, { data: { approved: false } })).ok()).toBe(true);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${sessionId}`)).json()).run.status).toBe('completed');
  await returnToStudio(page);
  await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toHaveValue(draft);
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  await expect(page.getByRole('button', { name: '批准执行' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('harness.session'))).toBe(sessionId);
  await page.goBack();
  await expectProviders(page);
  await page.goForward();
  await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toHaveValue(draft);
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  expect(eventConnections).toBe(1);
});

test('unsaved edits need an explicit discard before leaving the management page', async ({ page }) => {
  await page.goto('/');
  await openProviders(page);
  await configuredProvider(page, '保留的供应商名称');
  const before = await readCatalog(page);
  await providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true }).fill('未保存的供应商名称');
  await providerPage(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expectProviders(page);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('未保存的供应商名称');
  expect(await readCatalog(page)).toEqual(before);
  await page.goBack();
  await expect(page.getByRole('region', { name: '有未保存的更改', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expectProviders(page);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('未保存的供应商名称');
  await providerPage(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await page.getByRole('button', { name: '放弃更改并继续', exact: true }).click();
  await expect(providerPage(page)).not.toBeVisible();
  await openProviders(page);
  await expect(providerPage(page).getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('保留的供应商名称');
  expect(await readCatalog(page)).toEqual(before);
});

test('mobile reduced-motion management supports model import and activation without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enterEmptyCatalog(page);
  await addProvider(page, { name: '手机供应商', protocol: 'anthropic', baseUrl: modelUrl });
  await providerPage(page).getByRole('button', { name: '从接口获取模型列表', exact: true }).click();
  await providerPage(page).getByRole('checkbox', { name: '导入模型 discovered-small', exact: true }).check();
  await providerPage(page).getByRole('checkbox', { name: '导入模型 discovered-large', exact: true }).check();
  await providerPage(page).getByRole('button', { name: /^导入所选模型/ }).click();
  await expect(modelRow(page, 'discovered-small')).toBeVisible();
  await expect(modelRow(page, 'discovered-large')).toBeVisible();
  await activateModel(page, 'discovered-small');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations === Infinity || Number(animation.effect?.getTiming().duration) > 50).length)).toBe(0);
  await returnToStudio(page);
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('手机配置后发送');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

test('model context windows can be edited and take effect for the selected model', async ({ page, request }) => {
  await enterEmptyCatalog(page);
  await configuredProvider(page);
  const catalog = await readCatalog(page);
  const modelId = catalog.providers[0].models[0].id;
  await modelRow(page, modelId).getByRole('button', { name: '编辑模型', exact: true }).click();
  await page.getByRole('spinbutton', { name: '模型上下文窗口', exact: true }).fill('200000');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(modelRow(page, modelId)).toContainText('上下文窗口：200000 tokens');
  expect((await (await request.get('/api/settings')).json()).maxContextTokens).toBe(200000);
  await page.reload();
  await expect(modelRow(page, modelId)).toContainText('上下文窗口：200000 tokens');
});

test('runtime policy has its own page and saves without mutating provider identities', async ({ page, request }) => {
  await enterEmptyCatalog(page);
  await configuredProvider(page);
  const before = await readCatalog(page);
  await page.getByRole('navigation', { name: '设置页面' }).getByRole('link', { name: '运行策略', exact: true }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  const policy = page.getByRole('main', { name: '运行策略', exact: true });
  await expect(policy).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await policy.getByRole('combobox', { name: '工具审批策略', exact: true }).selectOption('readonly');
  await expect(policy.getByRole('spinbutton', { name: '最大迭代步数', exact: true })).toHaveCount(0);
  await expect(policy.getByRole('spinbutton', { name: '单次任务 Token 预算', exact: true })).toHaveCount(0);
  await policy.getByRole('spinbutton', { name: '自动压缩阈值', exact: true }).fill('0.75');
  await policy.getByRole('textbox', { name: '系统提示词', exact: true }).fill('保留用户现有文件，只进行检查。');
  await policy.getByRole('button', { name: '保存运行策略', exact: true }).click();
  const savedNotice = policy.getByRole('status').filter({ hasText: '运行策略已保存' });
  await expect(savedNotice).toBeVisible();
  await expect(savedNotice).toBeInViewport();
  expect(await (await request.get('/api/settings')).json()).toMatchObject({ approval: 'readonly', contextCompactionThreshold: 0.75, systemPrompt: '保留用户现有文件，只进行检查。' });
  expect(await readCatalog(page)).toEqual(before);
  await policy.getByRole('navigation', { name: '设置页面' }).getByRole('link', { name: '供应商与模型', exact: true }).click();
  await expectProviders(page);
  await returnToStudio(page);
  await expect(page.locator('.conversation-mode')).toContainText('只读模式');
});

import { test, expect } from '@playwright/test';
import { startModelServer } from '../fixtures/model-server.js';
import { addModel, addProvider, clearCatalog, expectProviders, modelRow, providerPage, readCatalog } from './provider-helpers.js';

const defaultModelUrl = 'http://127.0.0.1:3418/v1';

test.beforeEach(async ({ request }) => {
  const sessions = await (await request.get('/api/sessions')).json();
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await clearCatalog(request);
  await request.patch('/api/settings', { data: { approval: 'ask', maxSteps: 20, systemPrompt: '' } });
});

function results(page) {
  return providerPage(page).getByRole('region', { name: '远端模型发现', exact: true });
}

function fetchCard(page) {
  return providerPage(page).getByRole('region', { name: '接口模型列表', exact: true });
}

async function enterProviders(page) {
  await page.goto('/#/providers');
  await expectProviders(page);
}

async function fillNewProvider(page, { name, baseUrl, apiKey, protocol = 'openai' }) {
  const management = providerPage(page);
  await management.getByRole('button', { name: '新增供应商', exact: true }).click();
  await management.getByRole('textbox', { name: '供应商名称', exact: true }).fill(name);
  await management.getByRole('combobox', { name: 'API 协议', exact: true }).selectOption(protocol);
  await management.getByRole('textbox', { name: 'API Base URL', exact: true }).fill(baseUrl);
  await management.getByLabel('API 密钥', { exact: true }).fill(apiKey);
}

test('a new local-port provider saves before fetching its real model list', async ({ page }, testInfo) => {
  const local = await startModelServer({ apiKey: 'local-port-secret', models: [{ id: 'local-alpha', name: 'Local Alpha' }, { id: 'local-beta', name: 'Local Beta' }] });
  let release;
  let received;
  const gate = new Promise(resolve => { release = resolve; });
  const responseReady = new Promise(resolve => { received = resolve; });
  const operations = [];
  page.on('request', request => {
    if (['POST', 'PATCH'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/providers')) operations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await enterProviders(page);
    await fillNewProvider(page, { name: '本地端口供应商', baseUrl: local.url, apiKey: 'local-port-secret' });
    await page.route('**/api/providers/*/discover?scope=*', async route => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
    }, { times: 1 });
    const fetch = fetchCard(page).getByRole('button', { name: '保存并获取模型列表', exact: true });
    await fetch.click();
    await responseReady;
    await expect(fetch).toHaveAttribute('aria-busy', 'true');
    await expect(fetch).toBeDisabled();
    await expect(page.getByRole('status', { name: '正在获取模型列表', exact: true })).toBeVisible();
    const saved = await readCatalog(page);
    expect(saved.providers).toHaveLength(1);
    expect(saved.providers[0]).toMatchObject({ name: '本地端口供应商', protocol: 'openai', baseUrl: local.url, hasApiKey: true, models: [] });
    expect(saved.active).toBeNull();
    expect(JSON.stringify(saved)).not.toContain('local-port-secret');
    expect(operations).toEqual(['POST /api/providers', `POST /api/providers/${saved.providers[0].id}/discover`]);
    expect(local.requests).toEqual([{ path: '/v1/models', method: 'GET', body: null, authentication: 'bearer', anthropicVersion: null }]);
    release();
    await expect(results(page).getByRole('heading', { name: '已获取 2 个模型', exact: true })).toBeVisible();
    await expect(results(page).getByRole('checkbox', { name: '导入模型 local-alpha', exact: true })).toBeVisible();
    await expect(results(page).getByRole('checkbox', { name: '导入模型 local-beta', exact: true })).toBeVisible();
    await expect(providerPage(page).getByLabel('API 密钥', { exact: true })).toHaveValue('');
    expect((await readCatalog(page)).providers[0].models).toEqual([]);
    await results(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('api-model-list-desktop.png'), fullPage: true });
  } finally {
    release();
    await local.close();
  }
});

test('fetching saves a changed address and key while preserving an unfinished model editor', async ({ page }) => {
  const local = await startModelServer({ apiKey: 'replacement-port-key', models: [{ id: 'replacement-model', name: 'Replacement Model' }] });
  try {
    await enterProviders(page);
    const original = await addProvider(page, { name: '原始连接', baseUrl: defaultModelUrl });
    await addModel(page, { id: 'manual-model', name: '已保存的模型名称', maxTokens: 1024 });
    const management = providerPage(page);
    await management.getByRole('textbox', { name: '供应商名称', exact: true }).fill('新的本地连接');
    await management.getByRole('textbox', { name: 'API Base URL', exact: true }).fill(local.url);
    await management.getByLabel('API 密钥', { exact: true }).fill('replacement-port-key');
    await fetchCard(page).getByRole('button', { name: '保存并获取模型列表', exact: true }).click();
    await expect(results(page).getByRole('checkbox', { name: '导入模型 replacement-model', exact: true })).toBeVisible();
    const saved = await readCatalog(page);
    expect(saved.providers).toHaveLength(1);
    expect(saved.providers[0]).toMatchObject({ id: original.id, name: '新的本地连接', baseUrl: local.url, hasApiKey: true });
    expect(saved.providers[0].models).toEqual([expect.objectContaining({ id: 'manual-model', name: '已保存的模型名称', maxTokens: 1024 })]);
    expect(local.requests.filter(request => request.path === '/v1/models')).toHaveLength(1);
    await expect(management.getByLabel('API 密钥', { exact: true })).toHaveValue('');
    await modelRow(page, 'manual-model').getByRole('button', { name: '编辑模型', exact: true }).click();
    await management.getByRole('textbox', { name: '模型 ID', exact: true }).fill('unfinished-model-id');
    await management.getByRole('textbox', { name: '模型显示名称', exact: true }).fill('未保存但必须保留的模型草稿');
    await management.getByRole('spinbutton', { name: '模型响应 Token 上限', exact: true }).fill('8192');
    await expect(management.getByRole('textbox', { name: '供应商名称', exact: true })).toBeDisabled();
    await expect(management.getByRole('textbox', { name: 'API Base URL', exact: true })).toBeDisabled();
    await expect(management.getByLabel('API 密钥', { exact: true })).toBeDisabled();
    await fetchCard(page).getByRole('button', { name: '从接口获取模型列表', exact: true }).click();
    await expect.poll(() => local.requests.filter(request => request.path === '/v1/models').length).toBe(2);
    await expect(results(page).getByRole('heading', { name: '已获取 1 个模型', exact: true })).toBeVisible();
    await expect(management.getByRole('textbox', { name: '模型 ID', exact: true })).toHaveValue('unfinished-model-id');
    await expect(management.getByRole('textbox', { name: '模型显示名称', exact: true })).toHaveValue('未保存但必须保留的模型草稿');
    await expect(management.getByRole('spinbutton', { name: '模型响应 Token 上限', exact: true })).toHaveValue('8192');
    await expect(page.getByRole('region', { name: '有未保存的更改', exact: true })).toHaveCount(0);
    expect((await readCatalog(page)).providers[0].models[0]).toMatchObject({ id: 'manual-model', name: '已保存的模型名称', maxTokens: 1024 });
    await management.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(modelRow(page, 'unfinished-model-id')).toContainText('未保存但必须保留的模型草稿');
  } finally { await local.close(); }
});

test('mobile search selects only matching new models, clears selection and prevents duplicate imports', async ({ page }, testInfo) => {
  const local = await startModelServer({ models: [{ id: 'code-small', name: 'Code Small' }, { id: 'code-large', name: 'Code Large' }, { id: 'chat-general', name: 'Chat General' }, { id: 'other-remote', name: 'Other Remote' }, { id: 'code-large', name: 'Duplicate Code Large' }] });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await enterProviders(page);
    await addProvider(page, { name: '手机端口连接', baseUrl: local.url });
    await addModel(page, { id: 'code-small', name: '保留本地自定义名', maxTokens: 1024 });
    await fetchCard(page).getByRole('button', { name: '从接口获取模型列表', exact: true }).click();
    await expect(results(page).getByRole('heading', { name: '已获取 4 个模型', exact: true })).toBeVisible();
    const existing = results(page).getByRole('checkbox', { name: '导入模型 code-small', exact: true });
    await expect(existing).toBeDisabled();
    await expect(existing).toBeChecked();
    await results(page).getByRole('searchbox', { name: '搜索远端模型', exact: true }).fill('code');
    await expect(results(page)).toContainText('当前匹配 2 个 · 可导入 1 个');
    await results(page).getByRole('button', { name: '全选当前搜索结果', exact: true }).click();
    await expect(results(page).getByRole('checkbox', { name: '导入模型 code-large', exact: true })).toBeChecked();
    await results(page).getByRole('button', { name: '清空选择', exact: true }).click();
    await expect(results(page).getByRole('checkbox', { name: '导入模型 code-large', exact: true })).not.toBeChecked();
    await expect(existing).toBeChecked();
    await expect(results(page).getByRole('button', { name: '导入所选模型', exact: true })).toBeDisabled();
    await results(page).getByRole('button', { name: '全选当前搜索结果', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await results(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('api-model-list-mobile.png'), fullPage: true });
    await results(page).getByRole('button', { name: '导入所选模型', exact: true }).click();
    await expect(modelRow(page, 'code-large')).toBeVisible();
    let catalog = await readCatalog(page);
    expect(catalog.providers[0].models.map(model => model.id).sort()).toEqual(['code-large', 'code-small']);
    expect(catalog.providers[0].models.find(model => model.id === 'code-small')).toMatchObject({ name: '保留本地自定义名', maxTokens: 1024 });
    await fetchCard(page).getByRole('button', { name: '从接口获取模型列表', exact: true }).click();
    await expect(results(page).getByRole('checkbox', { name: '导入模型 code-large', exact: true })).toBeDisabled();
    await results(page).getByRole('searchbox', { name: '搜索远端模型', exact: true }).fill('chat');
    await results(page).getByRole('button', { name: '全选当前搜索结果', exact: true }).click();
    await results(page).getByRole('button', { name: '导入所选模型', exact: true }).click();
    await expect(modelRow(page, 'chat-general')).toBeVisible();
    catalog = await readCatalog(page);
    expect(catalog.providers[0].models.map(model => model.id).sort()).toEqual(['chat-general', 'code-large', 'code-small']);
  } finally { await local.close(); }
});

test('failed fetching keeps the saved provider, retries without recreating it and discards stale results', async ({ page }) => {
  const local = await startModelServer({ apiKey: 'correct-port-key', models: [{ id: 'recovered-model', name: 'Recovered Model' }] });
  const creates = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/providers') creates.push(request); });
  try {
    await enterProviders(page);
    await fillNewProvider(page, { name: '失败后保留的连接', baseUrl: local.url, apiKey: 'wrong-port-key' });
    await fetchCard(page).getByRole('button', { name: '保存并获取模型列表', exact: true }).click();
    await expect(providerPage(page).getByRole('alert')).toContainText('供应商已保存');
    await expect(providerPage(page).getByRole('alert')).toContainText('401');
    const failed = await readCatalog(page);
    expect(failed.providers).toHaveLength(1);
    expect(failed.providers[0]).toMatchObject({ name: '失败后保留的连接', baseUrl: local.url, hasApiKey: true, models: [] });
    expect(JSON.stringify(failed)).not.toContain('wrong-port-key');
    await providerPage(page).getByRole('button', { name: '重试获取模型列表', exact: true }).click();
    await expect.poll(() => local.requests.filter(request => request.path === '/v1/models').length).toBe(2);
    await expect(providerPage(page).getByRole('alert')).toContainText('401');
    expect(await readCatalog(page)).toEqual(failed);
    await providerPage(page).getByLabel('API 密钥', { exact: true }).fill('correct-port-key');
    await fetchCard(page).getByRole('button', { name: '保存并获取模型列表', exact: true }).click();
    await expect(results(page).getByRole('heading', { name: '已获取 1 个模型', exact: true })).toBeVisible();
    await expect(providerPage(page).getByRole('alert')).toHaveCount(0);
    await expect(providerPage(page).getByLabel('API 密钥', { exact: true })).toHaveValue('');
    expect(local.requests.filter(request => request.path === '/v1/models')).toHaveLength(3);
    expect(creates).toHaveLength(1);
    const recovered = await readCatalog(page);
    expect(recovered.providers).toHaveLength(1);
    expect(recovered.providers[0].id).toBe(failed.providers[0].id);
    expect(recovered.providers[0].models).toEqual([]);
    await results(page).getByRole('checkbox', { name: '导入模型 recovered-model', exact: true }).check();
    await expect(results(page).getByRole('button', { name: '导入所选模型', exact: true })).toBeEnabled();
    await providerPage(page).getByLabel('API 密钥', { exact: true }).fill('wrong-again-port-key');
    await fetchCard(page).getByRole('button', { name: '保存并获取模型列表', exact: true }).click();
    await expect(providerPage(page).getByRole('alert')).toContainText('供应商已保存');
    await expect(providerPage(page).getByRole('alert')).toContainText('401');
    await expect(results(page)).toHaveCount(0);
    await expect(providerPage(page).getByRole('button', { name: '导入所选模型', exact: true })).toHaveCount(0);
    expect(local.requests.filter(request => request.path === '/v1/models')).toHaveLength(4);
    expect((await readCatalog(page)).providers[0]).toMatchObject({ id: failed.providers[0].id, models: [] });
    await providerPage(page).getByLabel('API 密钥', { exact: true }).fill('correct-port-key');
    await fetchCard(page).getByRole('button', { name: '保存并获取模型列表', exact: true }).click();
    await expect(results(page).getByRole('checkbox', { name: '导入模型 recovered-model', exact: true })).toBeVisible();
    await expect(results(page).getByRole('checkbox', { name: '导入模型 recovered-model', exact: true })).not.toBeChecked();
    await expect(results(page).getByRole('button', { name: '导入所选模型', exact: true })).toBeDisabled();
    expect(local.requests.filter(request => request.path === '/v1/models')).toHaveLength(5);
    expect(creates).toHaveLength(1);
    const finalRecovery = await readCatalog(page);
    expect(finalRecovery.providers[0]).toMatchObject({ id: failed.providers[0].id, models: [] });
    await page.reload();
    await expectProviders(page);
    expect(await readCatalog(page)).toEqual(finalRecovery);
    await expect(providerPage(page).getByRole('textbox', { name: 'API Base URL', exact: true })).toHaveValue(local.url);
  } finally { await local.close(); }
});

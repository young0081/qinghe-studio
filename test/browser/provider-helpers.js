import { expect } from '@playwright/test';

export function providerPage(page) {
  return page.getByRole('main', { name: '供应商与模型', exact: true });
}

export function modelRow(page, modelId) {
  return providerPage(page).getByRole('row', { name: modelId, exact: true });
}

export async function pageApi(page, method, pathname, body) {
  return page.evaluate(async ({ method, pathname, body }) => {
    const response = await fetch(pathname, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { ok: response.ok, status: response.status, body: await response.json() };
  }, { method, pathname, body });
}

export async function readCatalog(page) {
  const response = await pageApi(page, 'GET', '/api/providers');
  expect(response.ok).toBe(true);
  return response.body;
}

export async function clearCatalog(request) {
  expect((await request.post('/api/providers/active', { data: { providerId: null, modelId: null } })).ok()).toBe(true);
  const catalog = await (await request.get('/api/providers')).json();
  for (const provider of catalog.providers) expect((await request.delete(`/api/providers/${provider.id}`)).ok()).toBe(true);
}

export async function openProviders(page) {
  await page.getByRole('button', { name: '管理供应商', exact: true }).click();
  await expectProviders(page);
}

export async function expectProviders(page) {
  await expect(page).toHaveURL(/#\/providers$/);
  await expect(providerPage(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: '供应商与模型', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: '正在载入供应商', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function addProvider(page, { name, protocol = 'responses', baseUrl, apiKey = 'test-key' }) {
  const management = providerPage(page);
  await management.getByRole('button', { name: '新增供应商', exact: true }).click();
  await management.getByRole('textbox', { name: '供应商名称', exact: true }).fill(name);
  await management.getByRole('combobox', { name: 'API 协议', exact: true }).selectOption(protocol);
  await management.getByRole('textbox', { name: 'API Base URL', exact: true }).fill(baseUrl);
  await management.getByLabel('API 密钥', { exact: true }).fill(apiKey);
  await management.getByRole('button', { name: '保存供应商', exact: true }).click();
  await expect(management.getByRole('button', { name: `选择供应商 ${name}`, exact: true })).toBeVisible();
  const catalog = await readCatalog(page);
  const provider = catalog.providers.find(entry => entry.name === name);
  expect(provider).toBeTruthy();
  if (apiKey) expect(JSON.stringify(catalog)).not.toContain(apiKey);
  return provider;
}

export async function addModel(page, { id, name = id, maxTokens, temperature }) {
  const management = providerPage(page);
  await management.getByRole('button', { name: '添加模型', exact: true }).click();
  await management.getByRole('textbox', { name: '模型 ID', exact: true }).fill(id);
  await management.getByRole('textbox', { name: '模型显示名称', exact: true }).fill(name);
  if (maxTokens !== undefined) await management.getByRole('spinbutton', { name: '模型响应 Token 上限', exact: true }).fill(String(maxTokens));
  if (temperature !== undefined) await management.getByRole('spinbutton', { name: '模型 Temperature', exact: true }).fill(String(temperature));
  await management.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(modelRow(page, id)).toBeVisible();
  await expect(management.getByRole('status').filter({ hasText: '模型已保存' })).toBeInViewport();
}

export async function activateModel(page, modelId) {
  await modelRow(page, modelId).getByRole('button', { name: '设为默认', exact: true }).click();
  await expect.poll(async () => (await readCatalog(page)).active?.modelId).toBe(modelId);
}

export async function testModel(page, modelId) {
  await modelRow(page, modelId).getByRole('button', { name: '测试连接', exact: true }).click();
  const result = providerPage(page).getByRole('status').filter({ hasText: '连接成功' });
  await expect(result).toContainText(modelId);
  await expect(result).toBeInViewport();
}

export async function returnToStudio(page) {
  await providerPage(page).getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(providerPage(page)).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toBeVisible();
}

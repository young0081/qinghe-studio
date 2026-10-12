import { test, expect } from '@playwright/test';
import { setReasoning } from './reasoning-helpers.js';
import { clearCatalog, modelRow, openProviders, providerPage, returnToStudio } from './provider-helpers.js';

const picker = page => page.locator('.workspace-reasoning');
const promptBox = page => page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务', exact: true });
const settings = async request => (await request.get('/api/settings')).json();

test.beforeEach(async ({ request }) => {
  for (const session of await (await request.get('/api/sessions')).json()) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await clearCatalog(request);
  await request.patch('/api/settings', { data: { provider: 'responses', model: 'test-model', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:3418/v1', approval: 'ask', maxTokens: 4096, maxRunTokens: 100000, reasoning: { mode: 'default' } } });
});

async function ready(page) {
  await page.goto('/');
  await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
  await expect(picker(page).getByRole('slider')).toHaveAttribute('aria-valuetext', /模型默认/);
}


test('workspace effort persists per model, preserves the draft and appears in real run snapshots', async ({ page, request }, testInfo) => {
  await ready(page);
  await promptBox(page).fill('保留草稿并选择思考强度');
  await setReasoning(page, 'xhigh');
  await page.screenshot({ path: testInfo.outputPath('workspace-reasoning.png') });
  await expect(promptBox(page)).toHaveValue('保留草稿并选择思考强度');
  expect((await settings(request)).reasoning).toEqual({ mode: 'effort', effort: 'xhigh' });
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/sessions')).json())[0]?.run?.status).toBe('completed');
  const source = (await (await request.get('/api/sessions')).json())[0];
  expect(source.run.reasoning).toEqual({ mode: 'effort', effort: 'xhigh' });
  const original = await settings(request);
  await request.post(`/api/providers/${original.activeProviderId}/models`, { data: { models: [{ id: 'second-model' }] } });
  await request.post('/api/providers/active', { data: { providerId: original.activeProviderId, modelId: 'second-model' } });
  await expect(picker(page).getByRole('slider')).toHaveAttribute('aria-valuetext', /模型默认/);
  await request.post('/api/providers/active', { data: { providerId: original.activeProviderId, modelId: original.activeModelId } });
  await expect(picker(page).getByRole('slider')).toHaveAttribute('aria-valuetext', /极高/);
  await page.reload();
  await expect(picker(page).getByRole('slider')).toHaveAttribute('aria-valuetext', /极高/);
  await setReasoning(page, 'default');
  expect((await settings(request)).reasoning).toEqual({ mode: 'default' });
});

test('model management edits reasoning for native Messages and the workspace offers adaptive or budget thinking', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { provider: 'anthropic', apiKey: 'test-key' } });
  await ready(page);
  await openProviders(page);
  await modelRow(page, 'test-model').getByRole('button', { name: '编辑模型', exact: true }).click();
  await providerPage(page).getByRole('combobox', { name: '模型思考模式', exact: true }).selectOption('budget');
  await providerPage(page).getByRole('spinbutton', { name: '模型思考 Token 预算', exact: true }).fill('4096');
  await expect(providerPage(page)).toContainText('思考预算必须小于响应 Token 上限');
  await providerPage(page).getByRole('spinbutton', { name: '模型响应 Token 上限', exact: true }).fill('8192');
  await providerPage(page).getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(modelRow(page, 'test-model')).toContainText('预算 4096');
  await returnToStudio(page);
  await expect(picker(page).getByRole('slider')).toHaveAttribute('aria-valuetext', /预算 4096/);
  await picker(page).getByRole('combobox', { name: '思考调节方式', exact: true }).selectOption('effort');
  await expect(picker(page)).toHaveAttribute('aria-busy', 'false');
  await setReasoning(page, 'max');
  expect((await settings(request)).reasoning).toEqual({ mode: 'adaptive', effort: 'max' });
  await promptBox(page).fill('使用自适应思考');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/sessions')).json())[0]?.run?.status).toBe('completed');
});

for (const protocol of ['responses', 'openai']) test(`${protocol} max effort is available in model management and the workspace without mapping to xhigh`, async ({ page, request }) => {
  await request.patch('/api/settings', { data: { provider: protocol, apiKey: 'test-key' } });
  await ready(page);
  await openProviders(page);
  await modelRow(page, 'test-model').getByRole('button', { name: '编辑模型', exact: true }).click();
  await providerPage(page).getByRole('combobox', { name: '模型思考强度', exact: true }).selectOption('max');
  await providerPage(page).getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(modelRow(page, 'test-model')).toContainText('最大');
  await returnToStudio(page);
  await expect(picker(page).getByRole('slider')).toHaveAttribute('aria-valuetext', /最大/);
  await expect(picker(page).getByRole('slider')).toHaveValue('7');
  await setReasoning(page, 'xhigh');
  expect((await settings(request)).reasoning).toEqual({ mode: 'effort', effort: 'xhigh' });
  await setReasoning(page, 'max');
  expect((await settings(request)).reasoning).toEqual({ mode: 'effort', effort: 'max' });
  await page.reload();
  await expect(picker(page).getByRole('slider')).toHaveAttribute('aria-valuetext', /最大/);
  await promptBox(page).fill(`验证 ${protocol} 最大思考强度`);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/sessions')).json())[0]?.run?.status).toBe('completed');
  expect((await (await request.get('/api/sessions')).json())[0].run.reasoning).toEqual({ mode: 'effort', effort: 'max' });
});

test('changing effort during approval applies to the next run, including regenerated branches', async ({ page, request }) => {
  await ready(page);
  await setReasoning(page, 'high');
  await promptBox(page).fill('[test:write]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '批准执行', exact: true })).toBeVisible();
  const source = (await (await request.get('/api/sessions')).json())[0];
  await expect(picker(page)).toContainText('当前任务保持原思考参数');
  await setReasoning(page, 'low');
  expect((await (await request.get(`/api/sessions/${source.id}`)).json()).run.reasoning.effort).toBe('high');
  await page.getByRole('button', { name: '停止运行', exact: true }).click();
  await page.locator(`[data-message-id="${source.messages[0].id}"]`).getByRole('button', { name: '编辑并重发', exact: true }).click();
  const editor = page.getByRole('form', { name: '消息分支编辑器', exact: true });
  await expect(editor).toContainText('思考：低');
  await editor.getByRole('textbox', { name: '重发消息', exact: true }).fill('改为只读取文件');
  await editor.getByRole('button', { name: '新建分支并发送', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/sessions')).json()).find(session => session.branch)?.run?.status).toBe('completed');
  expect((await (await request.get('/api/sessions')).json()).find(session => session.branch).run.reasoning.effort).toBe('low');
});

test('saving blocks task and model changes; failed saves roll back and synchronization can be retried', async ({ page, request }) => {
  await ready(page);
  await promptBox(page).fill('等待思考设置保存');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/providers/*/models/*', async route => { await gate; await route.fulfill({ status: 503, json: { error: '保存暂不可用' } }); }, { times: 1 });
  try {
    await setReasoning(page, 'medium', { wait: false });
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toBeDisabled();
    await expect(picker(page)).toHaveAttribute('aria-busy', 'true');
  } finally { release(); }
  await expect(page.locator('.reasoning-feedback')).toContainText('保存暂不可用');
  expect((await settings(request)).reasoning.mode).toBe('default');
  await expect(picker(page).getByRole('slider')).toHaveValue('0');
  await page.route('**/api/settings', route => route.fulfill({ status: 503, json: { error: '读取状态暂不可用' } }));
  await page.getByRole('button', { name: '重试保存思考设置', exact: true }).click();
  await expect(page.locator('.reasoning-feedback')).toContainText('思考设置已保存');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  await expect(promptBox(page)).toHaveValue('等待思考设置保存');
  await page.unroute('**/api/settings');
  await page.getByRole('button', { name: '重试同步思考设置', exact: true }).click();
  await expect(page.locator('.reasoning-feedback')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  expect((await settings(request)).reasoning.effort).toBe('medium');
});

test('mobile reduced-motion thinking controls and cross-tab updates stay usable without overflow', async ({ page, context, request }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  const other = await context.newPage();
  await ready(other);
  await setReasoning(page, 'high');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace-reasoning-mobile.png') });
  await expect(picker(other).getByRole('slider')).toHaveAttribute('aria-valuetext', /高/);
  const current = await settings(request);
  await request.patch(`/api/providers/${current.activeProviderId}/models/${current.activeModelId}`, { data: { reasoning: { mode: 'effort', effort: 'minimal' } } });
  await expect(picker(page).getByRole('slider')).toHaveAttribute('aria-valuetext', /极低/);
  await other.close();
});

test('old running backends show a version warning and cannot receive unsupported thinking configuration', async ({ page, request }) => {
  await page.route('**/api/health', async route => { const response = await route.fetch(); await route.fulfill({ json: { ...await response.json(), version: '1.2.2' } }); });
  await ready(page);
  await expect(page.locator('.runtime-version-warning')).toContainText('后台 v1.2.2');
  await expect(page.locator('.runtime-version-warning')).toContainText('npm run web');
  await expect(picker(page).getByRole('slider')).toBeDisabled();
  await openProviders(page);
  await modelRow(page, 'test-model').getByRole('button', { name: '编辑模型', exact: true }).click();
  await expect(providerPage(page).getByRole('combobox', { name: '模型思考强度', exact: true })).toBeDisabled();
  await expect(providerPage(page)).toContainText('思考设置已禁用');
  await providerPage(page).getByRole('textbox', { name: '模型显示名称', exact: true }).fill('旧后台仍可修改名称');
  const update = page.waitForRequest(candidate => candidate.method() === 'PATCH' && candidate.url().includes('/models/'));
  await providerPage(page).getByRole('button', { name: '保存模型', exact: true }).click();
  expect((await update).postDataJSON().reasoning).toBeUndefined();
  await expect(modelRow(page, 'test-model')).toContainText('旧后台仍可修改名称');
  expect((await settings(request)).reasoning).toEqual({ mode: 'default' });
});

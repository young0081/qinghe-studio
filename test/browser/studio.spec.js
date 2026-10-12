import { test, expect } from '@playwright/test';
import { activateModel, addModel, addProvider, clearCatalog, expectProviders, returnToStudio, testModel } from './provider-helpers.js';

const modelUrl = 'http://127.0.0.1:3418/v1';

test.beforeEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { provider: 'responses', apiKey: 'test-key', baseUrl: modelUrl, model: 'test-model', approval: 'ask', maxSteps: 20 } });
  const sessions = await (await request.get('/api/sessions')).json();
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
});

async function send(page, prompt) {
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

test('desktop completes a native model task, inspects files and restores a checkpoint', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-welcome.png'), fullPage: true });
  await send(page, '检查工作区 [test:write]');
  await expect(page.getByRole('region', { name: '待审批工具' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  await page.getByRole('button', { name: '批准执行' }).click();
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  await expect(page.getByRole('button', { name: '停止运行' })).toHaveCount(0);
  expect((await request.get('/api/file?path=harness-test.txt')).ok()).toBe(true);
  await page.getByRole('tab', { name: /^文件/ }).click();
  await page.getByRole('button', { name: /README.md/ }).click();
  await expect(page.locator('.file-preview')).toContainText('real isolated test workspace');
  await page.getByRole('tab', { name: /^变更/ }).click();
  await expect(page.locator('.diff-view')).toContainText('Hello from Harness test');
  await page.screenshot({ path: testInfo.outputPath('desktop-completed.png'), fullPage: true });
  await page.getByRole('button', { name: '恢复到修改前' }).click();
  await page.getByRole('button', { name: '确认恢复' }).click();
  await expect(page.locator('.change-card')).toContainText('已恢复');
  expect((await request.get('/api/file?path=harness-test.txt')).ok()).toBe(false);
  await page.reload();
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('switching a waiting task to auto clears the approval and continues immediately', async ({ page, request }) => {
  await page.goto('/');
  await send(page, '[test:write]');
  await expect(page.getByRole('region', { name: '待审批工具' })).toBeVisible();
  await page.goto('/#/settings');
  await page.getByRole('combobox', { name: '工具审批策略', exact: true }).selectOption('auto');
  await page.getByRole('button', { name: '保存运行策略', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '运行策略已保存' })).toBeVisible();
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  await expect(page.getByRole('region', { name: '待审批工具' })).toHaveCount(0);
  expect((await request.get('/api/file?path=harness-test.txt')).ok()).toBe(true);
  const sessions = await (await request.get('/api/sessions')).json();
  expect(sessions[0].events.filter(event => event.type === 'approval.required')).toHaveLength(1);
  expect(sessions[0].events.some(event => event.type === 'approval.resolved' && event.data.status === 'approved')).toBe(true);
  const checkpoint = sessions[0].checkpoints[0];
  expect((await request.post(`/api/sessions/${sessions[0].id}/checkpoints/${checkpoint.id}/restore`, { data: {} })).ok()).toBe(true);
});

test('approval denial, cancellation, and session deletion stay in sync', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await send(page, '[test:write]');
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  expect((await request.get('/api/file?path=harness-test.txt')).ok()).toBe(false);
  await send(page, '第二次审批 [test:write]');
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  await page.getByRole('button', { name: '停止运行' }).click();
  await expect(page.getByText('运行已停止。你可以继续发送消息。')).toBeVisible();
  await expect(page.getByRole('region', { name: '待审批工具' })).toHaveCount(0);
  await page.getByRole('button', { name: /^删除会话/ }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('navigation', { name: '会话列表' }).locator('.session-item')).toHaveCount(0);
  expect(await (await request.get('/api/sessions')).json()).toEqual([]);
});

test('mobile layout supports drawers, native tasks and approvals without overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-welcome.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '打开会话侧栏' }).click();
  await page.getByRole('button', { name: /新建会话/ }).click();
  await send(page, '[test:write]');
  await expect(page.getByRole('region', { name: '待审批工具' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-approval.png'), fullPage: true });
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
  await page.getByRole('button', { name: '切换工作区面板' }).click();
  await page.getByRole('tab', { name: /^活动/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText('运行完成');
  await page.getByRole('button', { name: '关闭工作区面板' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('provider failure is visible and the composer becomes usable again', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { provider: 'responses', apiKey: 'local-test-only', baseUrl: 'http://127.0.0.1:1', model: 'local-test' } });
  await page.goto('/');
  await send(page, '这个请求应该报告连接失败');
  await expect(page.locator('.run-error')).toBeVisible();
  await expect(page.getByRole('button', { name: '停止运行' })).toHaveCount(0);
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('继续');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

test('separate browser tabs observe session creation and deletion', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const second = await context.newPage();
  await second.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await second.goto('/');
  await expect(second.getByText('本地已连接', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /新建会话/ }).click();
  await expect(second.getByRole('navigation', { name: '会话列表' }).locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: /^删除会话/ }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(second.getByRole('navigation', { name: '会话列表' }).locator('.session-item')).toHaveCount(0);
});

test('first-run setup blocks tasks until a provider and active model are configured', async ({ page, request }, testInfo) => {
  await clearCatalog(request);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '配置模型', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('desktop-setup.png'), fullPage: true });
  await page.getByRole('button', { name: '配置模型', exact: true }).click();
  await expectProviders(page);
  await addProvider(page, { name: '首次配置供应商', baseUrl: modelUrl });
  await addModel(page, { id: 'test-model' });
  await testModel(page, 'test-model');
  await page.screenshot({ path: testInfo.outputPath('provider-setup.png'), fullPage: true });
  expect((await (await request.get('/api/settings')).json()).configured).toBe(false);
  await activateModel(page, 'test-model');
  await returnToStudio(page);
  await expect(page.getByRole('button', { name: '配置模型', exact: true })).toHaveCount(0);
  await send(page, '阅读项目');
  await expect(page.getByText(/测试任务已完成：执行了/)).toBeVisible();
});

import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';

const evidence = path.join(os.tmpdir(), 'qinghe-qa-1.13');
const fixtureUrl = 'http://127.0.0.1:3418/automation-fixture';

test.beforeEach(async ({ request }) => {
  await mkdir(evidence, { recursive: true });
  await request.post('/api/automation/stop', { data: {} });
  for (const session of await (await request.get('/api/sessions')).json()) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await request.delete(`/api/sessions/${session.id}`);
  }
  expect((await request.patch('/api/settings', { data: { provider: 'responses', baseUrl: 'http://127.0.0.1:3418/v1', model: 'test-model', apiKey: 'test-key', approval: 'ask', autoApproveTools: [] } })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await request.post('/api/automation/stop', { data: {} });
  await request.patch('/api/settings', { data: { approval: 'ask', autoApproveTools: [] } });
});

async function unobstructed(page, target, live) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  const a = await target.boundingBox();
  const b = await live.boundingBox();
  expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1).toBe(true);
  expect(await target.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`live view never blocks approval; saved browser exemption resumes the run at ${viewport.width}px`, async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await page.setViewportSize(viewport);
    await request.patch('/api/automation', { data: { browser: true } });
    await page.goto('/');
    await expect(page).toHaveTitle('青禾 Studio');
    await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(`[test:browser] ${fixtureUrl}`);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    const live = page.getByRole('complementary', { name: 'Browser 实时画面' });
    const approve = page.getByRole('button', { name: '批准执行', exact: true });
    await expect(live).toBeVisible();
    await expect(approve).toBeVisible();
    await unobstructed(page, approve, live);
    await approve.click();
    await expect(live.getByRole('img')).toBeVisible();
    await expect(page.locator('.approval-arguments')).toContainText('fill');
    await unobstructed(page, approve, live);
    await page.screenshot({ path: path.join(evidence, `live-approval-${viewport.width}.png`) });
    await approve.click();
    await expect(page.locator('.approval-arguments')).toContainText('click');
    const settingsButton = page.getByRole('button', { name: '运行策略', exact: true });
    if (!await settingsButton.isVisible()) await page.getByRole('button', { name: '打开会话侧栏', exact: true }).click();
    await settingsButton.click();
    await expect(live).toHaveCount(0);
    const policy = page.getByRole('main', { name: '运行策略', exact: true });
    await policy.getByRole('checkbox', { name: '免审批 browser', exact: true }).check();
    await policy.getByRole('button', { name: '保存运行策略', exact: true }).click();
    await expect(policy).toContainText('运行策略已保存');
    expect((await (await request.get('/api/settings')).json()).autoApproveTools).toEqual(['browser']);
    expect((await (await request.get('/api/tool-policies')).json()).find(tool => tool.name === 'web_fetch').requiresApproval).toBe(false);
    await policy.getByRole('heading', { name: '免审批工具' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `tool-policy-${viewport.width}.png`) });
    await policy.getByRole('button', { name: '返回工作台', exact: true }).click();
    await expect(page.getByText('浏览器测试已完成：真实页面填写、点击和截图成功。', { exact: true })).toBeVisible();
    await expect(approve).toHaveCount(0);
    await page.reload();
    if (!await settingsButton.isVisible()) await page.getByRole('button', { name: '打开会话侧栏', exact: true }).click();
    await settingsButton.click();
    await expect(policy.getByRole('checkbox', { name: '免审批 browser', exact: true })).toBeChecked();
    await expect(page.locator('vite-error-overlay, nextjs-portal')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/automation/stop', { data: {} });
  await request.patch('/api/settings', { data: { approval: 'ask' } });
});

test.afterEach(async ({ request }) => { await request.post('/api/automation/stop', { data: {} }); });

test('real browser task renders a transient screenshot in the observation page', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { approval: 'auto', provider: 'responses', baseUrl: 'http://127.0.0.1:3418/v1', model: 'test-model', apiKey: 'test-key' } });
  await request.patch('/api/automation', { data: { browser: true } });
  await page.goto('/');
  await page.getByRole('button', { name: /新建会话/ }).click();
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('[test:browser] http://127.0.0.1:3418/automation-fixture');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.message-assistant').last()).toContainText('浏览器测试已完成', { timeout: 25000 });
  await page.getByRole('button', { name: '电脑与浏览器', exact: true }).click();
  const image = page.getByRole('img', { name: '工具截图' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(1280);
  const state = await (await request.get('/api/automation')).json();
  expect(state.captures[0].url).toContain('/automation-fixture');
  expect(state.ownerSessionId).toBeNull();
  await page.getByRole('region', { name: '操作观察台' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/automation-browser.png' });
  await page.getByRole('button', { name: '停止自动化', exact: true }).click();
  await expect(image).toHaveCount(0);
});

test('automation is a dedicated page with explicit consent, live status and emergency stop', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '电脑与浏览器', exact: true }).click();
  await expect(page).toHaveURL(/#\/automation$/);
  const panel = page.getByRole('main', { name: '电脑与浏览器' });
  const browser = panel.getByRole('region', { name: 'Browser 网页操作' });
  await expect(browser.getByRole('button', { name: '启用 Browser' })).toBeDisabled();
  await browser.getByRole('checkbox').check();
  await browser.getByRole('button', { name: '启用 Browser' }).click();
  await expect(browser.getByText('已启用', { exact: true })).toBeVisible();
  expect((await (await request.get('/api/automation')).json()).browser).toBe(true);
  expect((await (await request.get('/api/tools')).json()).some(tool => tool.name === 'browser')).toBe(true);
  await panel.getByRole('button', { name: '返回工作台' }).click();
  await page.getByRole('button', { name: '停止自动化', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止自动化', exact: true })).toHaveCount(0);
  expect((await (await request.get('/api/automation')).json()).browser).toBe(false);
  await page.goBack();
  await expect(panel).toBeVisible();
  await expect(browser.getByText('已关闭', { exact: true })).toBeVisible();
});

test('readonly and mobile layout preserve the controls without enabling any desktop input', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { approval: 'readonly' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/automation');
  const panel = page.getByRole('main', { name: '电脑与浏览器' });
  await expect(panel.getByText(/当前为只读模式/)).toBeVisible();
  for (const name of ['Browser 网页操作', '电脑 / 桌面操作']) {
    const card = panel.getByRole('region', { name, exact: true });
    await card.getByRole('checkbox').check();
    await expect(card.getByRole('button', { name: /^启用/ })).toBeDisabled();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await panel.locator('.automation-card').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});

import { test, expect } from '@playwright/test';
import { clearCatalog } from './provider-helpers.js';

const browserSwitch = page => page.locator('form.composer').getByRole('switch', { name: 'Browser-Use', exact: true });
const computerSwitch = page => page.locator('form.composer').getByRole('switch', { name: 'Computer-Use', exact: true });
const promptBox = page => page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
const sendButton = page => page.getByRole('button', { name: '发送任务', exact: true });
const state = async request => (await request.get('/api/automation')).json();
const enable = async (page, label) => {
  await page.getByRole('switch', { name: label, exact: true }).click();
  await page.getByRole('button', { name: `同意并启用 ${label}`, exact: true }).click();
  await expect(page.getByRole('switch', { name: label, exact: true })).toBeChecked();
};

test.beforeEach(async ({ request }) => {
  await request.post('/api/automation/stop', { data: {} });
  for (const session of await (await request.get('/api/sessions')).json()) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await clearCatalog(request);
  await request.patch('/api/settings', { data: { provider: 'responses', model: 'test-model', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:3418/v1', approval: 'ask' } });
});

test.afterEach(async ({ request }) => { await request.post('/api/automation/stop', { data: {} }); });

test('composer switches require inline consent and preserve the draft without navigation', async ({ page, request }) => {
  await page.goto('/');
  await promptBox(page).fill('先准备操作能力，保留这条草稿');
  await expect(browserSwitch(page)).not.toBeChecked();
  await browserSwitch(page).click();
  await expect(page.getByRole('group', { name: '授权 Browser-Use' })).toContainText('页面内容及截图可能发送给当前模型供应商');
  await expect(sendButton(page)).toBeDisabled();
  expect((await state(request)).browser).toBe(false);
  await page.keyboard.press('Escape');
  await expect(browserSwitch(page)).toBeFocused();
  await expect(sendButton(page)).toBeEnabled();
  await enable(page, 'Browser-Use');
  await expect(page).toHaveURL('http://127.0.0.1:3417/');
  await expect(promptBox(page)).toHaveValue('先准备操作能力，保留这条草稿');
  expect((await state(request)).browser).toBe(true);
  expect((await (await request.get('/api/tools')).json()).some(tool => tool.name === 'browser')).toBe(true);
  await page.screenshot({ path: 'docs/screenshots/composer-automation.png' });
  await browserSwitch(page).click();
  await expect(browserSwitch(page)).not.toBeChecked();
  expect((await state(request)).browser).toBe(false);
});

test('computer switch authorizes only enablement and remains independent from Browser', async ({ page, request }) => {
  test.skip(!(await state(request)).desktopSupported, 'Desktop enablement requires Windows');
  await page.goto('/');
  await enable(page, 'Browser-Use');
  await computerSwitch(page).click();
  await expect(page.getByRole('group', { name: '授权 Computer-Use' })).toContainText('自动执行策略下直接操作');
  await page.getByRole('button', { name: '取消启用', exact: true }).click();
  expect((await state(request)).desktop).toBe(false);
  await enable(page, 'Computer-Use');
  expect(await state(request)).toMatchObject({ browser: true, desktop: true, captures: [], ownerSessionId: null });
  await computerSwitch(page).click();
  await expect(computerSwitch(page)).not.toBeChecked();
  await expect(browserSwitch(page)).toBeChecked();
  await page.getByRole('button', { name: '停止自动化', exact: true }).click();
  await expect(browserSwitch(page)).not.toBeChecked();
});

test('shared state synchronizes between composer, management, reload and another tab', async ({ page, context, request }) => {
  await page.goto('/');
  const other = await context.newPage();
  await other.goto('/');
  await expect(browserSwitch(other)).toBeEnabled();
  await enable(page, 'Browser-Use');
  await expect(browserSwitch(other)).toBeChecked();
  await page.getByRole('button', { name: '电脑与浏览器', exact: true }).click();
  const card = page.getByRole('region', { name: 'Browser 网页操作' });
  await expect(card.getByText('已启用', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '关闭 Browser', exact: true }).click();
  await expect(browserSwitch(other)).not.toBeChecked();
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: '启用 Browser', exact: true }).click();
  await expect(browserSwitch(other)).toBeChecked();
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(browserSwitch(page)).toBeChecked();
  await page.reload();
  await expect(browserSwitch(page)).toBeChecked();
  await request.post('/api/automation/stop', { data: {} });
  await expect(browserSwitch(page)).not.toBeChecked();
  await expect(browserSwitch(other)).not.toBeChecked();
  await other.close();
});

test('confirmation and in-flight changes block Enter sending without losing the prompt', async ({ page, request }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let patches = 0;
  let runs = 0;
  await page.route('**/api/automation', async route => {
    if (route.request().method() === 'PATCH') { patches++; await gate; }
    await route.continue();
  });
  page.on('request', entry => { if (entry.url().endsWith('/run')) runs++; });
  await page.goto('/');
  await promptBox(page).fill('不应提前发送');
  try {
    await browserSwitch(page).click();
    await promptBox(page).press('Enter');
    await expect(promptBox(page)).toHaveValue('不应提前发送');
    expect(runs).toBe(0);
    await page.getByRole('button', { name: '同意并启用 Browser-Use', exact: true }).click();
    await expect(browserSwitch(page)).toHaveAttribute('aria-busy', 'true');
    await expect(browserSwitch(page)).not.toBeChecked();
    await expect(computerSwitch(page)).toBeDisabled();
    await expect(sendButton(page)).toBeDisabled();
    await promptBox(page).press('Enter');
    expect(runs).toBe(0);
    expect((await state(request)).browser).toBe(false);
  } finally { release(); }
  await expect(browserSwitch(page)).toBeChecked();
  await expect(sendButton(page)).toBeEnabled();
  expect(patches).toBe(1);
  await expect(promptBox(page)).toHaveValue('不应提前发送');
});

test('failed changes retain server state and can be retried', async ({ page, request }) => {
  let fail = true;
  await page.route('**/api/automation', async route => {
    if (route.request().method() === 'PATCH' && fail) {
      await route.fulfill({ status: 409, json: { error: '模拟服务暂不可用，请重试' } });
    } else await route.continue();
  });
  await page.goto('/');
  await browserSwitch(page).click();
  await page.getByRole('button', { name: '同意并启用 Browser-Use', exact: true }).click();
  await expect(page.locator('.automation-feedback').getByRole('alert')).toContainText('模拟服务暂不可用');
  await expect(browserSwitch(page)).not.toBeChecked();
  expect((await state(request)).browser).toBe(false);
  fail = false;
  await enable(page, 'Browser-Use');
  fail = true;
  await browserSwitch(page).click();
  await expect(page.locator('.automation-feedback').getByRole('alert')).toBeVisible();
  await expect(browserSwitch(page)).toBeChecked();
  expect((await state(request)).browser).toBe(true);
  fail = false;
  await browserSwitch(page).click();
  await expect(browserSwitch(page)).not.toBeChecked();
});

test('initial state loading failures offer recovery instead of permanently disabled switches', async ({ page }) => {
  let fail = true;
  await page.route('**/api/automation', async route => {
    if (fail) await route.fulfill({ status: 503, json: { error: '连接失败' } });
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.locator('.automation-feedback').getByRole('alert')).toContainText('连接失败');
  await expect(browserSwitch(page)).toBeDisabled();
  fail = false;
  await page.getByRole('button', { name: '重试连接操作能力', exact: true }).click();
  await expect(browserSwitch(page)).toBeEnabled();
  await expect(page.locator('.automation-feedback').getByRole('alert')).toHaveCount(0);
});

test('leaving the workbench cancels unconfirmed consent and releases sending', async ({ page }) => {
  await page.goto('/');
  await promptBox(page).fill('导航后仍保留草稿');
  await browserSwitch(page).click();
  await page.getByRole('button', { name: '电脑与浏览器', exact: true }).click();
  await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByRole('group', { name: '授权 Browser-Use' })).toHaveCount(0);
  await expect(sendButton(page)).toBeEnabled();
  await expect(promptBox(page)).toHaveValue('导航后仍保留草稿');
});

test('branch retry waits for automation consent just like the composer', async ({ page, request }) => {
  await page.goto('/');
  await promptBox(page).fill('查看项目结构');
  await sendButton(page).click();
  await expect.poll(async () => (await (await request.get('/api/sessions')).json())[0]?.run?.status).toBe('completed');
  await page.locator('.message-assistant').last().getByRole('button', { name: '重新生成', exact: true }).click();
  const retry = page.getByRole('button', { name: '新建分支并发送', exact: true });
  await expect(retry).toBeEnabled();
  await browserSwitch(page).click();
  await expect(retry).toBeDisabled();
  await page.getByRole('button', { name: '取消启用', exact: true }).click();
  await expect(retry).toBeEnabled();
});

test('mobile switches respect readonly, unsupported platforms and reduced motion', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/automation', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), desktopSupported: false } });
  });
  await page.goto('/');
  await expect(computerSwitch(page)).toBeDisabled();
  await expect(computerSwitch(page)).toContainText('仅支持 Windows');
  await browserSwitch(page).click();
  const consent = page.getByRole('group', { name: '授权 Browser-Use' });
  await expect(consent).toBeVisible();
  expect(await consent.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await browserSwitch(page).evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '同意并启用 Browser-Use', exact: true }).click();
  await expect(browserSwitch(page)).toBeChecked();
  await request.patch('/api/settings', { data: { approval: 'readonly' } });
  await expect(page.locator('.automation-switch-note')).toContainText('只读模式');
  await expect(browserSwitch(page)).toBeEnabled();
  await browserSwitch(page).click();
  await expect(browserSwitch(page)).not.toBeChecked();
  await expect(browserSwitch(page)).toBeDisabled();
  await expect(computerSwitch(page)).toBeDisabled();
});

import { test, expect } from '@playwright/test';
import { clearCatalog } from './provider-helpers.js';

const slider = page => page.getByRole('slider', { name: '思考强度', exact: true });
const promptBox = page => page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
const state = async request => (await (await request.get('/api/settings')).json()).reasoning;

test.beforeEach(async ({ request }) => {
  await request.post('/api/automation/stop', { data: {} });
  await clearCatalog(request);
  await request.patch('/api/settings', { data: { provider: 'responses', model: 'test-model', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:3418/v1', approval: 'ask', reasoning: { mode: 'default' }, maxTokens: 8192 } });
});

test('all composer controls share one compact row and mobile overflow keeps send pinned', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(slider(page)).toBeEnabled();
  await expect(page.getByRole('switch', { name: 'Browser-Use' })).toBeEnabled();
  const bounds = await Promise.all([
    page.getByRole('button', { name: '选择默认模型', exact: true }),
    page.locator('.workspace-reasoning'),
    page.getByRole('switch', { name: 'Browser-Use', exact: true }),
    page.getByRole('switch', { name: 'Computer-Use', exact: true }),
    page.getByRole('button', { name: '发送任务', exact: true }),
  ].map(control => control.boundingBox()));
  expect(Math.max(...bounds.map(box => box.y)) - Math.min(...bounds.map(box => box.y))).toBeLessThan(4);
  expect((await page.locator('form.composer').boundingBox()).height).toBeLessThan(150);
  expect(await page.locator('.composer-controls').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.locator('.composer-details').evaluate(element => element.clientHeight)).toBe(0);
  await page.screenshot({ path: 'docs/screenshots/composer-toolbar.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const send = page.getByRole('button', { name: '发送任务', exact: true });
  const before = await send.boundingBox();
  await page.getByRole('switch', { name: 'Computer-Use', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.locator('.composer-controls').evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(await send.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await page.locator('form.composer').boundingBox()).height).toBeLessThan(160);
  await page.screenshot({ path: 'docs/screenshots/composer-toolbar-mobile.png' });
});

test('dragging previews multiple levels but sends one update only after release', async ({ page, request }) => {
  const updates = [];
  let runs = 0;
  page.on('request', entry => {
    if (entry.method() === 'PATCH' && entry.url().includes('/models/')) updates.push(entry.postDataJSON());
    if (entry.url().endsWith('/run')) runs++;
  });
  await page.goto('/');
  await expect(slider(page)).toBeEnabled();
  await promptBox(page).fill('滑动时不丢失任务草稿');
  const bounds = await slider(page).boundingBox();
  const center = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 6, center);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .6, center, { steps: 6 });
  await page.mouse.move(bounds.x + bounds.width - 6, center, { steps: 6 });
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '最大');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toBeDisabled();
  expect(updates).toHaveLength(0);
  expect(await state(request)).toEqual({ mode: 'default' });
  await promptBox(page).press('Enter');
  expect(runs).toBe(0);
  await page.mouse.up();
  await expect.poll(() => state(request)).toEqual({ mode: 'effort', effort: 'max' });
  await expect(page.locator('.workspace-reasoning')).toHaveAttribute('aria-busy', 'false');
  expect(updates).toEqual([{ reasoning: { mode: 'effort', effort: 'max' } }]);
  await expect(promptBox(page)).toHaveValue('滑动时不丢失任务草稿');
});

test('keyboard arrows, Home, End and Escape adjust or cancel without submitting the task', async ({ page, request }) => {
  await page.goto('/');
  await expect(slider(page)).toBeEnabled();
  await promptBox(page).fill('滑块键盘操作不是发送');
  await slider(page).focus();
  await page.keyboard.down('End');
  await expect(slider(page)).toHaveValue('7');
  expect(await state(request)).toEqual({ mode: 'default' });
  await page.keyboard.up('End');
  await expect.poll(() => state(request)).toEqual({ mode: 'effort', effort: 'max' });
  await expect(slider(page)).toBeEnabled();
  await slider(page).press('ArrowLeft');
  await expect.poll(() => state(request)).toEqual({ mode: 'effort', effort: 'xhigh' });
  await expect(slider(page)).toBeEnabled();
  await slider(page).press('Home');
  await expect.poll(() => state(request)).toEqual({ mode: 'default' });
  await expect(slider(page)).toBeEnabled();
  await slider(page).press('ArrowRight');
  await expect.poll(() => state(request)).toEqual({ mode: 'effort', effort: 'none' });
  await expect(slider(page)).toBeEnabled();
  await page.keyboard.down('End');
  await page.keyboard.press('Escape');
  await page.keyboard.up('End');
  await expect(slider(page)).toHaveValue('1');
  expect(await state(request)).toEqual({ mode: 'effort', effort: 'none' });
  await slider(page).press('Enter');
  await expect(promptBox(page)).toHaveValue('滑块键盘操作不是发送');
});

test('native Messages retains explicit budget and adaptive modes with horizontal sliders', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { provider: 'anthropic', apiKey: 'test-key' } });
  await page.goto('/');
  const mode = page.getByRole('combobox', { name: '思考调节方式', exact: true });
  await mode.selectOption('budget');
  await expect.poll(() => state(request)).toEqual({ mode: 'budget', budgetTokens: 1024 });
  const budget = page.getByRole('slider', { name: '思考 Token 预算', exact: true });
  await expect(budget).toBeEnabled();
  await budget.press('End');
  await expect.poll(() => state(request)).toEqual({ mode: 'budget', budgetTokens: 8191 });
  await expect(mode).toBeEnabled();
  await mode.selectOption('effort');
  await expect(slider(page)).toBeEnabled();
  await slider(page).press('End');
  await expect.poll(() => state(request)).toEqual({ mode: 'adaptive', effort: 'max' });
  await page.reload();
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '自适应 · 最大');
});

test('touch dragging commits on release and pointer cancellation restores the saved level', async ({ browser, request }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3417', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(slider(page)).toBeEnabled();
    await slider(page).scrollIntoViewIfNeeded();
    const bounds = await slider(page).boundingBox();
    const client = await context.newCDPSession(page);
    const start = { x: bounds.x + 6, y: bounds.y + bounds.height / 2 };
    const end = { ...start, x: bounds.x + bounds.width - 6 };
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
    await expect(slider(page)).toHaveValue('7');
    expect(await state(request)).toEqual({ mode: 'default' });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => state(request)).toEqual({ mode: 'effort', effort: 'max' });
    await expect(slider(page)).toBeEnabled();
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [end] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [start] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(slider(page)).toHaveValue('7');
    expect(await state(request)).toEqual({ mode: 'effort', effort: 'max' });
    await client.detach();
  } finally { await context.close(); }
});

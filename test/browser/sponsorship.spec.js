import { test, expect } from '@playwright/test';
import { clearCatalog } from './provider-helpers.js';

const support = page => page.getByRole('button', { name: '支持项目', exact: true });
const dialog = page => page.getByRole('dialog', { name: '支持项目', exact: true });
const close = page => dialog(page).getByRole('button', { name: '关闭支持项目', exact: true });
const promptBox = page => page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
const errors = new WeakMap();

test.beforeEach(async ({ page, request }) => {
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page).push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.get(page).push(message.text()); });
  for (const session of await (await request.get('/api/sessions')).json()) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await request.post('/api/provider-scopes', { data: { scope: 'workspace' } });
  await clearCatalog(request);
  await request.patch('/api/settings', { data: { provider: 'responses', baseUrl: 'http://127.0.0.1:3418/v1', model: 'test-model', apiKey: 'test-key', approval: 'auto' } });
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

test('support opens the Afdian homepage only on request and preserves the draft and keyboard focus', async ({ page, context }, testInfo) => {
  const externalRequests = [];
  context.on('request', item => { if (new URL(item.url()).hostname === 'afdian.com') externalRequests.push(item.url()); });
  await context.route('https://afdian.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>External link fixture</title>' }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('青禾 Studio');
  await expect(page.getByRole('link', { name: '青禾 Studio', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-footer')).toContainText('Qn');
  await expect(dialog(page)).toHaveCount(0);
  await promptBox(page).fill('保留这份未发送的任务草稿');
  const initialUrl = page.url();
  const mutations = [];
  page.on('request', item => { if (item.url().includes('/api/') && !['GET', 'HEAD'].includes(item.method())) mutations.push(item.url()); });
  await support(page).focus();
  await page.keyboard.press('Enter');
  await expect(close(page)).toBeFocused();
  await expect(dialog(page)).toContainText('自愿支持，用于项目开发与维护。');
  await expect(dialog(page)).toContainText('由 Qn 开发与维护，感谢你使用青禾 Studio。');
  const homepage = dialog(page).getByRole('link', { name: '前往爱发电主页', exact: true });
  await expect(homepage).toHaveAttribute('href', 'https://afdian.com/a/qnqinghe');
  await expect(homepage).toHaveAttribute('target', '_blank');
  await expect(homepage).toHaveAttribute('rel', 'noopener noreferrer');
  expect(externalRequests).toEqual([]);
  expect(context.pages()).toHaveLength(1);
  await expect(dialog(page).locator('img')).toHaveCount(0);
  await expect(dialog(page)).not.toContainText('扫码');
  await page.keyboard.press('Tab');
  await expect(dialog(page).getByRole('region', { name: '爱发电支持方式' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close(page)).toBeFocused();
  await promptBox(page).evaluate(element => element.focus());
  await expect(close(page)).toBeFocused();
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Control+,');
  await expect(page).toHaveURL(initialUrl);
  await expect(dialog(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sponsorship-desktop.png') });
  const [externalPage] = await Promise.all([page.waitForEvent('popup'), homepage.click()]);
  await expect(externalPage).toHaveURL('https://afdian.com/a/qnqinghe');
  expect(await externalPage.evaluate(() => window.opener === null)).toBe(true);
  await externalPage.close();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(support(page)).toBeFocused();
  await expect(promptBox(page)).toHaveValue('保留这份未发送的任务草稿');
  expect(mutations).toEqual([]);
  await page.keyboard.press('Control+,');
  await expect(page).toHaveURL(/#\/providers$/);
});

test('support uses the existing desktop external-link bridge and displays rejected requests', async ({ page }) => {
  await page.goto('/');
  await expect(promptBox(page)).toBeEnabled();
  await page.evaluate(() => {
    window.sponsorExternalCalls = [];
    window.harnessDesktop = { openExternal: async url => { window.sponsorExternalCalls.push(url); throw new Error('Rejected by desktop bridge'); } };
  });
  await support(page).click();
  expect(await page.evaluate(() => window.sponsorExternalCalls)).toEqual([]);
  const initialUrl = page.url();
  await dialog(page).getByRole('link', { name: '前往爱发电主页', exact: true }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('无法打开外部链接，请更新桌面版或手动复制链接。');
  expect(await page.evaluate(() => window.sponsorExternalCalls)).toEqual(['https://afdian.com/a/qnqinghe']);
  await expect(page).toHaveURL(initialUrl);
  await close(page).click();
  await expect(support(page)).toBeFocused();
});

test('support leaves unsaved provider fields and selected configuration source intact', async ({ page }) => {
  await page.goto('/#/providers');
  const management = page.getByRole('main', { name: '供应商与模型', exact: true });
  await management.getByRole('button', { name: '新增供应商', exact: true }).click();
  await management.getByRole('textbox', { name: '供应商名称', exact: true }).fill('未保存的供应商草稿');
  await management.getByLabel('API 密钥', { exact: true }).fill('unsaved-sponsor-dialog-secret');
  await support(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page).toHaveURL(/#\/providers$/);
  await close(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(support(page)).toBeFocused();
  await expect(management.getByRole('region', { name: '有未保存的更改', exact: true })).toHaveCount(0);
  await expect(management.getByRole('textbox', { name: '供应商名称', exact: true })).toHaveValue('未保存的供应商草稿');
  await expect(management.getByLabel('API 密钥', { exact: true })).toHaveValue('unsaved-sponsor-dialog-secret');
  await expect(management.getByRole('button', { name: '编辑工作区配置', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('mobile support keeps the Afdian action visible and restores the visible sidebar entry', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await promptBox(page).fill('手机草稿');
  await page.getByRole('button', { name: '打开会话侧栏', exact: true }).click();
  await support(page).click();
  const homepage = dialog(page).getByRole('link', { name: '前往爱发电主页', exact: true });
  await expect(homepage).toBeInViewport();
  await expect(homepage).toHaveAttribute('href', 'https://afdian.com/a/qnqinghe');
  await expect(dialog(page).locator('img')).toHaveCount(0);
  const bounds = await dialog(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const body = dialog(page).getByRole('region', { name: '爱发电支持方式' });
  await body.focus();
  await page.keyboard.press('Tab');
  await expect(homepage).toBeFocused();
  await expect(close(page)).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('sponsorship-mobile-short.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await body.evaluate(element => { element.scrollTop = 0; });
  await close(page).focus();
  await page.screenshot({ path: testInfo.outputPath('sponsorship-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(support(page)).toBeVisible();
  await expect(support(page)).toBeFocused();
  await expect(page.locator('.studio')).toHaveClass(/sidebar-visible/);
  await support(page).click();
  await close(page).click();
  await expect(support(page)).toBeFocused();
  await page.getByRole('button', { name: '关闭侧栏', exact: true }).click({ position: { x: 350, y: 30 } });
  await expect(promptBox(page)).toHaveValue('手机草稿');
  await expect(page.locator('.studio')).not.toHaveClass(/sidebar-visible/);
});

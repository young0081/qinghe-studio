import { test, expect } from '@playwright/test';
import { mathSample } from '../fixtures/math.js';
import { startModelServer } from '../fixtures/model-server.js';

const rendered = page => page.locator('.message-assistant .markdown').last();

test.beforeEach(async ({ request }) => {
  for (const session of await (await request.get('/api/sessions')).json()) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await request.patch('/api/settings', { data: { provider: 'responses', model: 'test-model', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:3418/v1', reasoning: { mode: 'default' } } });
});

async function send(page, prompt = '[test:math]') {
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

test('inline, display, matrix and aligned LaTeX use local fonts and preserve raw persisted messages', async ({ page, request }, testInfo) => {
  const errors = [];
  const fonts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.request().resourceType() === 'font') fonts.push({ url: response.url(), status: response.status(), type: response.headers()['content-type'] }); });
  await page.addInitScript(() => { window.mathPolicyViolations = []; document.addEventListener('securitypolicyviolation', event => window.mathPolicyViolations.push(event.violatedDirective)); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await send(page);
  const markdown = rendered(page);
  await expect(markdown.locator('.katex')).toHaveCount(9);
  await expect(markdown.getByRole('group', { name: '独立数学公式' })).toHaveCount(6);
  await expect(markdown.locator('math')).toHaveCount(9);
  await expect(markdown.locator('.katex-error')).toHaveCount(0);
  await expect(markdown.locator('td .katex')).toHaveCount(1);
  await expect(markdown.locator('.code-block')).toHaveCount(1);
  await expect(markdown.locator('.code-block .katex')).toHaveCount(0);
  await expect(markdown.locator('.code-block')).toContainText('$这是示例源码$');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => [...document.fonts].some(font => font.family.startsWith('KaTeX_') && font.status === 'loaded'))).toBe(true);
  expect(fonts.length).toBeGreaterThan(0);
  for (const font of fonts) {
    expect(font.status, font.url).toBe(200);
    expect(font.type, font.url).toBe('font/woff2');
    expect(new URL(font.url).origin).toBe(new URL(page.url()).origin);
  }
  expect(await page.evaluate(() => window.mathPolicyViolations)).toEqual([]);
  expect((await (await request.get('/api/sessions')).json())[0].messages.at(-1).content).toBe(mathSample);
  await page.reload();
  await expect(rendered(page).locator('.katex')).toHaveCount(9);
  await rendered(page).getByRole('heading', { name: '数学公式', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('math-desktop.png') });
  expect(errors).toEqual([]);
});

test('invalid and untrusted math stays readable without active HTML, network requests or renderer crashes', async ({ page }) => {
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('example.invalid')) externalRequests.push(request.url()); });
  await page.goto('/');
  await send(page, '[test:math-unsafe]');
  const markdown = rendered(page);
  await expect(markdown).toContainText('安全检查后的正文仍然可读。');
  expect(await markdown.locator('.katex-error').count()).toBeGreaterThan(0);
  await expect(markdown.locator('a, img, script, iframe, #settings, [onload], [style*="position:fixed"]')).toHaveCount(0);
  await expect(markdown).not.toContainText('不可信原始 MathML');
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('incomplete streamed math becomes a complete formula without damaging later text', async ({ page, request }) => {
  const remote = await startModelServer({ chunkDelayMs: 90 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await request.patch('/api/settings', { data: { baseUrl: remote.url } });
    await page.goto('/');
    await send(page, '[test:math-streaming]');
    await expect(page.locator('.streaming-message .katex').first()).toBeVisible();
    await expect(rendered(page)).toContainText('数学流式输出完成。');
    await expect(page.locator('.streaming-message')).toHaveCount(0);
    await expect(rendered(page).locator('.katex')).toHaveCount(2);
    await expect(rendered(page).locator('.katex-error')).toHaveCount(0);
    await page.reload();
    await expect(rendered(page).locator('.katex')).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally { await remote.close(); }
});

test('long display and inline math scroll within the mobile viewport with reduced motion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await send(page, '[test:math-wide]');
  const markdown = rendered(page);
  await expect(markdown.locator('.katex')).toHaveCount(2);
  const formula = markdown.getByRole('group', { name: '独立数学公式' });
  expect(await formula.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await formula.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => formula.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('math-mobile.png') });
});

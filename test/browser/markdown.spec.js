import { test, expect } from '@playwright/test';
import { markdownCode, markdownSample } from '../fixtures/markdown.js';
import { startModelServer } from '../fixtures/model-server.js';

const rendered = page => page.locator('.message-assistant .markdown').last();

test.beforeEach(async ({ request }) => {
  for (const session of await (await request.get('/api/sessions')).json()) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await request.patch('/api/settings', { data: { provider: 'responses', model: 'test-model', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:3418/v1', approval: 'ask', reasoning: { mode: 'default' } } });
});

async function send(page, prompt = '[test:markdown]') {
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

test('CommonMark and GFM render real tables, nested formatting, highlighted code and persisted messages', async ({ page, context, request }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.markdownTestClipboard = value; } } }); });
  await page.goto('/');
  await send(page);
  const markdown = rendered(page);
  await expect(markdown.getByRole('heading', { name: '机器状态报告', level: 1 })).toBeVisible();
  await expect(markdown.getByRole('table')).toHaveCount(1);
  await expect(markdown.locator('tbody tr')).toHaveCount(4);
  await expect(markdown.getByRole('cell', { name: 'A|B', exact: true })).toBeVisible();
  await expect(markdown.locator('th').nth(2)).toHaveCSS('text-align', 'right');
  await expect(markdown.locator('strong em')).toHaveText('强调');
  await expect(markdown.locator('del')).toHaveText('删除线');
  await expect(markdown.locator('blockquote ul li')).toHaveText('引用中的列表');
  await expect(markdown.locator('ol[start="3"] > li > ul > li > ul > li')).toHaveText('查看采样');
  await expect(markdown.getByRole('checkbox', { name: '已完成任务' })).toBeChecked();
  await expect(markdown.getByRole('checkbox', { name: '未完成任务' })).toBeDisabled();
  await expect(markdown.locator('.hljs-keyword').first()).toHaveText('const');
  await markdown.getByRole('button', { name: '复制代码' }).click();
  await expect.poll(() => page.evaluate(() => window.markdownTestClipboard)).toBe(markdownCode);
  await expect(markdown.getByRole('button', { name: '复制代码' })).toContainText('已复制');
  await markdown.locator('summary').click();
  await expect(markdown.locator('details strong')).toHaveText('HTML 内容');
  const link = markdown.getByRole('link', { name: '参考文档', exact: true });
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await context.route('https://example.com/docs', route => route.fulfill({ contentType: 'text/html', body: '<p>Isolated external link fixture</p>' }));
  const opened = page.waitForEvent('popup');
  await link.click();
  const popup = await opened;
  await expect(popup).toHaveURL('https://example.com/docs');
  await popup.close();
  expect((await (await request.get('/api/sessions')).json())[0].messages.at(-1).content).toBe(markdownSample);
  await page.reload();
  await expect(rendered(page).getByRole('table')).toHaveCount(1);
  await rendered(page).getByRole('heading', { name: '机器状态报告' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('markdown-desktop.png') });
  expect(errors).toEqual([]);
});

test('unsafe HTML, links and image requests are blocked while safe HTML and embedded raster images render', async ({ page }) => {
  const externalRequests = [];
  page.on('request', request => { if (request.url().includes('example.invalid') || request.url().includes('image-test')) externalRequests.push(request.url()); });
  await page.goto('/');
  await send(page, '[test:markdown-unsafe]');
  const markdown = rendered(page);
  await expect(markdown.getByText('可见的安全文字')).toBeVisible();
  await expect(markdown.locator('script, style, iframe, svg, form, button:not(.code-title button), [onclick], [onerror], [srcset], [style]')).toHaveCount(0);
  await expect(markdown.locator('a[href^="javascript:"], a[href^="file:"], a[href^="data:"], a[href*="password"]')).toHaveCount(0);
  await expect(markdown.locator('#settings')).toHaveCount(0);
  await expect(markdown.getByRole('link', { name: '在浏览器打开图片' })).toHaveAttribute('href', 'https://example.invalid/tracker');
  await expect(markdown.getByText('为保护隐私，不自动加载外部图片')).toBeVisible();
  const image = markdown.getByRole('img', { name: '嵌入图片' });
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(1);
  expect(await page.evaluate(() => window.__markdownPwned)).toBeUndefined();
  expect(externalRequests).toEqual([]);
  await expect(markdown.locator('pre')).toContainText('<script>代码块里的 HTML 不执行</script>');
});

test('partial streamed tables and code fences render safely before completion and after reload', async ({ page, request }) => {
  const remote = await startModelServer({ chunkDelayMs: 90 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await request.patch('/api/settings', { data: { baseUrl: remote.url } });
    await page.goto('/');
    await send(page, '[test:markdown-streaming]');
    const streaming = page.locator('.streaming-message .markdown');
    await expect(streaming.getByRole('table')).toBeVisible();
    await expect(streaming.locator('pre')).toBeVisible();
    await expect(rendered(page)).toContainText('流式渲染完成。');
    await expect(page.locator('.streaming-message')).toHaveCount(0);
    await page.reload();
    await expect(rendered(page).getByRole('table')).toHaveCount(1);
    await expect(rendered(page).locator('pre')).toContainText('const sample11 = 11;');
    expect(errors).toEqual([]);
  } finally { await remote.close(); }
});

test('wide tables, unknown languages and unfinished fences stay usable on mobile with reduced motion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await send(page, '[test:markdown-wide]\n\n```c++\nint main() { return 0; }\n```\n\n```powershell\nGet-Process | Select-Object Name\n```');
  const userMarkdown = page.locator('.message-user .markdown').last();
  await expect(userMarkdown.locator('.language-c\\+\\+ .hljs-type').first()).toHaveText('int');
  await expect(userMarkdown.locator('.language-powershell .hljs-built_in').first()).toHaveText('Get-Process');
  const markdown = rendered(page);
  await expect(markdown.locator('.code-block')).toHaveCount(3);
  await expect(markdown.locator('pre').last()).toContainText('仍然按代码显示 <script>');
  await expect(markdown.locator('script')).toHaveCount(0);
  const table = markdown.getByRole('region', { name: 'Markdown 表格' });
  expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await markdown.locator('pre').first().evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await table.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('markdown-mobile.png') });
});

test('footnotes stay inside their message and clipboard failures remain actionable', async ({ page }) => {
  await page.goto('/');
  await send(page);
  await expect(rendered(page).getByRole('table')).toHaveCount(1);
  await send(page);
  await expect(page.locator('.message-assistant .markdown')).toHaveCount(2);
  const markdown = rendered(page);
  const identifiers = await page.locator('.message-assistant .markdown [id]').evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(identifiers).size).toBe(identifiers.length);
  const reference = markdown.getByRole('link', { name: '1', exact: true });
  const target = await reference.getAttribute('href');
  expect(await reference.getAttribute('aria-describedby')).toBe(await markdown.locator('.footnotes h2').getAttribute('id'));
  await reference.click();
  expect(await page.evaluate(() => document.activeElement.id)).toBe(target.slice(1));
  expect(await markdown.locator('[id]').evaluateAll((elements, id) => elements.some(element => element.id === id), target.slice(1))).toBe(true);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('clipboard unavailable'); } } }); });
  await markdown.getByRole('button', { name: '复制代码' }).click();
  await expect(markdown.getByRole('status')).toHaveText('复制失败，请手动选择代码。');
});

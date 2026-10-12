import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const errors = new WeakMap();
const expectedConsoleUrls = new WeakMap();
const fixtureUrl = 'http://127.0.0.1:3418/automation-fixture';

test.beforeEach(async ({ page, request }) => {
  errors.set(page, []);
  expectedConsoleUrls.set(page, new Set());
  page.on('pageerror', error => errors.get(page).push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && expectedConsoleUrls.get(page).delete(message.location().url)) return;
    if (['error', 'warning'].includes(message.type())) errors.get(page).push(`${message.text()} (${message.location().url || 'unknown source'})`);
  });
  await request.post('/api/automation/stop', { data: {} });
  for (const session of await (await request.get('/api/sessions')).json()) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await request.delete(`/api/sessions/${session.id}`);
  }
  await request.patch('/api/settings', { data: { provider: 'responses', baseUrl: 'http://127.0.0.1:3418/v1', model: 'test-model', apiKey: 'test-key', approval: 'auto' } });
});

test.afterEach(async ({ page, request }) => {
  await request.post('/api/automation/stop', { data: {} });
  for (const question of await (await request.get('/api/questions')).json()) await request.post(`/api/sessions/${question.sessionId}/cancel`, { data: {} });
  expect(errors.get(page)).toEqual([]);
});

async function openStudio(page) {
  await page.goto('/');
  await expect(page).toHaveTitle('青禾 Studio');
  expect(new URL(page.url()).origin).toBe('http://127.0.0.1:3417');
  await expect(page.getByText('青禾 Studio', { exact: true })).toBeVisible();
  await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
  await expect(page.locator('vite-error-overlay, nextjs-portal')).toHaveCount(0);
}

async function send(page, prompt) {
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

async function pendingQuestion(request) {
  await expect.poll(async () => (await (await request.get('/api/questions')).json()).length).toBe(1);
  return (await (await request.get('/api/questions')).json())[0];
}

async function assertCompleted(request, question) {
  await expect.poll(async () => (await (await request.get(`/api/sessions/${question.sessionId}`)).json()).run.status).toBe('completed');
  const session = await (await request.get(`/api/sessions/${question.sessionId}`)).json();
  expect(session.run.id).toBe(question.runId);
  expect(session.events.filter(event => event.type === 'run.started')).toHaveLength(1);
  expect(await (await request.get('/api/questions')).json()).toEqual([]);
  return session;
}

async function noOverflow(page, locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('question bubble survives refresh and selected option resumes the same run', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openStudio(page);
  await send(page, '[test:question]');
  const bubble = page.getByRole('complementary', { name: '青禾 Studio 提问气泡' });
  await expect(bubble).toContainText('你希望使用哪个方案？');
  const question = await pendingQuestion(request);
  expect((await (await request.get(`/api/sessions/${question.sessionId}`)).json()).run.status).toBe('waiting_input');
  await expect(bubble.getByRole('button', { name: '提交并继续 →' })).toBeDisabled();
  await page.reload();
  await expect(bubble).toContainText('你希望使用哪个方案？');
  expect((await pendingQuestion(request)).id).toBe(question.id);
  await bubble.getByRole('button', { name: /保留现有布局/ }).click();
  await expect(bubble.getByRole('button', { name: /保留现有布局/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(bubble.getByRole('textbox', { name: '也可以输入自己的回答' })).toHaveValue('保留现有布局');
  await noOverflow(page, bubble);
  await page.screenshot({ path: testInfo.outputPath('question-desktop.png'), fullPage: false });
  await bubble.getByRole('button', { name: '提交并继续 →' }).click();
  await expect(bubble).toHaveCount(0);
  await expect(page.locator('.message-assistant').last()).toContainText('已收到补充：保留现有布局。任务已完成。');
  await assertCompleted(request, question);
});

test('custom question reply and cancellation work on mobile with reduced motion', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openStudio(page);
  await send(page, '[test:question]');
  const bubble = page.getByRole('complementary', { name: '青禾 Studio 提问气泡' });
  await expect(bubble).toBeVisible();
  const question = await pendingQuestion(request);
  await bubble.getByRole('textbox', { name: '也可以输入自己的回答' }).fill('保留导航，同时增大正文区域。');
  expect(await bubble.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await bubble.locator('.question-pixel').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await noOverflow(page, bubble);
  await page.screenshot({ path: testInfo.outputPath('question-mobile.png'), fullPage: false });
  await bubble.getByRole('button', { name: '提交并继续 →' }).click();
  await expect(bubble).toHaveCount(0);
  await expect(page.locator('.message-assistant').last()).toContainText('已收到补充：保留导航，同时增大正文区域。');
  await assertCompleted(request, question);
  await send(page, '[test:question] 请再次确认');
  await expect(bubble).toBeVisible();
  const cancelled = await pendingQuestion(request);
  await bubble.getByRole('button', { name: '停止此任务', exact: true }).click();
  await expect(bubble).toHaveCount(0);
  await expect(page.getByText('运行已停止。你可以继续发送消息。')).toBeVisible();
  expect(await (await request.get('/api/questions')).json()).toEqual([]);
  expect((await (await request.get(`/api/sessions/${cancelled.sessionId}`)).json()).run.status).toBe('cancelled');
});

test('initial question refresh retains pending sessions when a new question arrives during the request', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const first = await (await request.post('/api/sessions', { data: { title: 'Already waiting' } })).json();
  await request.post(`/api/sessions/${first.id}/run`, { data: { prompt: '[test:question]' } });
  await pendingQuestion(request);
  let release;
  let captured = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/questions', async route => {
    if (captured) { await route.continue(); return; }
    const response = await route.fetch();
    captured = true;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await openStudio(page);
    await expect.poll(() => captured).toBe(true);
    const second = await (await request.post('/api/sessions', { data: { title: 'New question' } })).json();
    await request.post(`/api/sessions/${second.id}/run`, { data: { prompt: '[test:question]' } });
    const bubble = page.getByRole('complementary', { name: '青禾 Studio 提问气泡' });
    await expect(bubble).toBeVisible();
    release();
    await expect(bubble).toContainText('2 个问题等待回答');
    await page.screenshot({ path: testInfo.outputPath('question-concurrent.png'), fullPage: false });
    await request.post(`/api/sessions/${second.id}/cancel`, { data: {} });
    await expect(bubble).toContainText('任务正在等你');
    expect((await (await request.get('/api/questions')).json()).map(question => question.sessionId)).toEqual([first.id]);
    await bubble.getByRole('button', { name: '停止此任务', exact: true }).click();
    await expect(bubble).toHaveCount(0);
  } finally { release(); }
});

test('a transient question refresh failure retries and restores the pending question', async ({ page, request }, testInfo) => {
  const session = await (await request.post('/api/sessions', { data: { title: 'Question reconnect' } })).json();
  await request.post(`/api/sessions/${session.id}/run`, { data: { prompt: '[test:question]' } });
  const question = await pendingQuestion(request);
  let attempts = 0;
  expectedConsoleUrls.get(page).add('http://127.0.0.1:3417/api/questions');
  await page.route('**/api/questions', async route => {
    if (++attempts === 1) await route.abort('failed');
    else await route.continue();
  });
  await openStudio(page);
  const bubble = page.getByRole('complementary', { name: '青禾 Studio 提问气泡' });
  await expect(bubble).toContainText('你希望使用哪个方案？', { timeout: 12000 });
  expect(attempts).toBeGreaterThan(1);
  expect((await pendingQuestion(request)).id).toBe(question.id);
  await page.screenshot({ path: testInfo.outputPath('question-recovered.png'), fullPage: false });
  await bubble.getByRole('button', { name: /保留现有布局/ }).click();
  await bubble.getByRole('button', { name: '提交并继续 →' }).click();
  await assertCompleted(request, question);
});

test('browser opens live sidebar, streams continuously between tools, follows fill and click, and clears on completion', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect((await request.patch('/api/automation', { data: { browser: true } })).ok()).toBe(true);
  await openStudio(page);
  await send(page, `[test:browser-live] ${fixtureUrl}`);
  const live = page.getByRole('complementary', { name: 'Browser 实时画面' });
  const image = live.getByRole('img', { name: '青禾 Studio 正在操作的浏览器实时画面' });
  const bubble = page.getByRole('complementary', { name: '青禾 Studio 提问气泡' });
  await expect(live).toBeVisible();
  await expect(live).toHaveAttribute('data-active', 'true');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(1280);
  await expect(bubble).toContainText('请确认直播画面，然后继续网页操作。');
  const question = await pendingQuestion(request);
  const beforeSession = await (await request.get(`/api/sessions/${question.sessionId}`)).json();
  const firstFrame = await request.get('/api/automation/browser-live/frame');
  const firstSequence = Number(firstFrame.headers()['x-frame-sequence']);
  const firstData = await firstFrame.body();
  const firstSource = await image.getAttribute('src');
  await expect.poll(async () => (await (await request.get('/api/automation/browser-live')).json()).sequence).toBeGreaterThan(firstSequence + 2);
  await expect.poll(() => image.getAttribute('src')).not.toBe(firstSource);
  const secondData = await (await request.get('/api/automation/browser-live/frame')).body();
  expect(secondData.equals(firstData)).toBe(false);
  const afterSession = await (await request.get(`/api/sessions/${question.sessionId}`)).json();
  expect(afterSession.events.filter(event => event.type === 'tool.started').length).toBe(beforeSession.events.filter(event => event.type === 'tool.started').length);
  await noOverflow(page, live);
  await page.screenshot({ path: testInfo.outputPath('browser-live-desktop.png'), fullPage: false });
  await live.getByRole('button', { name: '收起浏览器实时画面' }).click();
  await expect(live).toHaveCount(0);
  expect((await (await request.get('/api/automation/browser-live')).json()).active).toBe(true);
  await page.getByRole('button', { name: '打开浏览器实时画面', exact: true }).click();
  await expect(image).toBeVisible();
  await bubble.getByRole('button', { name: /继续操作网页/ }).click();
  await bubble.getByRole('button', { name: '提交并继续 →' }).click();
  await expect(bubble).toContainText('页面已填写并保存，是否结束观察？');
  await expect(live).toContainText('Saved: 实时操作已完成');
  await page.screenshot({ path: testInfo.outputPath('browser-live-filled.png'), fullPage: false });
  await image.screenshot({ path: testInfo.outputPath('browser-live-frame-filled.png') });
  await writeFile(testInfo.outputPath('browser-live-native-frame.jpg'), await (await request.get('/api/automation/browser-live/frame')).body());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await noOverflow(page, live);
  await noOverflow(page, bubble);
  const headerLayout = await page.locator('.topbar, .breadcrumbs, .breadcrumbs > *, .topbar-actions, .topbar-actions > *').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { className: element.className, label: element.getAttribute('aria-label'), display: style.display, width: style.width, minWidth: style.minWidth, flex: style.flex, gap: style.gap, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right } };
  }));
  await testInfo.attach('mobile-header-layout', { body: Buffer.from(JSON.stringify(headerLayout, null, 2)), contentType: 'application/json' });
  await noOverflow(page, page.getByRole('button', { name: '切换工作区面板', exact: true }));
  expect(await live.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await live.locator('.live-lamp').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.screenshot({ path: testInfo.outputPath('browser-live-mobile.png'), fullPage: false });
  await bubble.getByRole('button', { name: /完成观察/ }).click();
  await bubble.getByRole('button', { name: '提交并继续 →' }).click();
  await expect(bubble).toHaveCount(0);
  await assertCompleted(request, question);
  await expect(live).toHaveAttribute('data-active', 'false');
  await expect(image).toHaveCount(0);
  await expect(live).toContainText('等待网页操作');
  const ended = await (await request.get('/api/automation/browser-live')).json();
  expect(ended.active).toBe(false);
  expect(ended.sessionId).toBeNull();
  expect((await request.get('/api/automation/browser-live/frame')).status()).toBe(204);
});

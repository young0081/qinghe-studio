import { test, expect } from '@playwright/test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expectProviders, providerPage, returnToStudio } from './provider-helpers.js';

const modelUrl = 'http://127.0.0.1:3418/v1';

test.beforeEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { provider: 'responses', apiKey: 'test-key', baseUrl: modelUrl, model: 'test-model', approval: 'ask', maxSteps: 20 } });
  const sessions = await (await request.get('/api/sessions')).json();
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
});

async function holdResponse(page, matcher) {
  let release;
  let received;
  let delivered;
  const gate = new Promise(resolve => { release = resolve; });
  const responseReady = new Promise(resolve => { received = resolve; });
  const responseDelivered = new Promise(resolve => { delivered = resolve; });
  await page.route(matcher, async route => {
    const response = await route.fetch();
    received(response);
    await gate;
    await route.fulfill({ response });
    delivered();
  }, { times: 1 });
  return { release, received: responseReady, delivered: responseDelivered };
}

async function expectReady(page) {
  await expect(page.locator('.studio')).toHaveAttribute('data-phase', 'ready');
  await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toBeEnabled();
}

async function expectNoHorizontalOverflow(page) {
  const widths = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(widths.viewport).toBe(390);
  expect(widths.content).toBeLessThanOrEqual(widths.viewport);
}

async function settleRendering(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function expectReducedMotion(page) {
  const violations = await page.evaluate(() => {
    const failures = [];
    for (const element of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        const names = style.animationName.split(',').map(value => value.trim());
        const durations = style.animationDuration.split(',').map(value => parseFloat(value));
        const delays = style.animationDelay.split(',').map(value => parseFloat(value));
        const iterations = style.animationIterationCount.split(',').map(value => value.trim());
        const label = `${element.tagName.toLowerCase()}.${element.getAttribute('class') || ''}${pseudo || ''}`;
        for (const [index, name] of names.entries()) {
          if (name === 'none') continue;
          if (durations[index % durations.length] > .05 || delays[index % delays.length] > .05 || iterations[index % iterations.length] === 'infinite' || Number(iterations[index % iterations.length]) > 1) failures.push(`${label}: animation ${name}`);
        }
        if (style.transitionDuration.split(',').some(value => parseFloat(value) > .05)) failures.push(`${label}: transition ${style.transitionProperty}`);
      }
    }
    return failures;
  });
  expect(violations).toEqual([]);
}

async function completedSession(request, title, prompt) {
  const response = await request.post('/api/sessions', { data: { title } });
  expect(response.ok()).toBe(true);
  const session = await response.json();
  expect((await request.post(`/api/sessions/${session.id}/run`, { data: { prompt } })).ok()).toBe(true);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).run?.status).toBe('completed');
  return session;
}

test('initial workspace requests show a busy pixel loader until real API data arrives', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await holdResponse(page, '**/api/settings');
  try {
    await page.goto('/');
    expect((await response.received).ok()).toBe(true);
    const loader = page.getByRole('status', { name: '正在载入工作区', exact: true });
    await expect(loader).toBeVisible();
    await expect(loader).toHaveClass(/pixel-loader/);
    await expect(page.locator('.studio')).toHaveAttribute('data-phase', 'loading');
    await expect(page.locator('.main-panel')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /新建会话/ })).toBeDisabled();
    expect(await loader.evaluate(element => [element, ...element.querySelectorAll('*')].some(block => {
      const style = getComputedStyle(block);
      return style.animationName !== 'none' && /steps\(/.test(style.animationTimingFunction);
    }))).toBe(true);
    response.release();
    await expectReady(page);
    await expect(loader).toHaveCount(0);
    await expect(page.locator('.main-panel')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: /新建会话/ })).toBeEnabled();
  } finally { response.release(); }
});

test('startup failure stays actionable and retry returns to a ready workspace', async ({ page }) => {
  await page.route('**/api/tools', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试：工作区暂时不可用' }) }), { times: 1 });
  await page.goto('/');
  await expect(page.locator('.studio')).toHaveAttribute('data-phase', 'error');
  await expect(page.getByRole('alert')).toContainText('工作区暂时不可用');
  await expect(page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' })).toBeDisabled();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await page.getByRole('button', { name: '重试连接', exact: true }).click();
  await expectReady(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('status', { name: '正在载入工作区', exact: true })).toHaveCount(0);
});

test('file list and preview loaders follow requests and dismissed previews stay closed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expectReady(page);
  const listing = await holdResponse(page, '**/api/files?*');
  try {
    await page.getByRole('tab', { name: /^文件/ }).click();
    expect((await listing.received).ok()).toBe(true);
    await expect(page.getByRole('status', { name: '读取文件列表', exact: true })).toBeVisible();
    await expect(page.locator('.files-panel')).toHaveAttribute('aria-busy', 'true');
    listing.release();
    await expect(page.getByRole('button', { name: /README.md/ })).toBeVisible();
    await expect(page.locator('.files-panel')).toHaveAttribute('aria-busy', 'false');
  } finally { listing.release(); }
  const preview = await holdResponse(page, '**/api/file?path=README.md');
  try {
    await page.getByRole('button', { name: /README.md/ }).click();
    expect((await preview.received).ok()).toBe(true);
    await expect(page.getByRole('status', { name: '读取文件', exact: true })).toBeVisible();
    await expect(page.locator('.file-preview')).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('button', { name: '关闭文件预览' }).click();
    await expect(page.locator('.file-preview')).toHaveCount(0);
    const finished = page.waitForResponse(response => response.url().endsWith('/api/file?path=README.md'));
    preview.release();
    await (await finished).finished();
    await preview.delivered;
    await settleRendering(page);
    await expect(page.locator('.file-preview')).toHaveCount(0);
    await page.getByRole('button', { name: /README.md/ }).click();
    await expect(page.locator('.file-preview')).toContainText('real isolated test workspace');
    await expect(page.locator('.file-preview')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('status', { name: '读取文件', exact: true })).toHaveCount(0);
  } finally { preview.release(); }
});

test('late session snapshots cannot replace the newer selection or its messages', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const previous = await completedSession(request, '等待响应的旧会话', '旧会话独有的用户任务');
  const current = await completedSession(request, '保持选择的新会话', '新会话独有的用户任务');
  await page.addInitScript(id => localStorage.setItem('harness.session', id), current.id);
  await page.goto('/');
  await expectReady(page);
  await expect(page.getByRole('log', { name: '对话记录' })).toContainText('新会话独有的用户任务');
  const snapshot = await holdResponse(page, `**/api/sessions/${previous.id}`);
  try {
    await page.getByRole('button', { name: /^等待响应的旧会话/ }).click();
    expect((await snapshot.received).ok()).toBe(true);
    await expect(page.getByRole('status', { name: '正在载入会话', exact: true })).toBeVisible();
    await expect(page.locator('.main-panel')).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('button', { name: /^保持选择的新会话/ }).click();
    await expect(page.locator('.main-panel')).toHaveAttribute('aria-busy', 'false');
    const finished = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${previous.id}`));
    snapshot.release();
    await (await finished).finished();
    await snapshot.delivered;
    await settleRendering(page);
    await expect(page.getByRole('button', { name: /^保持选择的新会话/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.breadcrumb-current')).toHaveText('保持选择的新会话');
    await expect(page.getByRole('log', { name: '对话记录' })).toContainText('新会话独有的用户任务');
    await expect(page.getByRole('log', { name: '对话记录' })).not.toContainText('旧会话独有的用户任务');
    await expect(page.getByRole('status', { name: '正在载入会话', exact: true })).toHaveCount(0);
  } finally { snapshot.release(); }
});

test('directory navigation invalidates pending file previews instead of reviving stale content', async ({ page, request }) => {
  const health = await (await request.get('/api/health')).json();
  const workspace = await realpath(health.workspace);
  const directory = await mkdtemp(path.join(workspace, 'motion-directory-'));
  const directoryName = path.basename(directory);
  const content = 'Only the newly selected directory owns this preview.';
  try {
    await writeFile(path.join(directory, 'current.txt'), content);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expectReady(page);
    await page.getByRole('tab', { name: /^文件/ }).click();
    await expect(page.getByRole('button', { name: /README.md/ })).toBeVisible();
    const preview = await holdResponse(page, '**/api/file?path=README.md');
    try {
      await page.getByRole('button', { name: /README.md/ }).click();
      expect((await preview.received).ok()).toBe(true);
      await expect(page.getByRole('status', { name: '读取文件', exact: true })).toBeVisible();
      await page.getByRole('button', { name: directoryName, exact: true }).click();
      await expect(page.getByRole('button', { name: /current.txt/ })).toBeVisible();
      await expect(page.locator('.file-preview')).toHaveCount(0);
      const finished = page.waitForResponse(response => response.url().endsWith('/api/file?path=README.md'));
      preview.release();
      await (await finished).finished();
      await preview.delivered;
      await settleRendering(page);
      await expect(page.locator('.file-preview')).toHaveCount(0);
      const nestedPath = `${directoryName}/current.txt`;
      const nestedPreview = await holdResponse(page, url => url.pathname === '/api/file' && url.searchParams.get('path')?.replace(/\\/g, '/') === nestedPath);
      try {
        await page.getByRole('button', { name: /current.txt/ }).click();
        expect((await nestedPreview.received).ok()).toBe(true);
        await expect(page.getByRole('status', { name: '读取文件', exact: true })).toBeVisible();
        await page.getByRole('button', { name: /返回上级目录/ }).click();
        await expect(page.getByRole('button', { name: /README.md/ })).toBeVisible();
        const nestedFinished = page.waitForResponse(response => new URL(response.url()).searchParams.get('path')?.replace(/\\/g, '/') === nestedPath);
        nestedPreview.release();
        await (await nestedFinished).finished();
        await nestedPreview.delivered;
        await settleRendering(page);
        await expect(page.locator('.file-preview')).toHaveCount(0);
      } finally { nestedPreview.release(); }
      await page.getByRole('button', { name: directoryName, exact: true }).click();
      await page.getByRole('button', { name: /current.txt/ }).click();
      await expect(page.locator('.file-preview')).toContainText(content);
    } finally { preview.release(); }
  } finally {
    const target = await realpath(directory);
    const relative = path.relative(workspace, target);
    expect(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)).toBeTruthy();
    await rm(target, { recursive: true, force: true });
  }
});

test('animated mobile management page stays within the viewport and remains keyboard usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expectReady(page);
  await expectNoHorizontalOverflow(page);
  const openSettings = page.getByRole('button', { name: '选择默认模型', exact: true });
  await openSettings.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: '选择默认模型', exact: true }).getByRole('button', { name: '管理供应商与模型', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expectProviders(page);
  const search = providerPage(page).getByLabel('搜索供应商', { exact: true });
  await search.focus();
  await page.keyboard.type('keyboard-query');
  await expect(search).toHaveValue('keyboard-query');
  await search.fill('');
  const bounds = await providerPage(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await expectNoHorizontalOverflow(page);
  await providerPage(page).getByRole('button', { name: '返回工作台', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(providerPage(page)).not.toBeVisible();
  await page.getByRole('button', { name: '切换工作区面板' }).click();
  await page.getByRole('tab', { name: /^文件/ }).click();
  await expect(page.getByRole('button', { name: /README.md/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: '关闭工作区面板' }).click();
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('动效不会阻止任务输入');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

test('reduced motion disables long or infinite effects during API loading and interaction', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await holdResponse(page, '**/api/settings');
  try {
    await page.goto('/');
    await response.received;
    await expect(page.getByRole('status', { name: '正在载入工作区', exact: true })).toBeVisible();
    await expectReducedMotion(page);
    response.release();
    await expectReady(page);
    await expectReducedMotion(page);
    await page.getByRole('button', { name: '选择默认模型', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '选择默认模型', exact: true })).toBeVisible();
    await expectReducedMotion(page);
    await page.getByRole('button', { name: '管理供应商与模型', exact: true }).click();
    await expectProviders(page);
    await expectReducedMotion(page);
    await expectNoHorizontalOverflow(page);
    await returnToStudio(page);
    await page.getByRole('button', { name: '切换工作区面板' }).click();
    await page.getByRole('tab', { name: /^活动/ }).click();
    await expect(page.getByRole('tabpanel')).toContainText('每一步，都在这里');
    await expectReducedMotion(page);
  } finally { response.release(); }
});

for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`HTML startup loader remains accessible before JavaScript (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 390, height: 844 });
    let release;
    let intercepted = 0;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/*', async route => {
      if (route.request().resourceType() === 'script') {
        intercepted += 1;
        await gate;
      }
      await route.continue();
    });
    try {
      await page.goto('/', { waitUntil: 'commit' });
      const loader = page.getByRole('status', { name: '正在启动 青禾 Studio', exact: true });
      await expect(loader).toBeVisible();
      await expect(loader).toHaveClass(/app-boot/);
      await expect.poll(() => intercepted).toBeGreaterThan(0);
      await expect(page.locator('.studio')).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      if (reducedMotion === 'reduce') await expectReducedMotion(page);
      release();
      await expectReady(page);
      await expect(loader).toHaveCount(0);
    } finally { release(); }
  });
}

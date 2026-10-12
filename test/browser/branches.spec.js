import { test, expect } from '@playwright/test';
import { clearCatalog } from './provider-helpers.js';

const promptBox = page => page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
const editor = page => page.getByRole('form', { name: '消息分支编辑器', exact: true });
const message = (page, id) => page.locator(`[data-message-id="${id}"]`);
const branchPanel = page => page.getByRole('region', { name: '会话分支', exact: true });

test.beforeEach(async ({ request }) => {
  const sessions = await (await request.get('/api/sessions')).json();
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`);
    await request.delete(`/api/sessions/${session.id}`);
  }
  await clearCatalog(request);
  await request.patch('/api/settings', { data: { provider: 'responses', model: 'test-model', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:3418/v1', approval: 'ask', maxSteps: 20 } });
});

async function current(page, request) {
  const id = await page.evaluate(() => localStorage.getItem('harness.session'));
  return id ? (await request.get(`/api/sessions/${id}`)).json() : null;
}

async function ready(page) {
  await page.goto('/');
  await expect(page.getByText('本地已连接', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toContainText('test-model');
}

async function send(page, request, text) {
  const previousRun = (await current(page, request))?.run?.id;
  await promptBox(page).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(async () => { const session = await current(page, request); return session?.run?.id !== previousRun && session?.run?.status; }).toBe('completed');
  return current(page, request);
}

async function createBranch(page, anchorId, title) {
  await message(page, anchorId).getByRole('button', { name: '从这里分支', exact: true }).click();
  await expect(editor(page)).toContainText('不回滚或隔离工作区文件');
  if (title) await editor(page).getByRole('textbox', { name: '分支名称', exact: true }).fill(title);
  await editor(page).getByRole('button', { name: '创建分支', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(branchPanel(page)).toBeVisible();
}

test('editing an earlier message retries in a new branch without later context or lost parent drafts', async ({ page, request }, testInfo) => {
  await ready(page);
  const first = await send(page, request, '第一轮：阅读项目');
  const source = await send(page, request, '第二轮：不应进入重试上下文');
  await promptBox(page).fill('留给原会话的未发送草稿');
  await message(page, first.messages[0].id).getByRole('button', { name: '编辑并重发', exact: true }).click();
  await expect(editor(page).getByRole('textbox', { name: '重发消息', exact: true })).toHaveValue('第一轮：阅读项目');
  await editor(page).getByRole('textbox', { name: '重发消息', exact: true }).fill('修改第一轮：只查看结构');
  await editor(page).getByRole('textbox', { name: '分支名称', exact: true }).fill('新的实现路线');
  await editor(page).getByRole('button', { name: '新建分支并发送', exact: true }).click();
  await expect.poll(async () => { const session = await current(page, request); return session?.id !== source.id && session?.run?.status; }).toBe('completed');
  const branch = await current(page, request);
  expect(branch.title).toBe('新的实现路线');
  expect(branch.branch).toMatchObject({ parentSessionId: source.id, rootSessionId: source.id, mode: 'retry', inheritedMessageCount: 0 });
  expect(branch.messages.filter(entry => entry.role === 'user').map(entry => entry.content)).toEqual(['修改第一轮：只查看结构']);
  expect(await (await request.get(`/api/sessions/${source.id}`)).json()).toEqual(source);
  await expect(branchPanel(page)).toContainText('各分支对话独立');
  await branchPanel(page).locator('summary').click();
  await page.screenshot({ path: testInfo.outputPath('conversation-branches.png') });
  await branchPanel(page).getByRole('button', { name: '返回上级会话', exact: true }).click();
  await expect(promptBox(page)).toHaveValue('留给原会话的未发送草稿');
  await expect(message(page, first.messages[0].id)).toContainText('第一轮：阅读项目');
  await expect.poll(() => current(page, request)).toEqual(source);
});

test('regenerating an assistant reply preserves earlier turns and uses the currently selected model', async ({ page, request }) => {
  await ready(page);
  const first = await send(page, request, '第一轮背景');
  const second = await send(page, request, '第二轮问题');
  const source = await send(page, request, '第三轮不保留');
  await request.patch('/api/settings', { data: { provider: 'anthropic', model: 'branch-model', baseUrl: 'http://127.0.0.1:3418/v1', apiKey: 'test-key' } });
  await expect(page.getByRole('button', { name: '选择默认模型', exact: true })).toContainText('branch-model');
  await message(page, second.messages.at(-1).id).getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(editor(page).getByRole('textbox', { name: '重发消息', exact: true })).toHaveValue('第二轮问题');
  await editor(page).getByRole('button', { name: '新建分支并发送', exact: true }).click();
  await expect.poll(async () => { const session = await current(page, request); return session?.id !== source.id && session?.run?.status; }).toBe('completed');
  const branch = await current(page, request);
  expect(branch.branch.inheritedMessageCount).toBe(first.messages.length);
  expect(branch.messages.filter(entry => entry.role === 'user').map(entry => entry.content)).toEqual(['第一轮背景', '第二轮问题']);
  expect(branch.run).toMatchObject({ provider: 'anthropic', model: 'branch-model' });
  expect(await (await request.get(`/api/sessions/${source.id}`)).json()).toEqual(source);
});

test('continue branches do not run automatically and nested branches survive ancestor deletion and restart', async ({ page, request }) => {
  await ready(page);
  const source = await send(page, request, '原始上下文');
  await createBranch(page, source.messages.at(-1).id, '路线 A');
  const branch = await current(page, request);
  expect(branch.run).toBeNull();
  expect(branch.messages.map(entry => entry.content)).toEqual(source.messages.map(entry => entry.content));
  expect(branch.checkpoints).toEqual([]);
  expect(branch.plan).toEqual([]);
  await expect(promptBox(page)).toHaveValue('');
  const continued = await send(page, request, '从路线 A 继续');
  await createBranch(page, continued.messages.at(-1).id, '路线 A 的子分支');
  const nested = await current(page, request);
  expect(nested.branch).toMatchObject({ parentSessionId: branch.id, rootSessionId: source.id });
  await request.delete(`/api/sessions/${source.id}`);
  await request.delete(`/api/sessions/${branch.id}`);
  await expect(branchPanel(page)).toContainText('来源会话已删除');
  await expect(branchPanel(page).getByRole('button', { name: '返回上级会话', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(branchPanel(page)).toContainText('来源会话已删除');
  expect(await current(page, request)).toEqual(nested);
  const final = await send(page, request, '父会话删除后继续');
  expect(final.branch).toEqual(nested.branch);
  expect(final.messages.filter(entry => entry.role === 'user').map(entry => entry.content)).toEqual(['原始上下文', '从路线 A 继续', '父会话删除后继续']);
});

test('active runs block branching until stopped and never copy pending approvals', async ({ page, request }) => {
  await ready(page);
  await promptBox(page).fill('[test:write]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible();
  const source = await current(page, request);
  const anchor = source.messages[0];
  await expect(message(page, anchor.id).getByRole('button', { name: '从这里分支', exact: true })).toBeDisabled();
  await expect(message(page, anchor.id).getByRole('button', { name: '编辑并重发', exact: true })).toBeDisabled();
  expect((await request.post(`/api/sessions/${source.id}/fork`, { data: { messageId: anchor.id } })).status()).toBe(409);
  await page.getByRole('button', { name: '停止运行', exact: true }).click();
  await createBranch(page, anchor.id);
  const branch = await current(page, request);
  expect(branch.messages).toHaveLength(1);
  expect(branch.events.every(event => event.type === 'session.created')).toBe(true);
  await expect(page.getByRole('button', { name: '批准执行' })).toHaveCount(0);
});

test('failed fork keeps the editor, while failed branch startup keeps the new session and editable prompt', async ({ page, request }) => {
  await ready(page);
  const source = await send(page, request, '要重发的消息');
  await message(page, source.messages[0].id).getByRole('button', { name: '编辑并重发', exact: true }).click();
  await editor(page).getByRole('textbox', { name: '重发消息', exact: true }).fill('失败后保留的改写');
  await page.route('**/api/sessions/*/fork', route => route.fulfill({ status: 503, json: { error: '分支保存暂时失败' } }), { times: 1 });
  await editor(page).getByRole('button', { name: '新建分支并发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('分支保存暂时失败');
  await expect(editor(page).getByRole('textbox', { name: '重发消息', exact: true })).toHaveValue('失败后保留的改写');
  expect((await (await request.get('/api/sessions')).json())).toHaveLength(1);
  await page.route('**/api/sessions/*/run', route => route.fulfill({ status: 503, json: { error: '运行暂时不可用' } }), { times: 1 });
  await editor(page).getByRole('button', { name: '新建分支并发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('分支已创建');
  await expect(promptBox(page)).toHaveValue('失败后保留的改写');
  expect((await (await request.get('/api/sessions')).json())).toHaveLength(2);
  const branch = await current(page, request);
  expect(branch.id).not.toBe(source.id);
  expect(branch.run).toBeNull();
  await send(page, request, '失败后保留的改写');
  expect((await (await request.get('/api/sessions')).json())).toHaveLength(2);
  expect(await (await request.get(`/api/sessions/${source.id}`)).json()).toEqual(source);
});

test('branch editors and parent-child navigation preserve drafts on mobile with reduced motion', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  const source = await send(page, request, '手机原消息');
  await promptBox(page).fill('手机原会话草稿');
  await message(page, source.messages[0].id).getByRole('button', { name: '编辑并重发', exact: true }).click();
  await expect(editor(page).getByRole('textbox', { name: '重发消息', exact: true })).toBeFocused();
  await editor(page).getByRole('textbox', { name: '重发消息', exact: true }).fill('手机修改后重发');
  await editor(page).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('message-retry-mobile.png') });
  await editor(page).getByRole('button', { name: '取消分支操作', exact: true }).click();
  await expect(promptBox(page)).toHaveValue('手机原会话草稿');
  await createBranch(page, source.messages.at(-1).id, '手机分支');
  const branch = await current(page, request);
  await promptBox(page).fill('手机分支草稿');
  await branchPanel(page).getByRole('button', { name: '返回上级会话', exact: true }).click();
  await expect(promptBox(page)).toHaveValue('手机原会话草稿');
  await branchPanel(page).locator('summary').click();
  await branchPanel(page).locator(`[data-branch-session="${branch.id}"]`).click();
  await expect(promptBox(page)).toHaveValue('手机分支草稿');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('other browser tabs see new branches without switching away from their selected conversation', async ({ page, context, request }) => {
  await ready(page);
  const source = await send(page, request, '跨窗口原会话');
  const second = await context.newPage();
  await ready(second);
  await expect(message(second, source.messages[0].id)).toBeVisible();
  await createBranch(page, source.messages.at(-1).id, '跨窗口分支');
  await expect(second.getByRole('navigation', { name: '会话列表' })).toContainText('跨窗口分支');
  await expect(branchPanel(second)).toContainText('会话分支（2）');
  await expect(message(second, source.messages[0].id)).toBeVisible();
  expect(await (await request.get(`/api/sessions/${source.id}`)).json()).toEqual(source);
  await second.close();
});

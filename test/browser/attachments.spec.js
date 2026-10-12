import { test, expect } from '@playwright/test';
import { clearCatalog } from './provider-helpers.js';
import { docx, documentText, dropFiles, pasteFiles, pdf, png, upload, wav } from '../fixtures/attachments.js';

const composer = page => page.locator('form.composer');
const pending = page => composer(page).getByRole('group', { name: '待发送附件' });
const promptBox = page => page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' });
const send = page => page.getByRole('button', { name: '发送任务', exact: true });
const session = async (page, request) => {
  const id = await page.evaluate(() => localStorage.getItem('harness.session'));
  return id ? (await request.get(`/api/sessions/${id}`)).json() : null;
};

test.beforeEach(async ({ request }) => {
  await request.post('/api/automation/stop', { data: {} });
  for (const previous of await (await request.get('/api/sessions')).json()) { await request.post(`/api/sessions/${previous.id}/cancel`); await request.delete(`/api/sessions/${previous.id}`); }
  await clearCatalog(request);
  await request.patch('/api/settings', { data: { provider: 'responses', baseUrl: 'http://127.0.0.1:3418/v1', model: 'test-model', apiKey: 'test-key', approval: 'ask', maxContextTokens: 32000 } });
});

test('pasted images and Office files preview locally, preserve text and persist as message attachments', async ({ page, request }) => {
  await page.goto('/');
  await promptBox(page).fill('请结合图片和文档分析');
  await pasteFiles(page, [upload('剪贴板图片.png', png), upload('说明.docx', docx)]);
  await expect(pending(page).locator('.attachment-chip')).toHaveCount(2);
  await expect(pending(page).getByRole('button', { name: '预览附件 说明.docx', exact: true })).toBeEnabled();
  await expect.poll(() => pending(page).locator('img').evaluate(element => element.naturalWidth)).toBe(1);
  await pending(page).getByRole('button', { name: '预览附件 说明.docx', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '附件预览 说明.docx', exact: true });
  await expect(preview).toContainText(documentText);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(promptBox(page)).toHaveValue('请结合图片和文档分析');
  await expect(send(page)).toBeEnabled();
  await page.screenshot({ path: 'docs/screenshots/composer-attachments.png' });
  await send(page).click();
  await expect.poll(async () => (await session(page, request))?.run?.status).toBe('completed');
  await expect(pending(page)).toHaveCount(0);
  const source = await session(page, request);
  expect(source.messages[0].attachments.map(file => file.name)).toEqual(['剪贴板图片.png', '说明.docx']);
  expect(JSON.stringify(source)).not.toContain(png.toString('base64'));
  await page.reload();
  await expect(page.getByRole('group', { name: '消息附件' }).locator('.attachment-chip')).toHaveCount(2);
});

test('dragging and file picking support attachment-only tasks without hijacking plain text paste', async ({ page, request }) => {
  await page.goto('/');
  await expect(promptBox(page)).toBeEnabled();
  const allowed = await promptBox(page).evaluate(element => { const transfer = new DataTransfer(); transfer.setData('text/plain', '普通文本'); return element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); });
  expect(allowed).toBe(true);
  await dropFiles(page, [upload('设计.pdf', pdf)]);
  await expect(pending(page).getByRole('button', { name: '预览附件 设计.pdf', exact: true })).toBeEnabled();
  await page.getByLabel('导入附件文件', { exact: true }).setInputFiles({ name: '资料.txt', mimeType: 'text/plain', buffer: Buffer.from('<script>不可执行的资料</script>') });
  await expect(pending(page).getByRole('button', { name: '预览附件 资料.txt', exact: true })).toBeEnabled();
  await pending(page).getByRole('button', { name: '预览附件 资料.txt', exact: true }).click();
  await expect(page.getByRole('dialog').locator('pre')).toContainText('<script>');
  expect(await page.getByRole('dialog').locator('script').count()).toBe(0);
  await page.getByRole('button', { name: '关闭预览' }).click();
  await expect(promptBox(page)).toHaveValue('');
  await send(page).click();
  await expect.poll(async () => (await session(page, request))?.run?.status).toBe('completed');
  expect((await session(page, request)).messages[0].attachments).toHaveLength(2);
});

test('uploads block early sending and remain with the original session when navigation races the response', async ({ page, request }) => {
  const origin = await (await request.post('/api/sessions', { data: { title: '附件原会话' } })).json();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/attachments', async route => { await gate; await route.continue(); });
  await page.goto('/');
  await promptBox(page).fill('上传中保留原草稿');
  await pasteFiles(page, [upload('等待.txt', Buffer.from('延迟附件'))]);
  try {
    await expect(pending(page)).toContainText('导入工作区');
    await expect(send(page)).toBeDisabled();
    await promptBox(page).press('Enter');
    expect((await session(page, request)).run).toBeNull();
    await page.getByRole('button', { name: /新建会话/ }).click();
    await expect.poll(async () => (await session(page, request))?.id).not.toBe(origin.id);
    await expect(pending(page)).toHaveCount(0);
  } finally { release(); }
  await page.locator('.session-select').filter({ hasText: '附件原会话' }).click();
  await expect(pending(page).getByRole('button', { name: '预览附件 等待.txt', exact: true })).toBeEnabled();
  await expect(promptBox(page)).toHaveValue('上传中保留原草稿');
});

test('failed upload and failed task startup retain files for retry; regeneration inherits attachments', async ({ page, request }) => {
  await page.route('**/api/attachments', route => route.fulfill({ status: 503, json: { error: '测试导入失败' } }), { times: 1 });
  await page.goto('/');
  await expect(promptBox(page)).toBeEnabled();
  await pasteFiles(page, [upload('可重试.png', png)]);
  await expect(pending(page).getByRole('alert')).toContainText('测试导入失败');
  await expect(send(page)).toBeDisabled();
  await pending(page).getByRole('button', { name: '重试导入 可重试.png', exact: true }).click();
  await expect(pending(page).getByRole('button', { name: '预览附件 可重试.png', exact: true })).toBeEnabled();
  await page.route('**/api/sessions/*/run', route => route.fulfill({ status: 503, json: { error: '测试任务启动失败' } }), { times: 1 });
  await send(page).click();
  await expect(page.getByText('测试任务启动失败', { exact: true })).toBeVisible();
  await expect(pending(page).locator('.attachment-chip')).toHaveCount(1);
  await send(page).click();
  await expect.poll(async () => (await session(page, request))?.run?.status).toBe('completed');
  const original = await session(page, request);
  await page.locator('.message-assistant').last().getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(page.getByRole('form', { name: '消息分支编辑器' })).toContainText('可重试.png');
  await page.getByRole('button', { name: '新建分支并发送', exact: true }).click();
  await expect.poll(async () => { const current = await session(page, request); return current?.id !== original.id && current?.run?.status; }).toBe('completed');
  expect((await session(page, request)).messages[0].attachments).toEqual(original.messages[0].attachments);
  expect(await (await request.get(`/api/sessions/${original.id}`)).json()).toEqual(original);
});

test('unsupported and oversized files explain errors, and audio compatibility follows the selected protocol', async ({ page, request }) => {
  await page.goto('/');
  await expect(promptBox(page)).toBeEnabled();
  await dropFiles(page, [upload('旧版.doc', docx)]);
  await expect(composer(page).getByRole('alert')).toContainText('不支持此格式');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.getByLabel('导入附件文件', { exact: true }).setInputFiles({ name: '太大.txt', mimeType: 'text/plain', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
  await expect(composer(page).getByRole('alert')).toContainText('20 MB');
  await dropFiles(page, [upload('声音.wav', wav)]);
  await expect(pending(page).getByRole('button', { name: '预览附件 声音.wav', exact: true })).toBeEnabled();
  await expect(composer(page).getByRole('alert')).toContainText('音频附件需要');
  await expect(send(page)).toBeDisabled();
  await request.patch('/api/settings', { data: { provider: 'openai', apiKey: 'test-key' } });
  await expect(send(page)).toBeEnabled();
  const id = await pending(page).locator('.attachment-chip').getAttribute('data-attachment-id');
  await pending(page).getByRole('button', { name: '移除附件 声音.wav', exact: true }).click();
  await expect(pending(page)).toHaveCount(0);
  await expect.poll(async () => (await request.get(`/api/attachments/${id}`)).status()).toBe(404);
});

test('video import extracts real local frames without microphone or desktop capture', async ({ page, request }) => {
  await page.goto('/');
  await expect(promptBox(page)).toBeEnabled();
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 72;
    const context = canvas.getContext('2d'); context.fillStyle = '#80b94d'; context.fillRect(0, 0, 128, 72);
    const stream = canvas.captureStream(10);
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, 400));
    context.fillStyle = '#6c94bb'; context.fillRect(0, 0, 128, 72);
    await new Promise(resolve => setTimeout(resolve, 400));
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    const transfer = new DataTransfer(); transfer.items.add(new File(chunks, '合成视频.webm', { type: 'video/webm' }));
    document.querySelector('form.composer').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await expect(pending(page).getByRole('button', { name: '预览附件 合成视频.webm', exact: true })).toBeEnabled({ timeout: 20000 });
  await expect(pending(page)).toContainText('帧，无音轨');
  await expect.poll(() => pending(page).locator('img').evaluate(element => element.naturalWidth)).toBe(128);
  await send(page).click();
  await expect.poll(async () => (await session(page, request))?.run?.status).toBe('completed');
  expect((await session(page, request)).messages[0].attachments[0]).toMatchObject({ kind: 'video', frameCount: 1 });
});

test('mobile attachments retain compact horizontal chips and reduced-motion behavior', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(promptBox(page)).toBeEnabled();
  await pasteFiles(page, [upload('手机截图.png', png), upload('文档.docx', docx), upload('资料.pdf', pdf)]);
  await expect(pending(page).getByRole('button', { name: '预览附件 资料.pdf', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await pending(page).locator('.attachment-chip').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await pending(page).getByRole('button', { name: '预览附件 手机截图.png', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await page.getByRole('button', { name: '关闭预览' }).click();
  await page.screenshot({ path: 'docs/screenshots/composer-attachments-mobile.png' });
});

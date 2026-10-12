import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createHarness } from '../src/core/harness.js';
import { startServer } from '../src/server.js';
import { startModelServer } from './fixtures/model-server.js';
import { docx, documentText, pdf, png, pptx, upload, wav, xlsx } from './fixtures/attachments.js';

async function fixture(context, provider = 'responses', options = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'harness-attachment-test-'));
  const model = await startModelServer();
  const settings = { provider, model: 'test-model', apiKey: 'test-key', baseUrl: model.url, ...options };
  const harness = await createHarness({ workspace, settings });
  const server = await startServer({ harness, port: 0 });
  context.after(async () => {
    await server.close(); await harness.close(); await model.close();
    if (path.dirname(workspace) === path.resolve(os.tmpdir()) && path.basename(workspace).startsWith('harness-attachment-test-')) await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  });
  return { workspace, harness, server, model, settings };
}

async function finish(harness, id) {
  const deadline = Date.now() + 15000;
  while (['running', 'waiting_approval'].includes(harness.getSession(id).run?.status)) {
    if (Date.now() > deadline) throw new Error('Attachment run timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(harness.getSession(id).run.status, 'completed', harness.getSession(id).run.error);
}

for (const protocol of ['responses', 'openai', 'anthropic']) test(`${protocol} sends user image and PDF natively while extracting Office documents into context`, async context => {
  const { harness, model, workspace } = await fixture(context, protocol);
  const attachments = await Promise.all([upload('截图.png', png), upload('设计.pdf', pdf), upload('说明.docx', docx), upload('表格.xlsx', xlsx), upload('演示.pptx', pptx)].map(input => harness.importAttachment(input)));
  const session = await harness.createSession();
  await harness.run(session.id, '', { attachments: attachments.map(file => file.id) });
  await finish(harness, session.id);
  const body = model.requests[0].body;
  const blocks = protocol === 'responses' ? body.input.find(item => item.role === 'user').content : body.messages.find(message => message.role === 'user').content;
  assert.ok(JSON.stringify(blocks).includes(documentText));
  assert.ok(JSON.stringify(blocks).includes('A1: 项目预算'));
  assert.ok(JSON.stringify(blocks).includes('演示文档标题'));
  if (protocol === 'responses') {
    assert.equal(blocks.find(block => block.type === 'input_image').image_url, `data:image/png;base64,${png.toString('base64')}`);
    assert.equal(blocks.find(block => block.type === 'input_file').file_data, `data:application/pdf;base64,${pdf.toString('base64')}`);
  } else if (protocol === 'openai') {
    assert.equal(blocks.find(block => block.type === 'image_url').image_url.url, `data:image/png;base64,${png.toString('base64')}`);
    assert.equal(blocks.find(block => block.type === 'file').file.filename, '设计.pdf');
  } else {
    assert.equal(blocks.find(block => block.type === 'image').source.data, png.toString('base64'));
    assert.equal(blocks.find(block => block.type === 'document').source.data, pdf.toString('base64'));
  }
  await harness.flush();
  const stored = await readFile(path.join(workspace, '.harness', 'sessions', `${session.id}.json`), 'utf8');
  assert.ok(!stored.includes(png.toString('base64')));
  assert.ok(!stored.includes(documentText));
  assert.equal(JSON.parse(stored).messages[0].attachments.length, 5);
});

test('audio is sent as native Chat input_audio and incompatible protocols fail before changing history', async context => {
  const { harness, model } = await fixture(context, 'openai');
  const audio = await harness.importAttachment(upload('声音.wav', wav));
  const session = await harness.createSession();
  await harness.run(session.id, '分析音频', { attachments: [audio.id] });
  await finish(harness, session.id);
  assert.deepEqual(model.requests[0].body.messages.find(message => message.role === 'user').content.find(block => block.type === 'input_audio'), { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } });
  await harness.updateSettings({ provider: 'responses', apiKey: 'test-key' });
  const previous = harness.getSession(session.id);
  await assert.rejects(harness.run(session.id, '不应发送', { attachments: [audio.id] }), /音频附件需要/);
  assert.deepEqual(harness.getSession(session.id), previous);
});

test('attachment-only messages, branches and restart keep immutable files without duplicating base64 into sessions', async context => {
  const { harness, workspace, settings } = await fixture(context);
  const attachment = await harness.importAttachment(upload('笔记.txt', Buffer.from('保留到下次启动')));
  const session = await harness.createSession();
  await harness.run(session.id, '', { attachments: [attachment.id] });
  await finish(harness, session.id);
  const parent = harness.getSession(session.id);
  const child = await harness.forkSession(session.id, { messageId: parent.messages.at(-1).id });
  assert.deepEqual(child.messages[0].attachments, parent.messages[0].attachments);
  await harness.deleteSession(session.id);
  await assert.rejects(harness.deleteAttachment(attachment.id), /已用于会话/);
  await harness.close();
  const reopened = await createHarness({ workspace, settings });
  try {
    assert.equal((await reopened.getAttachment(attachment.id)).preview, '保留到下次启动');
    await reopened.run(child.id, '继续');
    await finish(reopened, child.id);
  } finally { await reopened.close(); }
});

test('long documents expose bounded previews and a session-scoped paginated read tool', async context => {
  const { harness } = await fixture(context);
  const file = await harness.importAttachment(upload('长文.txt', Buffer.from('甲'.repeat(9000) + '尾部证据')));
  const session = await harness.createSession();
  await harness.run(session.id, '读取资料', { attachments: [file.id] });
  await finish(harness, session.id);
  const tool = harness.toolRegistry.get('read_attachment');
  const part = await tool.execute({ id: file.id, offset: 9000, limit: 100 }, { sessionId: session.id });
  assert.equal(part.content, '尾部证据');
  assert.equal(part.hasMore, false);
  const other = await harness.createSession();
  await assert.rejects(tool.execute({ id: file.id }, { sessionId: other.id }), /不属于当前会话/);
});

test('uploads reject invalid formats, traversal, malformed encodings, duplicates, oversize and zip bombs', async context => {
  const { harness } = await fixture(context);
  for (const input of [upload('../bad.txt', png), upload('程序.exe', png), upload('伪造.png', Buffer.from('<svg onload="alert(1)"/>')), { name: 'bad.txt', data: 'not valid base64' }, upload('binary.txt', Buffer.from([0, 1, 2])), upload('old.doc', docx)]) await assert.rejects(harness.importAttachment(input));
  await assert.rejects(harness.importAttachment(upload('large.txt', Buffer.alloc(20 * 1024 * 1024 + 1))), /大小限制/);
  const bomb = Buffer.from(zipSync({ 'word/document.xml': strToU8('A'.repeat(13 * 1024 * 1024)) }));
  await assert.rejects(harness.importAttachment(upload('bomb.docx', bomb)), /安全限制/);
  const file = await harness.importAttachment(upload('valid.txt', Buffer.from('正常资料')));
  const session = await harness.createSession();
  await assert.rejects(harness.run(session.id, 'test', { attachments: [file.id, file.id] }), /不重复/);
  assert.equal(harness.getSession(session.id).messages.length, 0);
  await harness.deleteAttachment(file.id);
  await assert.rejects(harness.getAttachment(file.id), /不存在/);
});

test('isolated Office extraction bounds text, rejects malformed XML and recovers for the next import', async context => {
  const { harness } = await fixture(context);
  const malformed = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8('<worksheet>' + '<row>'.repeat(50000) + '</worksheet>') }));
  await assert.rejects(harness.importAttachment(upload('broken.xlsx', malformed)), /不完整|嵌套|未闭合/);
  const entity = Buffer.from(zipSync({ 'xl/sharedStrings.xml': strToU8('<!DOCTYPE sheet [<!ENTITY secret SYSTEM "file:///secret">]><sst/>'), 'xl/worksheets/sheet1.xml': strToU8('<worksheet/>') }));
  await assert.rejects(harness.importAttachment(upload('entity.xlsx', entity)), /实体声明/);
  const long = Buffer.from(zipSync({ 'word/document.xml': strToU8(`<w:document><w:p>${'资料'.repeat(90000)}</w:p></w:document>`) }));
  const imported = await harness.importAttachment(upload('long.docx', long));
  assert.equal(imported.truncated, true);
  assert.equal((await harness.attachments.record(imported.id)).text.length, 120000);
  const recovered = await harness.importAttachment(upload('valid.docx', docx));
  assert.ok((await harness.getAttachment(recovered.id)).preview.includes(documentText));
});

test('concurrent deletion cannot release the send guard before the first delete finishes', async context => {
  const { harness } = await fixture(context);
  const file = await harness.importAttachment(upload('delete.txt', Buffer.from('待移除')));
  const session = await harness.createSession();
  const deleting = harness.deleteAttachment(file.id);
  const duplicate = assert.rejects(harness.deleteAttachment(file.id), /正在移除/);
  const sending = assert.rejects(harness.run(session.id, '分析', { attachments: [file.id] }), /正在移除/);
  await Promise.all([deleting, duplicate, sending]);
  assert.equal(harness.getSession(session.id).messages.length, 0);
  assert.equal(harness.attachments.deleting.size, 0);
});

test('HTTP protects uploads and persisted previews with authentication, origin rules and media byte ranges', async context => {
  const { harness } = await fixture(context);
  const token = 'attachment-test-token-012345678901234567890';
  const server = await startServer({ harness, port: 0, authToken: token });
  context.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-harness-token': token };
  const url = `${server.url}/api/attachments`;
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(upload('image.png', png)) })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body: JSON.stringify(upload('image.png', png)) })).status, 403);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upload('image.png', png)) });
  assert.equal(response.status, 201);
  const file = await response.json();
  assert.equal(file.data, undefined);
  assert.equal((await fetch(`${url}/${file.id}/content`)).status, 401);
  const partial = await fetch(`${url}/${file.id}/content`, { headers: { ...headers, range: 'bytes=0-7' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), png.subarray(0, 8));
  assert.equal((await fetch(`${url}/${file.id}/content`, { headers: { ...headers, range: 'bytes=99999-' } })).status, 416);
});

test('storage rejects symlinks and only prunes stale unreferenced imports', async context => {
  const { harness, workspace } = await fixture(context);
  const file = await harness.importAttachment(upload('unused.txt', Buffer.from('过期草稿')));
  const location = path.join(workspace, '.harness', 'attachments', `${file.id}.json`);
  await utimes(location, 0, 0);
  await harness.attachments.prune();
  await assert.rejects(harness.getAttachment(file.id), /不存在/);
  const outside = path.join(workspace, 'outside.json');
  await writeFile(outside, JSON.stringify({ secret: 'not-an-attachment' }));
  try { await symlink(outside, location); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  await assert.rejects(harness.getAttachment(file.id), /安全的普通文件/);
  assert.ok((await readdir(path.dirname(location))).length);
});

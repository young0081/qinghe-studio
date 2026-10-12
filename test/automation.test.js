import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHarness } from '../src/core/harness.js';
import { BrowserController, browserUrl, findBrowser } from '../src/automation/browser.js';
import { desktopKeys } from '../src/automation/index.js';
import { desktopOperation } from '../src/automation/desktop.js';
import { validateArguments } from '../src/core/tools.js';
import { startServer } from '../src/server.js';

const image = { mimeType: 'image/jpeg', data: Buffer.from('test-only-image-not-a-real-screen').toString('base64') };
const screenshot = { width: 800, height: 400, bounds: { x: -1600, y: 0, width: 1600, height: 800 }, windowId: '123', image };

async function fixture(context, options = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'harness-automation-'));
  const harness = await createHarness({ workspace, settings: { model: 'mock-vision', apiKey: 'fixture-only-key', approval: 'auto', ...options.settings }, completion: options.completion });
  context.after(async () => { await harness.close(); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { harness, workspace };
}

function terminal(harness, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { harness.off('event', listener); reject(new Error('test run timed out')); }, 15000);
    const listener = event => { if (event.sessionId === id && /^run\.(completed|failed|cancelled)$/.test(event.type)) { clearTimeout(timer); harness.off('event', listener); resolve(event); } };
    harness.on('event', listener);
  });
}

test('automation defaults off, explicit transient enablement and readonly guards', async context => {
  const { harness, workspace } = await fixture(context);
  assert.equal(harness.getAutomation().browser, false);
  assert.equal(harness.getAutomation().desktop, false);
  assert.equal(harness.getTools().some(tool => ['browser', 'computer'].includes(tool.name)), false);
  await assert.rejects(harness.configureAutomation({ shell: true }), /仅接受/);
  await assert.rejects(harness.configureAutomation({ desktop: 'true' }), /布尔/);
  await harness.updateSettings({ approval: 'readonly' });
  await assert.rejects(harness.configureAutomation({ browser: true }), /只读/);
  assert.throws(() => harness.automation.prepare('desktop', 'session'), /未启用/);
  await harness.updateSettings({ approval: 'ask' });
  if (process.platform === 'win32') await harness.configureAutomation({ desktop: true });
  await harness.close();
  const reopened = await createHarness({ workspace });
  context.after(() => reopened.close());
  assert.equal(reopened.getAutomation().desktop, false);
});

test('desktop shortcuts and bounded arguments reject scripts and oversized values', () => {
  assert.deepEqual(desktopKeys('Ctrl+Shift+L'), [17, 16, 76]);
  assert.deepEqual(desktopKeys('Alt+F4'), [18, 115]);
  assert.throws(() => desktopKeys('A+Ctrl'), /格式/);
  assert.throws(() => desktopKeys('$(Start-Process calc)'), /不支持/);
  assert.throws(() => validateArguments({ text: '1234' }, { type: 'object', properties: { text: { type: 'string', maxLength: 3 } } }), /长度/);
  for (const url of ['file:///secret', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@example.com', 'http://127.0.0.1:3210/api/settings']) assert.throws(() => browserUrl(url, new Set([3210])));
  assert.equal(browserUrl('http://localhost:5000'), 'http://localhost:5000/');
});

test('desktop native helper compiles without capturing or changing the user desktop', { skip: process.platform !== 'win32' }, async () => {
  assert.deepEqual(await desktopOperation({ action: 'probe' }, new AbortController().signal), { available: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(desktopOperation({ action: 'probe' }, controller.signal), { name: 'AbortError' });
});

test('desktop coordinates use fresh, single-use, session-bound captures and no clipboard', async context => {
  const { harness } = await fixture(context);
  const calls = [];
  harness.automation.enabled.desktop = true;
  harness.automation.desktop = async args => { calls.push(args); return args.action === 'screenshot' ? screenshot : { ok: true }; };
  const operation = { sessionId: 'test-session', callId: 'test-call', signal: new AbortController().signal };
  const capture = await harness.automation.execute('desktop', { action: 'screenshot' }, operation);
  assert.equal(JSON.stringify(capture).includes(image.data), false);
  assert.equal(JSON.stringify(harness.getAutomation()).includes(image.data), false);
  await assert.rejects(harness.automation.execute('desktop', { action: 'click', screenshotId: capture.screenshotId, x: 800, y: 0 }, operation), /坐标/);
  await harness.automation.execute('desktop', { action: 'click', screenshotId: capture.screenshotId, x: 100, y: 200 }, operation);
  assert.equal(calls.at(-1).x, -1400);
  assert.equal(calls.at(-1).y, 400);
  assert.equal(calls.at(-1).windowId, '123');
  await assert.rejects(harness.automation.execute('desktop', { action: 'key', key: 'Enter', screenshotId: capture.screenshotId }, operation), /过期/);
  await assert.rejects(harness.automation.execute('desktop', { action: 'screenshot' }, { ...operation, sessionId: 'another' }), /占用/);
  const newer = await harness.automation.execute('desktop', { action: 'screenshot' }, operation);
  harness.automation.capture(newer.screenshotId).createdAt = new Date(Date.now() - 61000).toISOString();
  await assert.rejects(harness.automation.execute('desktop', { action: 'type', text: '中文', screenshotId: newer.screenshotId }, operation), /过期/);
  harness.automation.owner = null;
  await harness.stopAutomation();
  assert.equal(harness.getAutomation().captures.length, 0);
  assert.throws(() => harness.getScreenshot(newer.screenshotId), { statusCode: 404 });
});

test('desktop runs without approval under auto and screenshot reaches model, not persistence', async context => {
  let step = 0;
  let vision;
  const { harness, workspace } = await fixture(context, { completion: async (_settings, request) => {
    step++;
    if (step > 1) vision = request.messages.find(message => message.images?.length);
    return { content: step === 1 ? '' : '看到了截图', toolCalls: step === 1 ? [{ id: 'screen-call', name: 'computer', args: { action: 'screenshot' } }] : [], usage: { inputTokens: 5, outputTokens: 5 } };
  } });
  harness.automation.enabled.desktop = true;
  harness.automation.desktop = async () => screenshot;
  let approvals = 0;
  harness.on('event', event => { if (event.type === 'approval.required') { approvals++; void harness.resolveApproval(event.data.id, true); } });
  const session = await harness.createSession();
  const done = terminal(harness, session.id);
  await harness.run(session.id, 'test screenshot');
  assert.equal((await done).type, 'run.completed');
  assert.equal(approvals, 0);
  assert.deepEqual(vision.images, [image]);
  assert.equal(vision.toolCallId, 'screen-call');
  assert.equal(harness.automation.imagesFor(harness.getSession(session.id).messages, session.id, 'different-run').some(message => message.images?.length), false);
  const persisted = await readFile(path.join(workspace, '.harness', 'sessions', `${session.id}.json`), 'utf8');
  assert.equal(persisted.includes(image.data), false);
  assert.equal(persisted.includes('screenshotId'), true);
});

test('emergency stop cancels an automation approval without executing it', async context => {
  let calls = 0;
  const { harness } = await fixture(context, { settings: { approval: 'ask' }, completion: async () => ({ content: '', toolCalls: [{ id: 'stop-call', name: 'computer', args: { action: 'screenshot' } }], usage: { inputTokens: 1, outputTokens: 1 } }) });
  harness.automation.enabled.desktop = true;
  harness.automation.desktop = async () => { calls++; return screenshot; };
  harness.on('event', event => { if (event.type === 'approval.required') void harness.stopAutomation(); });
  const session = await harness.createSession();
  const done = terminal(harness, session.id);
  await harness.run(session.id, 'do not capture');
  assert.equal((await done).type, 'run.cancelled');
  assert.equal(calls, 0);
  assert.equal(harness.approvals.size, 0);
  assert.equal(harness.getAutomation().desktop, false);
});

test('automation HTTP routes protect screenshots and reject cross-site writes', async context => {
  const { harness } = await fixture(context);
  const server = await startServer({ harness, port: 0, authToken: 'a'.repeat(40) });
  context.after(() => server.close());
  const headers = { 'x-harness-token': 'a'.repeat(40), 'content-type': 'application/json' };
  assert.equal((await fetch(`${server.url}/api/automation`)).status, 401);
  assert.equal((await fetch(`${server.url}/api/automation`, { method: 'PATCH', headers: { ...headers, origin: 'https://hostile.example' }, body: JSON.stringify({ browser: true }) })).status, 403);
  harness.automation.captures.set('test-image', { id: 'test-image', image });
  const response = await fetch(`${server.url}/api/automation/screenshots/test-image`, { headers });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), image.data);
  await fetch(`${server.url}/api/automation/stop`, { method: 'POST', headers, body: '{}' });
  assert.equal((await fetch(`${server.url}/api/automation/screenshots/test-image`, { headers })).status, 404);
  assert.throws(() => browserUrl(server.url, harness.automation.blockedPorts), /青禾 Studio/);
});

test('real isolated Browser navigates, fills, clicks, screenshots, rejects stale refs and cancels', async context => {
  if (!await findBrowser()) { context.skip('No installed browser'); return; }
  const server = http.createServer((request, response) => {
    if (request.url === '/slow') return;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<html><title>Isolated fixture</title><body><label>Name<input aria-label="Name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output><input type="password" value="not-captured"></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = new BrowserController();
  context.after(() => browser.close());
  const signal = new AbortController().signal;
  const url = `http://127.0.0.1:${server.address().port}`;
  let snapshot = await browser.execute({ action: 'navigate', url }, signal);
  assert.equal(snapshot.title, 'Isolated fixture');
  assert.equal(snapshot.text.includes('not-captured'), false);
  const oldRef = snapshot.elements.find(element => element.name === 'Name').ref;
  snapshot = await browser.execute({ action: 'fill', ref: oldRef, text: '中文 Browser' }, signal);
  await assert.rejects(browser.execute({ action: 'click', ref: oldRef }, signal), /失效/);
  snapshot = await browser.execute({ action: 'click', ref: snapshot.elements.find(element => element.name === 'Save').ref }, signal);
  assert.match(snapshot.text, /中文 Browser/);
  const capture = await browser.execute({ action: 'screenshot' }, signal);
  assert.equal(capture.width, 1280);
  assert.ok(capture.image.data.length > 100);
  assert.equal((await browser.execute({ action: 'tabs' }, signal)).tabs.length, 1);
  await assert.rejects(browser.execute({ action: 'navigate', url: 'file:///C:/Windows/win.ini' }, signal), /HTTP/);
  browser.blockedPorts.add(server.address().port);
  await assert.rejects(browser.execute({ action: 'navigate', url }, signal), /青禾 Studio/);
  browser.blockedPorts.clear();
  const controller = new AbortController();
  const navigation = browser.execute({ action: 'navigate', url: `${url}/slow` }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(navigation);
  assert.equal(browser.pages.size, 0);
  assert.equal(browser.browser, null);
});

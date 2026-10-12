import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserController, findBrowser } from '../src/automation/browser.js';
import { Automation } from '../src/automation/index.js';
import { createHarness } from '../src/core/harness.js';

async function until(read, predicate = Boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read();
    if (predicate(value)) return value;
    await delay(30);
  }
  assert.fail('Timed out waiting for browser live frame');
}

async function website(context) {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/embedded') {
      response.end('<html><body style="margin:0"><input type="password" value="embedded-secret" style="width:250px;height:35px"></body></html>');
      return;
    }
    response.end(`<html><title>${request.url === '/second' ? 'Second tab' : 'Live fixture'}</title><style>body{margin:0;height:2200px;background:linear-gradient(white,skyblue)}#secret{position:absolute;left:20px;top:60px;width:280px;height:40px}iframe{position:absolute;left:20px;top:120px;width:300px;height:80px;border:0}#pulse{position:absolute;left:400px;top:100px;width:300px;height:200px;font-size:70px}</style><body><input aria-label="Name"><button onclick="document.title='Clicked';document.querySelector('output').textContent=document.querySelector('input').value">Save</button><output></output><input id="secret" type="password" value="live-secret"><iframe src="/embedded"></iframe><div id="pulse"></div><script>let tick=0;setInterval(()=>{const p=document.getElementById('pulse');p.textContent=++tick;p.style.background='hsl('+tick*37+',70%,65%)'},70)</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('live browser captures changing pages between tools, masks passwords and follows interactions and tabs', async context => {
  if (!await findBrowser()) { context.skip('No installed browser'); return; }
  const url = await website(context);
  const browser = new BrowserController();
  context.after(() => browser.close());
  const signal = new AbortController().signal;
  browser.setLiveContext({ sessionId: 'live-session', runId: 'live-run', action: 'navigate' });
  let snapshot = await browser.execute({ action: 'navigate', url }, signal);
  const first = await until(() => browser.getBrowserFrame());
  const next = await until(() => browser.getBrowserFrame(), frame => frame?.sequence >= first.sequence + 2);
  assert.notDeepEqual(next.data, first.data);
  assert.equal(browser.getBrowserLive().sessionId, 'live-session');
  assert.equal(browser.getBrowserLive().runId, 'live-run');
  assert.equal(browser.getBrowserLive().tabId, snapshot.tabId);
  assert.equal(browser.getBrowserLive().title, 'Live fixture');
  assert.ok(next.data.length < 2 * 1024 * 1024);
  assert.equal(next.mimeType, 'image/jpeg');
  const pixels = await browser.page().page.evaluate(async data => {
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(data), character => character.charCodeAt(0))], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const drawing = canvas.getContext('2d');
    drawing.drawImage(image, 0, 0);
    image.close();
    return [[80, 80], [80, 140]].map(([x, y]) => [...drawing.getImageData(x, y, 1, 1).data]);
  }, next.data.toString('base64'));
  for (const [red, green, blue] of pixels) assert.ok(red > 220 && green < 45 && blue > 220, `Expected a password mask, got ${red},${green},${blue}`);
  snapshot = await browser.execute({ action: 'fill', ref: snapshot.elements.find(element => element.name === 'Name').ref, text: 'Live input' }, signal);
  assert.equal(browser.getBrowserLive().action, 'fill');
  snapshot = await browser.execute({ action: 'click', ref: snapshot.elements.find(element => element.name === 'Save').ref }, signal);
  assert.match(snapshot.text, /Live input/);
  await until(() => browser.getBrowserLive(), state => state.title === 'Clicked');
  await browser.execute({ action: 'scroll', delta: 600 }, signal);
  assert.equal(browser.getBrowserLive().action, 'scroll');
  await until(() => browser.getBrowserFrame(), frame => frame?.sequence > next.sequence);
  const second = await browser.execute({ action: 'navigate', url: `${url}/second` }, signal);
  assert.notEqual(second.tabId, snapshot.tabId);
  await until(() => browser.getBrowserLive(), state => state.title === 'Second tab' && state.sequence > 0);
  const tabs = await browser.execute({ action: 'tabs', tabId: snapshot.tabId }, signal);
  assert.equal(tabs.activeTabId, snapshot.tabId);
  assert.equal(browser.getBrowserFrame(), null);
  await until(() => browser.getBrowserLive(), state => state.title === 'Clicked' && state.sequence > 0);
  await browser.page(snapshot.tabId).page.close();
  await until(() => browser.getBrowserLive(), state => state.tabId === second.tabId && state.title === 'Second tab' && state.sequence > 0);
  await browser.close();
  await delay(300);
  assert.equal(browser.getBrowserFrame(), null);
  assert.equal(browser.getBrowserLive().active, false);
  assert.equal(browser.getBrowserLive().sessionId, null);
  assert.equal(browser.liveTimer, null);
});

test('live capture has one in-flight frame and discards a frame finishing after stop', async () => {
  const browser = new BrowserController();
  let calls = 0;
  let finish;
  const page = {
    isClosed: () => false,
    url: () => 'https://example.test/',
    title: async () => 'Backpressure fixture',
    frames: () => [],
    screenshot: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
  };
  browser.pages.set('fixture-tab', page);
  browser.followPage(page, 'fixture-tab');
  await until(() => finish);
  await delay(600);
  assert.equal(calls, 1);
  assert.equal(browser.getBrowserFrame(), null);
  await browser.close();
  finish(Buffer.from('discarded-frame'));
  await until(() => browser.liveCapture === null);
  assert.equal(browser.getBrowserFrame(), null);
  assert.equal(browser.getBrowserLive().active, false);
  assert.equal(browser.liveTimer, null);
});

test('desktop presentation completes before helper execution and restores after success, error or cancellation', async () => {
  const calls = [];
  const automation = new Automation({ settings: { approval: 'auto' }, sanitize: value => value, emit: () => {} }, {
    desktop: async () => { calls.push('helper'); return { ok: true }; },
  });
  automation.enabled.desktop = true;
  const controller = new AbortController();
  const operation = { sessionId: 'presentation-session', runId: 'presentation-run', signal: controller.signal };
  automation.setDesktopPresentation(async phase => {
    calls.push(phase);
    if (phase === 'before') await delay(20);
    else assert.equal(automation.busy, null);
  });
  assert.deepEqual(await automation.execute('desktop', { action: 'windows' }, operation), { ok: true });
  assert.deepEqual(calls, ['before', 'helper', 'after']);
  calls.length = 0;
  automation.setDesktopPresentation(async phase => {
    calls.push(phase);
    if (phase === 'before') throw new Error('Presentation failed');
  });
  await assert.rejects(automation.execute('desktop', { action: 'windows' }, operation), /Presentation failed/);
  assert.deepEqual(calls, ['before', 'after']);
  assert.equal(automation.busy, null);
  calls.length = 0;
  automation.setDesktopPresentation(async phase => {
    calls.push(phase);
    if (phase === 'before') controller.abort();
  });
  await assert.rejects(automation.execute('desktop', { action: 'windows' }, operation), { name: 'AbortError' });
  assert.deepEqual(calls, ['before', 'after']);
  assert.equal(automation.busy, null);
  automation.setDesktopPresentation(null);
  assert.throws(() => automation.setDesktopPresentation(true), TypeError);
});

test('browser live frames never become model images, tool captures or session history and clear at run completion', async context => {
  if (!await findBrowser()) { context.skip('No installed browser'); return; }
  const url = await website(context);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'harness-browser-live-'));
  let harness;
  let step = 0;
  let frame;
  const events = [];
  harness = await createHarness({ workspace, settings: { model: 'test-live', apiKey: 'fixture-key', approval: 'auto' }, completion: async (_settings, request) => {
    if (++step === 1) return { content: '', toolCalls: [{ id: 'live-navigation', name: 'browser', args: { action: 'navigate', url } }], usage: { inputTokens: 1, outputTokens: 1 } };
    const first = await until(() => harness.automation.getBrowserFrame());
    frame = await until(() => harness.automation.getBrowserFrame(), candidate => candidate?.sequence >= first.sequence + 2);
    assert.equal(harness.automation.captures.size, 0);
    assert.equal(request.messages.some(message => message.images?.length), false);
    assert.equal(JSON.stringify(request).includes(frame.data.toString('base64')), false);
    return { content: 'Live task complete', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  } });
  context.after(async () => { await harness.close(); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  harness.on('event', event => events.push(event));
  await harness.configureAutomation({ browser: true });
  const session = await harness.createSession();
  await harness.run(session.id, 'Observe the isolated local page');
  const done = await until(() => events.find(event => event.sessionId === session.id && /^run\.(completed|failed|cancelled)$/.test(event.type)), Boolean, 15000);
  assert.equal(done.type, 'run.completed');
  assert.ok(frame?.data.length);
  assert.equal(JSON.stringify(events).includes(frame.data.toString('base64')), false);
  const persisted = await readFile(path.join(workspace, '.harness', 'sessions', `${session.id}.json`), 'utf8');
  assert.equal(persisted.includes(frame.data.toString('base64')), false);
  assert.equal(persisted.includes('image/jpeg'), false);
  assert.equal(harness.automation.getBrowserFrame(), null);
  assert.equal(harness.automation.getBrowserLive().active, false);
});

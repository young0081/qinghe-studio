import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { VERSION } from './version.js';

const distribution = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json; charset=utf-8' };
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function providerScope(url) {
  const values = url.searchParams.getAll('scope');
  if (values.length > 1 || values.length === 1 && !['global', 'workspace'].includes(values[0])) throw httpError('scope must be global or workspace', 400);
  return values[0];
}

async function readJson(request, limit = 1024 * 1024) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw httpError('Content-Type must be application/json', 415);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw httpError(`Request body exceeds ${limit / 1024 / 1024} MiB`, 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed;
  } catch {
    throw httpError('Invalid JSON object', 400);
  }
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${url}'`] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

export async function startServer({ harness, host = '127.0.0.1', port = 3210, open = false, authToken } = {}) {
  if (!harness) throw new Error('A harness instance is required');
  if (authToken !== undefined && (typeof authToken !== 'string' || authToken.length < 32)) throw new Error('Desktop authentication token must contain at least 32 characters');
  if (!loopback.has(host)) throw new Error('WebUI only binds to a loopback address');
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) throw new Error('Invalid port');
  const clients = new Set();
  let address;
  let closing = false;

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    try {
      if (authToken) {
        const received = Buffer.from(String(request.headers['x-harness-token'] || ''));
        const expected = Buffer.from(authToken);
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw httpError('Desktop authentication required', 401);
      }
      const hostUrl = new URL(`http://${request.headers.host || ''}`);
      if (!loopback.has(hostUrl.hostname) || Number(hostUrl.port || 80) !== address.port) throw httpError('Host is not allowed', 403);
      if (request.headers.origin) {
        let origin;
        try { origin = new URL(request.headers.origin); } catch { throw httpError('Origin is not allowed', 403); }
        const sameOrigin = origin.origin === hostUrl.origin;
        const devOrigin = origin.protocol === 'http:' && loopback.has(origin.hostname) && origin.port === '5173';
        if (!sameOrigin && !devOrigin) throw httpError('Origin is not allowed', 403);
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') throw httpError('Cross-site requests are not allowed', 403);
      const url = new URL(request.url, hostUrl);
      const route = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
      const method = request.method;
      if (route[0] === 'api' && !(route.length === 2 && route[1] === 'health')) harness.assertReady?.();
      if (route[0] !== 'api') {
        if (method !== 'GET' && method !== 'HEAD') throw httpError('Method not allowed', 405);
        const relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/, '') || 'index.html';
        let target = path.resolve(distribution, relative);
        if (!target.startsWith(distribution + path.sep) && target !== path.join(distribution, 'index.html')) throw httpError('Invalid asset path', 400);
        try {
          const information = await stat(target);
          if (!information.isFile()) target = path.join(distribution, 'index.html');
        } catch {
          if (path.extname(relative)) throw httpError('Asset not found. Run npm run build first.', 404);
          target = path.join(distribution, 'index.html');
        }
        let content;
        try { content = await readFile(target); } catch { throw httpError('WebUI has not been built. Run npm run build first.', 503); }
        response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target)] || 'application/octet-stream', 'Cache-Control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
        response.end(method === 'HEAD' ? undefined : content);
        return;
      }
      if (method === 'GET' && route.length === 2 && route[1] === 'health') {
        sendJson(response, 200, { ok: true, workspace: harness.workspace, version: VERSION });
      } else if (route.length === 2 && route[1] === 'attachments' && method === 'POST') {
        const target = harness.assertReady?.() || harness;
        sendJson(response, 201, await target.importAttachment(await readJson(request, 36 * 1024 * 1024)));
      } else if (route.length === 3 && route[1] === 'attachments' && method === 'GET') {
        sendJson(response, 200, await harness.getAttachment(route[2]));
      } else if (route.length === 3 && route[1] === 'attachments' && method === 'DELETE') {
        await harness.deleteAttachment(route[2]);
        sendJson(response, 200, { ok: true });
      } else if (route.length === 4 && route[1] === 'attachments' && route[3] === 'content' && ['GET', 'HEAD'].includes(method)) {
        const file = await harness.attachmentContent(route[2], url.searchParams.get('thumbnail') === '1');
        response.setHeader('Content-Type', file.mimeType);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Accept-Ranges', 'bytes');
        let start = 0;
        let end = file.data.length - 1;
        if (request.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
          if (!range || !range[1] && !range[2]) throw httpError('Invalid byte range', 416);
          start = range[1] ? Number(range[1]) : Math.max(0, file.data.length - Number(range[2]));
          end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end;
          if (start > end || start >= file.data.length) throw httpError('Byte range out of bounds', 416);
          response.setHeader('Content-Range', `bytes ${start}-${end}/${file.data.length}`);
          response.statusCode = 206;
        }
        response.setHeader('Content-Length', end - start + 1);
        response.end(method === 'HEAD' ? undefined : file.data.subarray(start, end + 1));
      } else if (route.length === 2 && route[1] === 'automation' && method === 'GET') {
        sendJson(response, 200, harness.getAutomation());
      } else if (route.length === 3 && route[1] === 'automation' && route[2] === 'browser-live' && method === 'GET') {
        const target = harness.assertReady?.() || harness;
        sendJson(response, 200, target.automation.getBrowserLive());
      } else if (route.length === 4 && route[1] === 'automation' && route[2] === 'browser-live' && route[3] === 'frame' && method === 'GET') {
        const target = harness.assertReady?.() || harness;
        const frame = target.automation.getBrowserFrame();
        response.setHeader('Cache-Control', 'no-store');
        if (!frame) { response.writeHead(204); response.end(); return; }
        if (url.searchParams.get('after') === String(frame.sequence)) { response.writeHead(204); response.end(); return; }
        response.writeHead(200, { 'Content-Type': frame.mimeType, 'X-Frame-Sequence': String(frame.sequence) });
        response.end(frame.data);
      } else if (route.length === 2 && route[1] === 'automation' && method === 'PATCH') {
        sendJson(response, 200, await harness.configureAutomation(await readJson(request)));
      } else if (route.length === 3 && route[1] === 'automation' && route[2] === 'stop' && method === 'POST') {
        await readJson(request);
        sendJson(response, 200, await harness.stopAutomation());
      } else if (route.length === 4 && route[1] === 'automation' && route[2] === 'screenshots' && method === 'GET') {
        const image = harness.getScreenshot(route[3]);
        response.writeHead(200, { 'Content-Type': image.mimeType, 'Cache-Control': 'no-store' });
        response.end(Buffer.from(image.data, 'base64'));
      } else if (route.length === 2 && route[1] === 'settings' && method === 'GET') {
        sendJson(response, 200, harness.getSettings());
      } else if (route.length === 2 && route[1] === 'settings' && method === 'PATCH') {
        sendJson(response, 200, await harness.updateSettings(await readJson(request)));
      } else if (route.length === 3 && route[1] === 'connection' && route[2] === 'test' && method === 'POST') {
        sendJson(response, 200, await harness.testConnection(await readJson(request)));
      } else if (route.length === 2 && route[1] === 'provider-scopes' && method === 'GET') {
        sendJson(response, 200, harness.getProviderScopes());
      } else if (route.length === 2 && route[1] === 'provider-scopes' && method === 'POST') {
        const body = await readJson(request);
        if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'scope') || !['global', 'workspace'].includes(body.scope)) throw httpError('scope must be global or workspace', 400);
        sendJson(response, 200, await harness.setProviderScope(body.scope));
      } else if (route.length === 2 && route[1] === 'providers' && method === 'GET') {
        sendJson(response, 200, harness.getProviderCatalog(providerScope(url)));
      } else if (route.length === 2 && route[1] === 'providers' && method === 'POST') {
        sendJson(response, 201, await harness.createProvider(await readJson(request), providerScope(url)));
      } else if (route.length === 3 && route[1] === 'providers' && route[2] === 'active' && method === 'POST') {
        const body = await readJson(request);
        if ((body.providerId !== null && typeof body.providerId !== 'string') || (body.modelId !== null && typeof body.modelId !== 'string')) throw httpError('providerId and modelId must be strings, or both null to clear the default', 400);
        sendJson(response, 200, await harness.activateModel(body.providerId, body.modelId, providerScope(url)));
      } else if (route.length === 3 && route[1] === 'providers' && method === 'PATCH') {
        sendJson(response, 200, await harness.updateProvider(route[2], await readJson(request), providerScope(url)));
      } else if (route.length === 3 && route[1] === 'providers' && method === 'DELETE') {
        sendJson(response, 200, await harness.deleteProvider(route[2], providerScope(url)));
      } else if (route.length === 4 && route[1] === 'providers' && route[3] === 'models' && method === 'POST') {
        const body = await readJson(request);
        sendJson(response, 201, await harness.addProviderModels(route[2], body, providerScope(url)));
      } else if (route.length === 5 && route[1] === 'providers' && route[3] === 'models' && method === 'PATCH') {
        sendJson(response, 200, await harness.updateModel(route[2], route[4], await readJson(request), providerScope(url)));
      } else if (route.length === 5 && route[1] === 'providers' && route[3] === 'models' && method === 'DELETE') {
        sendJson(response, 200, await harness.deleteModel(route[2], route[4], providerScope(url)));
      } else if (route.length === 4 && route[1] === 'providers' && route[3] === 'test' && method === 'POST') {
        sendJson(response, 200, await harness.testProviderConnection(route[2], await readJson(request), providerScope(url)));
      } else if (route.length === 4 && route[1] === 'providers' && route[3] === 'discover' && method === 'POST') {
        await readJson(request);
        const controller = new AbortController();
        const disconnect = () => { if (!response.writableEnded) controller.abort(new DOMException('模型发现请求已断开', 'AbortError')); };
        response.once('close', disconnect);
        try { sendJson(response, 200, await harness.discoverProviderModels(route[2], { signal: controller.signal }, providerScope(url))); }
        finally { response.off('close', disconnect); }
      } else if (route.length === 2 && route[1] === 'tools' && method === 'GET') {
        sendJson(response, 200, harness.getTools());
      } else if (route.length === 2 && route[1] === 'tool-policies' && method === 'GET') {
        sendJson(response, 200, harness.getToolPolicies());
      } else if (route.length === 2 && route[1] === 'extensions' && method === 'GET') {
        sendJson(response, 200, harness.extensions || []);
      } else if (route.length === 2 && route[1] === 'skills' && method === 'GET') {
        sendJson(response, 200, await harness.listSkills());
      } else if (route.length === 2 && route[1] === 'skills' && method === 'POST') {
        sendJson(response, 201, await harness.importSkill(await readJson(request, 12 * 1024 * 1024)));
      } else if (route.length === 3 && route[1] === 'skills' && method === 'GET') {
        sendJson(response, 200, await harness.getSkill(route[2]));
      } else if (route.length === 3 && route[1] === 'skills' && method === 'PATCH') {
        sendJson(response, 200, await harness.updateSkill(route[2], await readJson(request)));
      } else if (route.length === 3 && route[1] === 'skills' && method === 'DELETE') {
        sendJson(response, 200, await harness.deleteSkill(route[2]));
      } else if (route.length === 2 && route[1] === 'mcp' && method === 'GET') {
        sendJson(response, 200, harness.getMcp());
      } else if (route.length === 2 && route[1] === 'mcp' && method === 'POST') {
        const body = await readJson(request);
        sendJson(response, 201, await harness.saveMcp(body.name, body.configuration, true));
      } else if (route.length === 3 && route[1] === 'mcp' && route[2] === 'import' && method === 'POST') {
        sendJson(response, 201, await harness.importMcp(await readJson(request)));
      } else if (route.length === 3 && route[1] === 'mcp' && route[2] === 'reload' && method === 'POST') {
        sendJson(response, 200, await harness.reloadMcp());
      } else if (route.length === 3 && route[1] === 'mcp' && method === 'PATCH') {
        sendJson(response, 200, await harness.saveMcp(route[2], await readJson(request)));
      } else if (route.length === 3 && route[1] === 'mcp' && method === 'DELETE') {
        sendJson(response, 200, await harness.deleteMcp(route[2]));
      } else if (route.length === 4 && route[1] === 'mcp' && route[3] === 'reconnect' && method === 'POST') {
        sendJson(response, 200, await harness.reconnectMcp(route[2]));
      } else if (route.length === 2 && route[1] === 'sessions' && method === 'GET') {
        sendJson(response, 200, harness.listSessions());
      } else if (route.length === 2 && route[1] === 'sessions' && method === 'POST') {
        const body = await readJson(request);
        if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 200)) throw httpError('Title must be a string up to 200 characters', 400);
        sendJson(response, 201, await harness.createSession({ title: body.title }));
      } else if (route.length === 3 && route[1] === 'sessions' && method === 'GET') {
        sendJson(response, 200, harness.getSession(route[2]));
      } else if (route.length === 3 && route[1] === 'sessions' && method === 'DELETE') {
        await harness.deleteSession(route[2]);
        sendJson(response, 200, { ok: true });
      } else if (route.length === 4 && route[1] === 'sessions' && route[3] === 'fork' && method === 'POST') {
        sendJson(response, 201, await harness.forkSession(route[2], await readJson(request)));
      } else if (route.length === 4 && route[1] === 'sessions' && route[3] === 'run' && method === 'POST') {
        const body = await readJson(request);
        if (typeof body.prompt !== 'string' || body.prompt.length > 100000 || !body.prompt.trim() && !body.attachments?.length) throw httpError('Prompt must contain text or attachments, up to 100000 characters', 400);
        sendJson(response, 202, await harness.run(route[2], body.prompt, { attachments: body.attachments ?? [] }));
      } else if (route.length === 4 && route[1] === 'sessions' && route[3] === 'cancel' && method === 'POST') {
        await harness.cancelRun(route[2]);
        sendJson(response, 200, { ok: true });
      } else if (route.length === 3 && route[1] === 'approvals' && method === 'POST') {
        const body = await readJson(request);
        if (typeof body.approved !== 'boolean') throw httpError('approved must be a boolean', 400);
        await harness.resolveApproval(route[2], body.approved);
        sendJson(response, 200, { ok: true });
      } else if (route.length === 2 && route[1] === 'questions' && method === 'GET') {
        sendJson(response, 200, harness.getQuestions());
      } else if (route.length === 3 && route[1] === 'questions' && method === 'POST') {
        const body = await readJson(request);
        sendJson(response, 200, await harness.answerQuestion(route[2], body));
      } else if (route.length === 6 && route[1] === 'sessions' && route[3] === 'checkpoints' && route[5] === 'restore' && method === 'POST') {
        await harness.restoreCheckpoint(route[2], route[4]);
        sendJson(response, 200, { ok: true });
      } else if (route.length === 2 && route[1] === 'files' && method === 'GET') {
        sendJson(response, 200, await harness.listFiles(url.searchParams.get('path') || '.'));
      } else if (route.length === 2 && route[1] === 'file' && method === 'GET') {
        sendJson(response, 200, await harness.readFile(url.searchParams.get('path') || ''));
      } else if (route.length === 2 && route[1] === 'events' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId) harness.getSession(sessionId);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write('retry: 1500\n\n');
        const client = { response, sessionId };
        clients.add(client);
        const lastId = request.headers['last-event-id'] || url.searchParams.get('lastEventId');
        if (lastId) {
          const sessions = sessionId ? [harness.getSession(sessionId)] : harness.listSessions().map(session => harness.getSession(session.id));
          const history = sessions.flatMap(session => session.events || []).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
          const index = history.findIndex(event => event.id === lastId);
          if (index >= 0) history.slice(index + 1).forEach(event => sendEvent(client, event));
        }
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
        heartbeat.unref();
        response.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
      } else {
        throw httpError('Endpoint not found', 404);
      }
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const message = error.message || 'Request failed';
      const statusCode = error.statusCode || (/not found|unknown session|unknown checkpoint|unknown approval/i.test(message) ? 404 : /already running|active run|changed since|conflict/i.test(message) ? 409 : 400);
      sendJson(response, statusCode, { error: message });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;

  function sendEvent(client, event) {
    if (client.sessionId && event.sessionId && event.sessionId !== client.sessionId) return;
    if (client.response.writableLength > 1024 * 1024) { client.response.destroy(); return; }
    client.response.write(`id: ${event.id}\nevent: harness\ndata: ${JSON.stringify(event)}\n\n`);
  }
  const onEvent = event => { for (const client of clients) sendEvent(client, event); };
  harness.on('event', onEvent);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) {
    harness.off('event', onEvent);
    throw error;
  }
  address = server.address();
  harness.protectAutomationPort?.(address.port);
  const url = `http://${host.includes(':') ? `[${host.replace(/[\[\]]/g, '')}]` : host}:${address.port}`;
  if (open) openBrowser(url);
  return {
    server,
    url,
    async close() {
      if (closing) return;
      closing = true;
      harness.off('event', onEvent);
      for (const client of clients) client.response.end();
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

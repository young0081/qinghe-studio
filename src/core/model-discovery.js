import { apiKeyFor } from './settings.js';

async function readBody(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('模型列表响应为空');
  const chunks = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > maximum) throw new Error('模型列表响应超过大小限制');
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('模型列表响应超过大小限制');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function discoverModels(settings, signal, sanitize = value => value) {
  const key = apiKeyFor(settings);
  if (!key) throw Object.assign(new Error('请配置 API Key 后再发现模型'), { statusCode: 400 });
  const base = settings.baseUrl || (settings.provider === 'systemone' ? 'https://api.typesafe.ai/v1' : settings.provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
  const endpoint = new URL(`${base.replace(/\/+$/, '')}/models`);
  const headers = settings.provider === 'anthropic' ? { accept: 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { accept: 'application/json', authorization: `Bearer ${key}` };
  const combined = AbortSignal.any([signal, AbortSignal.timeout(Math.min(settings.providerTimeoutMs, 15000))]);
  const models = new Map();
  const cursors = new Set();
  let bytesRemaining = 1024 * 1024;
  let truncated = false;
  for (let page = 0; page < 10; page++) {
    combined.throwIfAborted();
    if (settings.provider === 'anthropic') endpoint.searchParams.set('limit', '100');
    const response = await fetch(endpoint, { headers, signal: combined, redirect: 'error' });
    const body = await readBody(response, bytesRemaining);
    bytesRemaining -= Buffer.byteLength(body);
    if (!response.ok) throw new Error(`模型列表 API HTTP ${response.status}: ${sanitize(body).slice(0, 1500)}`);
    let payload;
    try { payload = JSON.parse(body); } catch { throw new Error('模型列表返回了无效 JSON'); }
    const entries = settings.provider === 'systemone' && Array.isArray(payload?.models) ? payload.models.map(item => ({ id: item.name, display_name: item.name })) : payload?.data;
    if (!Array.isArray(entries)) throw new Error('模型列表响应缺少 data / models 数组');
    for (const item of entries) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 512 || /[\u0000-\u001f\u007f]/.test(item.id)) continue;
      const id = item.id.trim();
      const name = typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim() : id;
      const sanitized = sanitize({ id, name });
      if (sanitized.id !== id) continue;
      if (models.size >= 1000 && !models.has(id)) { truncated = true; break; }
      models.set(id, { id, name: sanitized.name.slice(0, 512) });
    }
    if (truncated || !payload.has_more) break;
    if (settings.provider !== 'anthropic' || page === 9 || models.size >= 1000 || typeof payload.last_id !== 'string' || !payload.last_id || payload.last_id.length > 512 || cursors.has(payload.last_id)) { truncated = true; break; }
    cursors.add(payload.last_id);
    endpoint.searchParams.set('after_id', payload.last_id);
  }
  combined.throwIfAborted();
  return { models: [...models.values()], truncated };
}

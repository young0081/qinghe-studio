import { apiKeyFor } from './settings.js';

export async function systemOne(settings, { state, questions, signal }) {
  if (!questions || !Object.keys(questions).length) throw new Error('System One 仅用于类型化决策，不能作为聊天或压缩模型');
  const combined = AbortSignal.any([signal, AbortSignal.timeout(Math.min(settings.providerTimeoutMs, 20000))]);
  const response = await fetch(`${settings.baseUrl || 'https://api.typesafe.ai/v1'}/systemone`, {
    method: 'POST', redirect: 'error', signal: combined,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKeyFor(settings)}` },
    body: JSON.stringify({ model: settings.model, state, questions }),
  });
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('System One 响应为空');
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('System One 响应超过大小限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!response.ok) throw new Error(`System One HTTP ${response.status}: ${text.slice(0, 1000)}`);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('System One 返回了无效 JSON'); }
  const usage = { inputTokens: payload.usage?.input_tokens || 0, outputTokens: payload.usage?.output_tokens || 0 };
  return { answers: payload.answers, usage, content: '', toolCalls: [], finishReason: 'stop' };
}

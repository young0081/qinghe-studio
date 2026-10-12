import path from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { reasoningIssue, validateReasoning } from './reasoning.js';
import { defaultOrchestration, validateOrchestration } from './orchestration-config.js';

export const defaults = {
  provider: 'responses', baseUrl: '', model: '', apiKey: '', approval: 'ask', autoApproveTools: [],
  maxTokens: 4096, temperature: 0.2, systemPrompt: '', commandTimeoutMs: 30000,
  providerTimeoutMs: 120000, maxContextTokens: 32000, contextCompactionThreshold: 0.8, reasoning: { mode: 'default' },
  modelOrchestration: defaultOrchestration,
};

export function validateSettings(value) {
  const { maxSteps, maxRunTokens, ...current } = value;
  const settings = { ...defaults, ...current };
  for (const key of Object.keys(settings)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`未知设置: ${key}`);
  }
  if (!['openai', 'responses', 'anthropic', 'systemone'].includes(settings.provider)) throw new Error('不支持的模型提供商，请选择 responses、openai、anthropic 或 systemone');
  settings.modelOrchestration = validateOrchestration(settings.modelOrchestration);
  if (!['ask', 'auto', 'readonly'].includes(settings.approval)) throw new Error('approval 必须为 ask、auto 或 readonly');
  if (!Array.isArray(settings.autoApproveTools) || settings.autoApproveTools.length > 256 || settings.autoApproveTools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name))) throw new Error('autoApproveTools 必须是最多 256 个精确工具名的数组，不支持通配符');
  settings.autoApproveTools = [...new Set(settings.autoApproveTools)].sort();
  for (const key of ['baseUrl', 'model', 'apiKey', 'systemPrompt']) {
    if (typeof settings[key] !== 'string') throw new Error(`${key} 必须是字符串`);
  }
  settings.model = settings.model.trim();
  settings.reasoning = validateReasoning(settings.reasoning);
  const ranges = { maxTokens: [1, 131072], commandTimeoutMs: [100, 600000], providerTimeoutMs: [100, 600000], maxContextTokens: [1024, 2000000] };
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    if (!Number.isInteger(settings[key]) || settings[key] < minimum || settings[key] > maximum) throw new Error(`${key} 必须是 ${minimum}–${maximum} 的整数`);
  }
  if (!Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2) throw new Error('temperature 必须在 0–2 之间');
  if (!Number.isFinite(settings.contextCompactionThreshold) || settings.contextCompactionThreshold < 0.5 || settings.contextCompactionThreshold > 0.95) throw new Error('contextCompactionThreshold 必须在 0.5–0.95 之间');
  if (settings.baseUrl) {
    let url;
    try { url = new URL(settings.baseUrl); } catch { throw new Error('baseUrl 不是有效 URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('baseUrl 必须是没有凭据、查询参数或片段的 HTTP(S) URL');
    settings.baseUrl = settings.baseUrl.replace(/\/+$/, '');
  }
  return settings;
}

export function apiKeyFor(settings) {
  return [settings.apiKey, ...(settings.provider === 'systemone' ? [process.env.TYPESAFE_API_KEY] : [process.env.HARNESS_API_KEY, settings.provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY])].find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

export function configurationIssues(settings) {
  const issues = [];
  const thinkingIssue = reasoningIssue(settings);
  if (thinkingIssue) issues.push(thinkingIssue);
  if (!settings.model.trim()) issues.push('请填写所选提供商可用的模型 ID（model）');
  if (!apiKeyFor(settings)) issues.push(settings.provider === 'systemone' ? '请配置 API Key，或设置 TYPESAFE_API_KEY 环境变量' : `请配置 API Key，或设置 HARNESS_API_KEY / ${settings.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} 环境变量`);
  return issues;
}

export function assertConfigured(settings) {
  const issues = configurationIssues(settings);
  if (issues.length) throw Object.assign(new Error(`尚未完成模型配置：${issues.join('；')}。可在设置界面或使用 harness config set 完成配置。`), { statusCode: 400 });
}

export function publicSettings(settings) {
  const { apiKey, ...publicValue } = settings;
  const issues = configurationIssues(settings);
  return { ...publicValue, hasApiKey: Boolean(apiKeyFor(settings)), configured: issues.length === 0, configurationIssues: issues };
}

export function redact(value, secrets = []) {
  const replacements = secrets.filter(secret => typeof secret === 'string' && secret.length > 3);
  const identityFields = new Set(['id', 'model', 'modelId', 'providerId', 'activeProviderId', 'activeModelId', 'sessionId', 'runId', 'toolCallId']);
  const clean = (input, field = '') => {
    if (typeof input === 'string') {
      if (['provider', 'protocol'].includes(field) && ['responses', 'openai', 'anthropic', 'systemone'].includes(input)) return input;
      if (['scope', 'providerScope', 'activeScope'].includes(field) && ['workspace', 'global'].includes(input)) return input;
      let output = input;
      for (const secret of replacements) {
        if (identityFields.has(field) && secret.length < 12 && input !== secret) continue;
        output = output.split(secret).join('[REDACTED]');
      }
      return output.replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]');
    }
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, /^(api[-_]?key|authorization|access[-_]?token|secret)$/i.test(key) ? '[REDACTED]' : clean(item, key)]));
    return input;
  };
  return clean(value);
}

export function redactedStream(emit, secrets) {
  const values = secrets.filter(secret => typeof secret === 'string' && secret.length > 3);
  const holdback = Math.max(3, ...values.map(secret => secret.length - 1));
  let pending = '';
  return {
    push(text) {
      pending += text;
      let boundary = Math.max(0, pending.length - holdback);
      for (const secret of values) {
        let index = pending.indexOf(secret);
        while (index >= 0) {
          if (index < boundary && index + secret.length > boundary) boundary = index;
          index = pending.indexOf(secret, index + secret.length);
        }
      }
      for (const match of pending.matchAll(/\bsk-[A-Za-z0-9_-]*/g)) {
        if (match.index < boundary && match.index + match[0].length >= boundary) boundary = match.index;
      }
      if (boundary > 0) { emit(redact(pending.slice(0, boundary), values)); pending = pending.slice(boundary); }
    },
    flush() { if (pending) emit(redact(pending, values)); pending = ''; },
  };
}

export async function atomicText(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function atomicJson(file, value) { return atomicText(file, `${JSON.stringify(value, null, 2)}\n`); }

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`无法读取配置或会话文件 ${path.basename(file)}: ${error.message}`);
  }
}

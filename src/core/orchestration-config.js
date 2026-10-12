export const defaultOrchestration = {
  compressionModel: null,
  decision: { enabled: false, model: null, minConfidence: 0.65 },
  routing: { enabled: false, candidates: [] },
};

export const selectionKey = value => value ? JSON.stringify([value.scope, value.providerId, value.modelId]) : '';

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('模型协作配置格式无效或包含未知字段');
}

function reference(value, candidate = false) {
  fields(value, ['scope', 'providerId', 'modelId', ...(candidate ? ['specialty'] : [])]);
  if (!['workspace', 'global'].includes(value.scope)) throw new Error('模型引用必须指定 workspace 或 global');
  for (const key of ['providerId', 'modelId']) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 512 || /[\u0000-\u001f\u007f]/.test(value[key])) throw new Error('模型引用必须包含有效供应商与模型 ID');
  if (candidate && (typeof value.specialty !== 'string' || value.specialty.length > 500)) throw new Error('模型擅长领域必须是不超过 500 字符的文本');
  return { scope: value.scope, providerId: value.providerId, modelId: value.modelId, ...(candidate ? { specialty: value.specialty } : {}) };
}

export function validateOrchestration(value = defaultOrchestration) {
  fields(value, ['compressionModel', 'decision', 'routing']);
  const decision = { ...defaultOrchestration.decision, ...value.decision };
  const routing = { ...defaultOrchestration.routing, ...value.routing };
  if (value.decision !== undefined) fields(value.decision, ['enabled', 'model', 'minConfidence']);
  if (value.routing !== undefined) fields(value.routing, ['enabled', 'candidates']);
  if (typeof decision.enabled !== 'boolean' || typeof routing.enabled !== 'boolean') throw new Error('模型协作开关必须是布尔值');
  if (!Number.isFinite(decision.minConfidence) || decision.minConfidence < 0 || decision.minConfidence > 1) throw new Error('决策置信度阈值必须在 0–1 之间');
  if (!Array.isArray(routing.candidates) || routing.candidates.length > 32) throw new Error('路由候选模型最多 32 个');
  const candidates = routing.candidates.map(item => reference(item, true));
  if (new Set(candidates.map(selectionKey)).size !== candidates.length) throw new Error('路由候选模型不能重复');
  if ((decision.enabled || routing.enabled) && !decision.model) throw new Error('启用决策辅助或智能路由前，请选择决策模型');
  if (routing.enabled && !candidates.length) throw new Error('请至少选择一个路由候选模型');
  return { compressionModel: value.compressionModel == null ? null : reference(value.compressionModel), decision: { ...decision, model: decision.model == null ? null : reference(decision.model) }, routing: { ...routing, candidates } };
}

export function orchestrationReferences(value) {
  return [value.compressionModel, ...(value.decision.enabled || value.routing.enabled ? [value.decision.model] : []), ...(value.routing.enabled ? value.routing.candidates : [])].filter(Boolean);
}

export const openaiEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const anthropicEfforts = ['default', 'low', 'medium', 'high', 'max'];
export const effortLabels = { default: '模型默认', none: '关闭推理', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };

export function validateReasoning(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reasoning 必须是思考参数对象');
  const allowed = { default: ['mode'], effort: ['mode', 'effort'], disabled: ['mode'], adaptive: ['mode', 'effort'], budget: ['mode', 'budgetTokens'] };
  if (typeof value.mode !== 'string' || !Object.hasOwn(allowed, value.mode) || Object.keys(value).some(key => !allowed[value.mode].includes(key))) throw new Error('思考模式或参数无效');
  if (value.mode === 'effort' && !openaiEfforts.includes(value.effort)) throw new Error('OpenAI 思考强度必须是 none、minimal、low、medium、high、xhigh 或 max');
  if (value.mode === 'adaptive' && !anthropicEfforts.includes(value.effort ?? 'default')) throw new Error('自适应思考强度必须是 default、low、medium、high 或 max');
  if (value.mode === 'budget' && (!Number.isInteger(value.budgetTokens) || value.budgetTokens < 1024 || value.budgetTokens > 131071)) throw new Error('思考预算必须是 1024–131071 的整数');
  return { ...value, ...(value.mode === 'adaptive' ? { effort: value.effort ?? 'default' } : {}) };
}

export function reasoningIssue(settings) {
  const reasoning = settings.reasoning ?? { mode: 'default' };
  const modes = settings.provider === 'systemone' ? ['default'] : settings.provider === 'anthropic' ? ['default', 'disabled', 'adaptive', 'budget'] : ['default', 'effort'];
  if (!modes.includes(reasoning.mode)) return '思考模式与当前 API 协议不兼容，请重新选择思考模式';
  if (reasoning.mode === 'budget' && reasoning.budgetTokens >= settings.maxTokens) return '思考预算必须小于响应 Token 上限；请提高响应上限或降低思考预算';
  return '';
}

export function reasoningParameters(settings) {
  const reasoning = validateReasoning(settings.reasoning ?? { mode: 'default' });
  const issue = reasoningIssue({ ...settings, reasoning });
  if (issue) throw Object.assign(new Error(issue), { statusCode: 400 });
  if (reasoning.mode === 'effort') return settings.provider === 'responses' ? { reasoning: { effort: reasoning.effort } } : { reasoning_effort: reasoning.effort };
  if (reasoning.mode === 'budget') return { thinking: { type: 'enabled', budget_tokens: reasoning.budgetTokens } };
  if (reasoning.mode === 'adaptive') return { thinking: { type: 'adaptive' }, ...(reasoning.effort === 'default' ? {} : { output_config: { effort: reasoning.effort } }) };
  if (reasoning.mode === 'disabled') return { thinking: { type: 'disabled' } };
  return {};
}

export function reasoningLabel(value) {
  if (!value || value.mode === 'default') return '模型默认';
  if (value.mode === 'disabled') return '关闭思考';
  if (value.mode === 'budget') return `预算 ${value.budgetTokens} tokens`;
  return `${value.mode === 'adaptive' ? '自适应 · ' : ''}${effortLabels[value.effort] || value.effort}`;
}

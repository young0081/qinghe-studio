import React from 'react';
import { selectionKey } from '../src/core/orchestration-config.js';
import './model-orchestration.css';

export default function ModelOrchestration({ value, scopes, onChange }) {
  const models = ['global', 'workspace'].flatMap(scope => (scopes?.[scope]?.providers || []).flatMap(provider => provider.models.map(model => ({ scope, providerId: provider.id, modelId: model.id, protocol: provider.protocol, available: provider.enabled && model.enabled && provider.hasApiKey, label: `${scope === 'global' ? '全局' : '工作区'} · ${provider.name} / ${model.name || model.id}` }))));
  const set = patch => onChange({ ...value, ...patch });
  const reference = model => model ? { scope: model.scope, providerId: model.providerId, modelId: model.modelId } : null;
  const picker = (label, selected, onSelect, decision = false) => {
    const options = models.filter(model => decision || model.protocol !== 'systemone');
    const missing = selected && !options.some(model => selectionKey(model) === selectionKey(selected));
    return <label>{label}<select aria-label={label} value={selectionKey(selected)} onChange={event => onSelect(reference(options.find(model => selectionKey(model) === event.target.value)))}><option value="">{decision ? '请选择决策模型' : '跟随当前执行模型'}</option>{missing && <option value={selectionKey(selected)}>已失效：{selected.modelId}（请重新选择）</option>}{options.map(model => <option key={selectionKey(model)} value={selectionKey(model)} disabled={!model.available}>{model.label}{!model.available ? ' · 不可用' : ''}</option>)}</select></label>;
  };
  return <section className="model-orchestration" aria-label="模型协作">
    <div className="management-card-title"><span className="section-number">02</span><div><h2>模型协作</h2><p>从全局或当前工作区选择模型。配置保存在当前工作区，下一次任务生效；会话与进度保持连续。</p></div></div>
    <div className="orchestration-block">
      <h3>上下文压缩</h3>
      <p>可用较低成本的文本模型生成交接摘要。原始消息保留，按压缩模型自身窗口分段处理。</p>
      {picker('上下文压缩模型', value.compressionModel, compressionModel => set({ compressionModel }))}
    </div>
    <div className="orchestration-block">
      <h3>决策辅助</h3>
      <label className="checkbox-field"><input type="checkbox" aria-label="启用决策辅助" checked={value.decision.enabled} onChange={event => set({ decision: { ...value.decision, enabled: event.target.checked } })} /><span>启用决策辅助 · 判断下一步方向与建议工具</span></label>
      {picker('决策模型', value.decision.model, model => set({ decision: { ...value.decision, model } }), true)}
      <label>最低决策置信度<input type="number" aria-label="最低决策置信度" min="0" max="1" step="0.05" required value={value.decision.minConfidence} onChange={event => set({ decision: { ...value.decision, minConfidence: event.target.value === '' ? '' : Number(event.target.value) } })} /></label>
      <p>支持原生 System One / Jev 与能返回结构化 JSON 的聊天模型。Jev 负责选择，执行模型负责生成参数、代码和答复。超时、无效答案或低置信度时保留当前模型和执行方式。</p>
    </div>
    <div className="orchestration-block">
      <h3>智能模型路由</h3>
      <label className="checkbox-field"><input type="checkbox" aria-label="启用智能模型路由" checked={value.routing.enabled} onChange={event => set({ routing: { ...value.routing, enabled: event.target.checked } })} /><span>启用智能模型路由 · 随任务进展重新选模型</span></label>
      <p>使用上方决策模型，在开始、每轮执行后及最终总结前重新选择。可单独开启路由。勾选允许使用的模型，并填写擅长领域与成本偏好。</p>
      <div className="routing-candidates" aria-label="路由候选模型">{models.filter(model => model.protocol !== 'systemone').map(model => {
        const selected = value.routing.candidates.find(item => selectionKey(item) === selectionKey(model));
        return <div className="routing-candidate" key={selectionKey(model)}><label className="checkbox-field"><input type="checkbox" aria-label={`路由候选 ${model.label}`} checked={!!selected} disabled={!selected && (!model.available || value.routing.candidates.length >= 32)} onChange={event => set({ routing: { ...value.routing, candidates: event.target.checked ? [...value.routing.candidates, { ...reference(model), specialty: '' }] : value.routing.candidates.filter(item => selectionKey(item) !== selectionKey(model)) } })} /><span>{model.label}{!model.available && <small>不可用，请检查供应商与密钥</small>}</span></label>{selected && <label>擅长领域与成本偏好<input aria-label={`模型专长 ${model.label}`} maxLength="500" value={selected.specialty} placeholder="例如：代码修改与测试；日常任务优先使用，成本较低" onChange={event => set({ routing: { ...value.routing, candidates: value.routing.candidates.map(item => selectionKey(item) === selectionKey(model) ? { ...item, specialty: event.target.value } : item) } })} /></label>}</div>;
      })}{value.routing.candidates.filter(item => !models.some(model => selectionKey(item) === selectionKey(model))).map(item => <div className="routing-candidate" key={selectionKey(item)}><span>已失效：{item.modelId}</span><button type="button" className="text-button" onClick={() => set({ routing: { ...value.routing, candidates: value.routing.candidates.filter(candidate => selectionKey(candidate) !== selectionKey(item)) } })}>移除失效候选</button></div>)}{!models.length && <p>先在「供应商与模型」中添加模型。</p>}</div>
    </div>
    <p className="management-hint">辅助调用会产生用量，任务摘要与最近执行记录会发送给所选供应商。模型切换及分用途 Token 用量可在活动与运行详情中查看；系统不预设或承诺节省比例。审批策略始终有效。</p>
  </section>;
}

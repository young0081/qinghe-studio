import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { anthropicEfforts, effortLabels, openaiEfforts, reasoningIssue, reasoningLabel } from '../src/core/reasoning.js';
import { PixelActivity } from './motion.jsx';
import './reasoning.css';

export function ReasoningFields({ protocol, value = { mode: 'default' }, onChange, maxTokens = 4096, prefix = '' }) {
  const anthropic = protocol === 'anthropic';
  const issue = reasoningIssue({ provider: protocol, reasoning: value, maxTokens });
  const modes = anthropic ? ['default', 'disabled', 'adaptive', 'budget'] : ['default', 'effort'];
  return <div className="reasoning-fields">
    {anthropic ? <label>思考模式<select aria-label={`${prefix}思考模式`} value={value.mode} onChange={event => { const mode = event.target.value; onChange({ mode, ...(mode === 'adaptive' ? { effort: 'default' } : mode === 'budget' ? { budgetTokens: 1024 } : {}) }); }}>
      {!modes.includes(value.mode) && <option value={value.mode}>与当前接口不兼容</option>}<option value="default">模型默认 · 不发送参数</option><option value="disabled">关闭思考</option><option value="adaptive">自适应思考</option><option value="budget">指定思考预算</option>
    </select></label> : <label>思考强度<select aria-label={`${prefix}思考强度`} value={value.mode === 'effort' ? value.effort : value.mode} onChange={event => onChange(event.target.value === 'default' ? { mode: 'default' } : { mode: 'effort', effort: event.target.value })}>
      {!modes.includes(value.mode) && <option value={value.mode}>与当前接口不兼容</option>}<option value="default">模型默认 · 不发送参数</option>{openaiEfforts.map(effort => <option key={effort} value={effort}>{effortLabels[effort]} · {effort}</option>)}
    </select></label>}
    {anthropic && value.mode === 'adaptive' && <label>思考强度<select aria-label={`${prefix}自适应思考强度`} value={value.effort || 'default'} onChange={event => onChange({ ...value, effort: event.target.value })}>{anthropicEfforts.map(effort => <option key={effort} value={effort}>{effortLabels[effort]}{effort !== 'default' && ` · ${effort}`}</option>)}</select></label>}
    {anthropic && value.mode === 'budget' && <label>思考 Token 预算<input aria-label={`${prefix}思考 Token 预算`} type="number" min="1024" max="131071" step="1" required value={value.budgetTokens ?? ''} onChange={event => onChange({ ...value, budgetTokens: event.target.value === '' ? '' : Number(event.target.value) })} /></label>}
    <p className="reasoning-help">仅为支持对应参数的模型选择。模型列表不提供可靠的思考能力信息，请以供应商文档为准；不确定时保留模型默认。{anthropic ? ' 自适应和预算模式不是同一功能，需模型分别支持。' : ' 更高档位可能增加延迟与费用，并非所有模型都支持全部档位。'}</p>
    {['effort', 'adaptive', 'budget'].includes(value.mode) && <p className="reasoning-help">启用后不发送 Temperature，避免与推理参数冲突。</p>}
    {issue && <p className="reasoning-issue" role="status">{issue}</p>}
  </div>;
}

export default function ReasoningPicker({ settings, api, onChanged, onBusyChange, disabled, isRunning, versionMismatch, visible, detailTarget }) {
  const current = settings?.reasoning || { mode: 'default' };
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  const [pendingSync, setPendingSync] = useState(false);
  const [error, setError] = useState('');
  const [failedDraft, setFailedDraft] = useState(null);
  const draftRef = useRef(current);
  const settingsRef = useRef(settings);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const pointerRef = useRef(false);
  const keyboardRef = useRef(false);
  const alive = useRef(true);
  settingsRef.current = settings;
  const activeKey = `${settings?.activeProviderId}/${settings?.activeModelId}`;
  const reasoningKey = JSON.stringify(current);
  const locked = disabled || busy || pendingSync || versionMismatch || !settings?.activeModelId;
  const anthropic = settings?.provider === 'anthropic';
  const budget = anthropic && draft.mode === 'budget';
  const choices = anthropic
    ? [{ mode: 'default' }, { mode: 'disabled' }, ...anthropicEfforts.map(effort => ({ mode: 'adaptive', effort }))]
    : [{ mode: 'default' }, ...openaiEfforts.map(effort => ({ mode: 'effort', effort }))];
  const index = Math.max(0, choices.findIndex(choice => JSON.stringify(choice) === JSON.stringify(draft)));
  const maximum = budget ? Math.max(1024, Math.min(131071, (settings?.maxTokens || 4096) - 1)) : choices.length - 1;
  const minimum = budget ? 1024 : 0;
  const value = budget ? draft.budgetTokens : index;
  const label = reasoningLabel(draft);
  const help = `${isRunning ? '当前任务保持原思考参数；调整用于下次运行。' : '松手或完成键盘调整后自动保存到当前模型。'} 仅为支持对应参数的模型选择，更高档位可能增加延迟与费用。${versionMismatch ? ' 后台版本未更新，请重启 Web 服务后刷新。' : ''}`;
  const resetDraft = next => { draftRef.current = next; setDraft(next); dirtyRef.current = false; };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; onBusyChange(false); };
  }, [onBusyChange]);
  useEffect(() => {
    pointerRef.current = false;
    keyboardRef.current = false;
    if (!busyRef.current && !pendingSync) {
      resetDraft(settingsRef.current?.reasoning || { mode: 'default' });
      setError('');
      setFailedDraft(null);
      onBusyChange(false);
    }
  }, [activeKey, visible]);
  useEffect(() => {
    if (!dirtyRef.current && !busyRef.current && !pendingSync) resetDraft(settingsRef.current?.reasoning || { mode: 'default' });
  }, [reasoningKey, activeKey, busy, pendingSync]);
  const save = async (next = draftRef.current) => {
    if (busyRef.current || disabled || versionMismatch || !settingsRef.current?.activeModelId || !pendingSync && !dirtyRef.current && !failedDraft) return;
    const target = settingsRef.current;
    const issue = reasoningIssue({ ...target, reasoning: next });
    if (!pendingSync && issue) {
      resetDraft(target.reasoning || { mode: 'default' });
      setError(issue);
      onBusyChange(false);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    let committed = pendingSync;
    try {
      if (!pendingSync) {
        await api(`/providers/${encodeURIComponent(target.activeProviderId)}/models/${encodeURIComponent(target.activeModelId)}`, { method: 'PATCH', body: { reasoning: next } });
        committed = true;
      }
      const updated = await onChanged();
      if (!alive.current) return;
      resetDraft(updated?.reasoning || settingsRef.current?.reasoning || { mode: 'default' });
      setPendingSync(false);
      setFailedDraft(null);
      onBusyChange(false);
    } catch (failure) {
      if (!alive.current) return;
      setPendingSync(committed);
      setFailedDraft(committed ? null : next);
      setError(committed ? `思考设置已保存，但状态同步失败。请重试同步后再发送：${failure.message}` : `无法保存思考设置，已恢复原档位：${failure.message}`);
      if (!committed) { resetDraft(settingsRef.current?.reasoning || { mode: 'default' }); onBusyChange(false); }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const preview = next => {
    draftRef.current = next;
    setDraft(next);
    setError('');
    setFailedDraft(null);
    dirtyRef.current = JSON.stringify(next) !== JSON.stringify(settingsRef.current?.reasoning || { mode: 'default' });
    onBusyChange(dirtyRef.current);
    if (!pointerRef.current && !keyboardRef.current) save(next);
  };
  const cancelDrag = () => {
    pointerRef.current = false;
    keyboardRef.current = false;
    if (!busyRef.current && !pendingSync) { resetDraft(settingsRef.current?.reasoning || { mode: 'default' }); onBusyChange(false); }
  };
  const shortLabel = budget ? draft.budgetTokens >= 10000 ? `${(draft.budgetTokens / 1000).toFixed(1)}k` : String(draft.budgetTokens) : draft.mode === 'default' ? '默认' : draft.mode === 'disabled' || draft.effort === 'none' ? '关闭' : draft.mode === 'adaptive' && draft.effort === 'default' ? '自动' : effortLabels[draft.effort];
  return <div className="workspace-reasoning" role="group" aria-label="思考设置" aria-busy={busy} title={`${label} · ${help}`}>
    {anthropic ? <select className="reasoning-mode" aria-label="思考调节方式" value={budget ? 'budget' : 'effort'} disabled={locked} onChange={event => preview(event.target.value === 'budget' ? { mode: 'budget', budgetTokens: 1024 } : { mode: 'default' })}><option value="effort">思考</option><option value="budget">预算</option></select> : <span className="reasoning-caption">思考</span>}
    <input className="reasoning-slider" type="range" aria-label={budget ? '思考 Token 预算' : '思考强度'} aria-valuetext={label} aria-describedby="reasoning-slider-help" min={minimum} max={maximum} step="1" value={value} disabled={locked} style={{ '--reasoning-progress': `${maximum === minimum ? 0 : (value - minimum) / (maximum - minimum) * 100}%` }} onChange={event => preview(budget ? { mode: 'budget', budgetTokens: Number(event.target.value) } : choices[Number(event.target.value)])}
      onPointerDown={event => { if (!locked) { pointerRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); } }}
      onPointerUp={() => { pointerRef.current = false; save(); }} onPointerCancel={cancelDrag} onLostPointerCapture={() => { if (pointerRef.current) cancelDrag(); }}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) keyboardRef.current = true; if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); save(); } if (event.key === 'Escape') { event.preventDefault(); cancelDrag(); } }}
      onKeyUp={() => { keyboardRef.current = false; save(); }} onBlur={() => { keyboardRef.current = false; if (!pointerRef.current) save(); }} />
    <output className="reasoning-value" aria-label="当前思考强度" title={label}>{busy ? <PixelActivity /> : pendingSync ? '待同步' : shortLabel}</output>
    <span className="sr-only" id="reasoning-slider-help">{help}</span>
    {detailTarget && error && createPortal(<div className="reasoning-feedback" role="alert"><span>{error}</span>{(pendingSync || failedDraft) && <button type="button" className="text-button" disabled={disabled || busy || versionMismatch} onClick={() => save(failedDraft || draftRef.current)}>{pendingSync ? '重试同步思考设置' : '重试保存思考设置'}</button>}</div>, detailTarget)}
  </div>;
}

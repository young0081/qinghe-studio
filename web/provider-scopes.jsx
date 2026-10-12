import React from 'react';
import { PixelActivity } from './motion.jsx';

export const scopeNames = { global: '全局配置', workspace: '工作区配置' };

export default function ProviderScopes({ scopes, editingScope, onEdit, onActivate, busy, switching, pending, error, onRetry }) {
  return <section className="provider-scopes" aria-label="供应商配置来源">
    <div className="provider-scope-heading"><div><span className="eyebrow">TWO PLACES, YOUR CHOICE</span><h2>配置放在哪里，由你决定</h2><p>全局配置在本机各工作区间共用；工作区配置只用于当前项目。</p></div></div>
    <div className="provider-scope-cards">{['global', 'workspace'].map(scope => {
      const catalog = scopes?.[scope];
      const provider = catalog?.providers.find(item => item.id === catalog.active?.providerId);
      const model = provider?.models.find(item => item.id === catalog.active?.modelId);
      const selected = editingScope === scope;
      return <button type="button" key={scope} className={`provider-scope-card ${selected ? 'editing' : ''}`} aria-label={`编辑${scopeNames[scope]}`} aria-pressed={selected} disabled={busy || pending || !catalog} onClick={() => onEdit(scope)}>
        <span className="provider-scope-card-top"><span className={`provider-scope-icon ${scope}`} aria-hidden="true">{scope === 'global' ? '▦' : '▣'}</span><strong>{scope === 'workspace' ? '当前工作区' : '全局配置'}</strong>{scopes?.activeScope === scope && <span className="provider-scope-active">当前使用</span>}</span>
        <span className="provider-scope-description">{scope === 'global' ? '一次配置，在不同项目中继续使用。' : '为这个项目保留独立的供应商和模型。'}</span>
        <span className="provider-scope-default">{provider && model ? `${provider.name} / ${model.name || model.id}` : '尚未选择默认模型'}</span>
        <span className="provider-scope-card-bottom"><span>{catalog?.providers.length ?? 0} 个供应商 · {catalog?.providers.reduce((sum, item) => sum + item.models.length, 0) ?? 0} 个模型</span><span>{selected ? '正在编辑 ↓' : '编辑这套配置 →'}</span></span>
      </button>;
    })}</div>
    <div className="provider-scope-activation"><div><strong>当前工作区使用</strong><p>切换后用于新任务；下方编辑内容会保留。</p></div><div className="provider-scope-switch" role="group" aria-label="当前工作区使用的供应商配置">{['global', 'workspace'].map(scope => <button key={scope} type="button" aria-label={`使用${scopeNames[scope]}`} aria-pressed={scopes?.activeScope === scope} disabled={busy || pending || !scopes} onClick={() => onActivate(scope)}>{scopeNames[scope]}{scopes?.activeScope === scope && <span aria-hidden="true"> ✓</span>}</button>)}</div></div>
    {switching && <p className="provider-scope-progress" role="status"><PixelActivity />正在同步配置来源…</p>}
    {error && <div className="provider-scope-error" role="alert"><span>{error}</span><button type="button" className="text-button" disabled={busy} onClick={onRetry}>{pending ? '重试同步配置来源' : '重试切换配置来源'}</button></div>}
  </section>;
}

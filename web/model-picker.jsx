import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PixelActivity, PixelLoader } from './motion.jsx';
import './model-picker.css';

const protocolNames = { responses: 'OpenAI Responses', openai: 'OpenAI Chat', anthropic: 'Anthropic Messages', systemone: 'System One / Jev' };

function unavailableReason(provider, model) {
  if (provider.protocol === 'systemone') return '仅用于决策';
  if (!provider.enabled) return '供应商已禁用';
  if (!model.enabled) return '模型已禁用';
  if (!provider.hasApiKey) return '未配置密钥';
  return '';
}

export default function ModelPicker({ settings, revision, api, onChanged, onBusyChange, onManage, visible, disabled, isRunning, Icon }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [catalogScope, setCatalogScope] = useState(null);
  const scope = settings?.providerScope || 'workspace';
  const scopeLabel = scope === 'global' ? '全局' : '工作区';
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [pendingSync, setPendingSync] = useState(false);
  const [reload, setReload] = useState(0);
  const [position, setPosition] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const searchRef = useRef(null);
  const alive = useRef(true);
  const selectingRef = useRef(false);
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { if (!visible) close(); }, [visible, close]);
  useEffect(() => {
    if (pendingSync && !selecting && (scope !== catalogScope || settings?.activeProviderId === catalog?.active?.providerId && settings?.activeModelId === catalog?.active?.modelId)) {
      setPendingSync(false);
      setSelectionError('');
      onBusyChange(false);
    }
  }, [pendingSync, selecting, settings, catalog, scope, catalogScope, onBusyChange]);
  useEffect(() => {
    if (!open || !visible || selecting) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    api(`/providers?scope=${scope}`, { signal: controller.signal }).then(next => {
      if (!controller.signal.aborted) { setCatalog(next); setCatalogScope(scope); }
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(error.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, visible, revision, reload, selecting, api, scope]);

  useLayoutEffect(() => {
    if (!open || !visible) return;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportWidth = viewport?.width || window.innerWidth;
      const viewportHeight = viewport?.height || window.innerHeight;
      const width = Math.min(390, viewportWidth - 24);
      const above = anchor.top - viewportTop - 20;
      const below = viewportTop + viewportHeight - anchor.bottom - 20;
      const upwards = above >= below;
      setPosition({ width, left: Math.max(viewportLeft + 12, Math.min(anchor.left, viewportLeft + viewportWidth - width - 12)), maxHeight: Math.max(0, Math.min(440, upwards ? above : below)), ...(upwards ? { bottom: window.innerHeight - anchor.top + 8 } : { top: anchor.bottom + 8 }) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(triggerRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open, visible]);

  useEffect(() => {
    if (!open || !visible) return;
    const focusFrame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    const outside = event => {
      if (!panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close();
    };
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', keyboard);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', keyboard);
    };
  }, [open, visible, close]);

  const switchModel = async (provider, model) => {
    if (selectingRef.current || disabled || provider && catalogScope !== scope) return;
    selectingRef.current = true;
    setSelecting(true);
    setSelectionError('');
    onBusyChange(true);
    let activated = pendingSync;
    try {
      if (provider && model) {
        const next = await api(`/providers/active?scope=${scope}`, { method: 'POST', body: { providerId: provider.id, modelId: model.id } });
        activated = true;
        if (!alive.current) return;
        setCatalog(next);
        setCatalogScope(scope);
      }
      await onChanged();
      if (!alive.current) return;
      setPendingSync(false);
      onBusyChange(false);
      close(true);
    } catch (error) {
      if (!alive.current) return;
      setPendingSync(activated);
      setSelectionError(activated ? `模型已切换，但工作台状态同步失败，请重试同步后再发送任务。${error.message}` : `无法切换模型：${error.message}`);
      if (!activated) onBusyChange(false);
    } finally {
      selectingRef.current = false;
      if (alive.current) setSelecting(false);
    }
  };

  const moveFocus = event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === searchRef.current && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const choices = [...panelRef.current.querySelectorAll('[data-model-choice]:not(:disabled)')];
    if (!choices.length) return;
    event.preventDefault();
    const current = choices.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : event.key === 'ArrowDown' ? (current + 1) % choices.length : (current <= 0 ? choices.length : current) - 1;
    choices[next].focus();
  };
  const query = search.trim().toLowerCase();
  const visibleCatalog = catalogScope === scope ? catalog : null;
  const providers = (visibleCatalog?.providers || []).map(provider => ({ ...provider, models: provider.models.filter(model => `${provider.name} ${protocolNames[provider.protocol]} ${model.id} ${model.name}`.toLowerCase().includes(query)) })).filter(provider => provider.models.length);
  const hasModels = visibleCatalog?.providers.some(provider => provider.models.length);
  const hasUsableModels = visibleCatalog?.providers.some(provider => provider.models.some(model => !unavailableReason(provider, model)));
  const label = `${settings?.providerName ? `${settings.providerName} / ` : ''}${settings?.model || '选择模型'}`;
  const toggle = () => {
    if (open) close();
    else { setSearch(''); setLoadError(''); setSelectionError(previous => pendingSync ? previous : ''); setOpen(true); }
  };

  return <>
    <button ref={triggerRef} type="button" className="model-picker" aria-label="选择默认模型" aria-haspopup="dialog" aria-expanded={open && visible} aria-controls={open && visible ? 'workspace-model-picker' : undefined} aria-busy={selecting} disabled={disabled} title={`${label} · ${scopeLabel}配置`} onClick={toggle} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) toggle(); } }}>{selecting ? <PixelActivity /> : <Icon name="spark" size={14} />}<span>{pendingSync ? '模型已切换 · 待同步' : <><span className="sr-only">{settings?.providerName ? `${settings.providerName} / ` : ''}</span>{settings?.model || '选择模型'}</>}</span><small className="model-picker-scope" aria-label={`供应商来源：${scopeLabel}配置`}>{scopeLabel}</small><Icon name="down" size={12} /></button>
    {open && visible && createPortal(<section id="workspace-model-picker" ref={panelRef} role="dialog" aria-label="选择默认模型" className="workspace-model-picker" style={position || { visibility: 'hidden' }} onKeyDown={moveFocus}>
      <header className="model-choice-heading"><div><strong>切换工作台模型 <span className="model-picker-scope">{scopeLabel}配置</span></strong><p>{isRunning ? '当前任务保持原模型，选择用于下一次运行。' : '直接选择已配置模型，不离开当前会话。'}</p></div><button type="button" className="icon-button" aria-label="关闭模型选择" onClick={() => close(true)}><Icon name="close" size={14} /></button></header>
      <input ref={searchRef} type="search" className="model-choice-search" aria-label="搜索已配置模型" placeholder="搜索供应商、模型名称或 ID…" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="model-choice-body" aria-busy={loading || selecting}>
        {selectionError && <div className="model-choice-error" role="alert"><p>{selectionError}</p>{pendingSync && <button type="button" className="text-button" disabled={selecting || disabled} onClick={() => switchModel()}>重试同步模型</button>}</div>}
        {loading ? <PixelLoader compact label="正在载入可选模型" /> : loadError ? <div className="model-choice-error" role="alert"><p>无法载入模型：{loadError}</p><button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>重试加载模型</button></div> : <>
          {!hasUsableModels && <p className="model-choice-empty">{hasModels ? '暂无可用模型，请在管理页启用供应商和模型，并配置密钥。' : '尚未添加模型。保存供应商后，还需要添加或导入模型。'}</p>}
          {hasModels && !providers.length && <p className="model-choice-empty">没有匹配的模型，请调整搜索关键词。</p>}
          {providers.map(provider => <section className="model-choice-group" key={provider.id} aria-label={`供应商 ${provider.name}`}><h3>{provider.name}<small>{protocolNames[provider.protocol]}</small></h3>{provider.models.map(model => {
            const reason = unavailableReason(provider, model);
            const active = catalog.active?.providerId === provider.id && catalog.active?.modelId === model.id;
            return <button type="button" data-model-choice key={model.id} className="model-choice-option" aria-label={`选择模型 ${provider.name} / ${model.id}`} aria-pressed={active} disabled={!!reason || loading || selecting || disabled} onClick={() => switchModel(provider, model)}><span><strong>{model.name || model.id}</strong><code>{model.id}</code></span><small>{reason || (active ? '当前默认' : '选择')}</small>{active && <Icon name="check" size={14} />}</button>;
          })}</section>)}
        </>}
      </div>
      <footer><span>{selecting ? <><PixelActivity />正在切换模型…</> : `仅显示${scopeLabel}配置 · 默认选择保存到此来源`}</span><button type="button" className="text-button" disabled={selecting} onClick={() => { close(); onManage(); }}><Icon name="settings" size={13} />管理供应商与模型</button></footer>
    </section>, document.body)}
  </>;
}

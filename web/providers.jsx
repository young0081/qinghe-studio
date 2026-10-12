import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PixelActivity, PixelLoader } from './motion.jsx';
import { ReasoningFields } from './reasoning.jsx';
import { reasoningIssue, reasoningLabel, validateReasoning } from '../src/core/reasoning.js';
import { VERSION } from '../src/version.js';
import ProviderScopes, { scopeNames } from './provider-scopes.jsx';
import ToolPolicyEditor from './tool-policy.jsx';
import ModelOrchestration from './model-orchestration.jsx';
import { defaultOrchestration, validateOrchestration } from '../src/core/orchestration-config.js';
import './providers.css';

const protocols = { responses: 'OpenAI Responses', openai: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages', systemone: 'System One / Jev（决策专用）' };
const numericFields = [
  { key: 'maxTokens', label: '响应 Token 上限', minimum: 1, maximum: 131072, fallback: 4096 },
  { key: 'temperature', label: 'Temperature', minimum: 0, maximum: 2, step: .1, fallback: .2 },
  { key: 'commandTimeoutMs', label: '命令超时', minimum: 100, maximum: 600000, fallback: 30000, unit: '毫秒' },
  { key: 'providerTimeoutMs', label: '模型请求超时', minimum: 100, maximum: 600000, fallback: 120000, unit: '毫秒' },
  { key: 'maxContextTokens', label: '模型上下文窗口（Token）', minimum: 1024, maximum: 2000000, fallback: 32000 },
  { key: 'contextCompactionThreshold', label: '自动压缩阈值', minimum: 0.5, maximum: 0.95, step: 0.05, fallback: 0.8 },
];

function providerDraft(provider) {
  return { name: provider?.name || '', protocol: provider?.protocol || 'responses', baseUrl: provider?.baseUrl || '', enabled: provider?.enabled ?? true, apiKey: '', clearKey: false };
}

function modelDraft(model) {
  return { id: model?.id || '', name: model?.name || '', enabled: model?.enabled ?? true, maxTokens: model?.maxTokens ?? '', maxContextTokens: model?.maxContextTokens ?? '', temperature: model?.temperature ?? '', reasoning: model?.reasoning || { mode: 'default' } };
}

function policyDraft(settings) {
  return { approval: settings?.approval || 'ask', autoApproveTools: settings?.autoApproveTools || [], modelOrchestration: settings?.modelOrchestration || defaultOrchestration, systemPrompt: settings?.systemPrompt || '', ...Object.fromEntries(numericFields.map(field => [field.key, settings?.[field.key] ?? field.fallback])) };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function editorDirty(editor) {
  return !same(editor.draft, editor.savedDraft) || !!editor.modelForm && !same(editor.modelForm, editor.savedModel) || editor.imports.length > 0;
}

function modelsEndpoint(provider) {
  const base = provider.baseUrl.trim() || (provider.protocol === 'systemone' ? 'https://api.typesafe.ai/v1' : provider.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
  try {
    const address = new URL(base);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) return '';
    return new URL(`${base.replace(/\/+$/, '')}/models`).href;
  } catch { return ''; }
}

function Notice({ notice, onDismiss, Icon }) {
  if (!notice) return null;
  return <div className={`management-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><Icon name={notice.kind === 'error' ? 'alert' : 'check'} size={16} /><span>{notice.text}</span><button className="icon-button" aria-label="关闭管理提示" onClick={onDismiss}><Icon name="close" size={13} /></button></div>;
}

export default function ManagementPage({ page, settings, revision, toolsRevision, api: sourceApi, onChanged, onSaveSettings, onNavigate, registerGuard, onScopeBusyChange, isRunning, backendVersion, Icon }) {
  const versionMismatch = !!backendVersion && backendVersion !== VERSION;
  const [scopes, setScopes] = useState(null);
  const [editingScope, setEditingScope] = useState(() => settings?.providerScope || 'workspace');
  const [cachedDirty, setCachedDirty] = useState(false);
  const [scopeWorking, setScopeWorking] = useState(false);
  const [scopeSyncPending, setScopeSyncPending] = useState(false);
  const [scopeError, setScopeError] = useState('');
  const scopeDrafts = useRef(new Map());
  const scopeSwitchRef = useRef(false);
  const scopeTarget = useRef(null);
  const api = useCallback((endpoint, options) => sourceApi(endpoint.startsWith('/providers') ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}scope=${editingScope}` : endpoint, options), [sourceApi, editingScope]);
  const [catalog, setCatalog] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(providerDraft());
  const [savedDraft, setSavedDraft] = useState(providerDraft());
  const [policy, setPolicy] = useState(() => policyDraft(settings));
  const [savedPolicy, setSavedPolicy] = useState(() => policyDraft(settings));
  const [modelForm, setModelForm] = useState(null);
  const [savedModel, setSavedModel] = useState(null);
  const [editingModelId, setEditingModelId] = useState('');
  const [providerSearch, setProviderSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [discovered, setDiscovered] = useState(null);
  const [discoveryTruncated, setDiscoveryTruncated] = useState(false);
  const [discoverySearch, setDiscoverySearch] = useState('');
  const [discoveryFailure, setDiscoveryFailure] = useState('');
  const [discoverySource, setDiscoverySource] = useState('');
  const [discoveryAction, setDiscoveryAction] = useState('');
  const [discoveryPhase, setDiscoveryPhase] = useState('');
  const [imports, setImports] = useState([]);
  const [working, setWorking] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const localDirty = editorDirty({ draft, savedDraft, modelForm, savedModel, imports });
  const dirty = localDirty || cachedDirty || !same(policy, savedPolicy);
  const localDirtyRef = useRef(localDirty);
  const dirtyRef = useRef(dirty);
  const selectedRef = useRef(selectedId);
  const catalogRef = useRef(catalog);
  const pendingRef = useRef(null);
  const confirmationRef = useRef(null);
  const headingRef = useRef(null);
  const originRef = useRef(null);
  const providerFormRef = useRef(null);
  const discoveryResultRef = useRef(null);
  const discoveryErrorRef = useRef(null);
  const alive = useRef(true);
  const loadSequence = useRef(0);
  dirtyRef.current = dirty;
  localDirtyRef.current = localDirty;
  selectedRef.current = selectedId;
  catalogRef.current = catalog;
  const selected = catalog?.providers.find(provider => provider.id === selectedId);
  const displayedCatalog = page === 'settings' ? scopes?.[scopes.activeScope] : catalog;
  const activeProvider = displayedCatalog?.providers.find(provider => provider.id === displayedCatalog.active?.providerId);
  const activeModel = activeProvider?.models.find(model => model.id === displayedCatalog.active?.modelId);
  const providerPath = `/providers/${encodeURIComponent(selectedId)}`;
  const busy = !!working || scopeWorking || scopeSyncPending;
  const providerNeedsSave = !selected || !same(draft, savedDraft);
  const discoveryLabel = discoveryAction || (providerNeedsSave ? '保存并获取模型列表' : '从接口获取模型列表');

  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => () => { onScopeBusyChange?.(false); }, [onScopeBusyChange]);
  useEffect(() => {
    Promise.resolve(window.harnessDesktop?.setUnsavedChanges?.(dirty)).catch(() => {});
  }, [dirty]);
  useEffect(() => () => {
    Promise.resolve(window.harnessDesktop?.setUnsavedChanges?.(false)).catch(() => {});
  }, []);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.closest('.management-page')?.scrollTo({ top: 0, behavior: 'instant' });
  }, [page]);
  useEffect(() => {
    if (!confirmation) return;
    confirmationRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    confirmationRef.current?.focus({ preventScroll: true });
  }, [confirmation]);
  useEffect(() => {
    if (discovered) discoveryResultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [discovered]);
  useEffect(() => {
    if (discoveryFailure) discoveryErrorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [discoveryFailure]);
  useEffect(() => {
    const next = policyDraft(settings);
    setPolicy(previous => same(previous, savedPolicy) ? next : previous);
    setSavedPolicy(next);
  }, [settings]);

  const selectProvider = useCallback(provider => {
    const next = providerDraft(provider);
    setSelectedId(provider?.id || 'new');
    setDraft(next);
    setSavedDraft(next);
    setModelForm(null);
    setSavedModel(null);
    setEditingModelId('');
    setModelSearch('');
    setDiscovered(null);
    setDiscoveryTruncated(false);
    setDiscoveryFailure('');
    setDiscoverySource('');
    setImports([]);
    setNotice(null);
  }, []);

  const editScope = scope => {
    if (busy || scope === editingScope || !scopes?.[scope]) return;
    scopeDrafts.current.set(editingScope, { selectedId, draft, savedDraft, modelForm, savedModel, editingModelId, providerSearch, modelSearch, discovered, discoveryTruncated, discoverySearch, discoveryFailure, discoverySource, imports });
    const cached = scopeDrafts.current.get(scope);
    scopeDrafts.current.delete(scope);
    setCachedDirty([...scopeDrafts.current.values()].some(editorDirty));
    loadSequence.current += 1;
    setEditingScope(scope);
    setCatalog(scopes[scope]);
    catalogRef.current = scopes[scope];
    setNotice(null);
    if (cached) {
      setSelectedId(cached.selectedId);
      selectedRef.current = cached.selectedId;
      setDraft(cached.draft);
      setSavedDraft(cached.savedDraft);
      setModelForm(cached.modelForm);
      setSavedModel(cached.savedModel);
      setEditingModelId(cached.editingModelId);
      setProviderSearch(cached.providerSearch);
      setModelSearch(cached.modelSearch);
      setDiscovered(cached.discovered);
      setDiscoveryTruncated(cached.discoveryTruncated);
      setDiscoverySearch(cached.discoverySearch);
      setDiscoveryFailure(cached.discoveryFailure);
      setDiscoverySource(cached.discoverySource);
      setImports(cached.imports);
      localDirtyRef.current = editorDirty(cached);
    } else {
      const catalog = scopes[scope];
      const provider = catalog.providers.find(item => item.id === catalog.active?.providerId) || catalog.providers[0];
      selectedRef.current = provider?.id || 'new';
      localDirtyRef.current = false;
      selectProvider(provider);
      setProviderSearch('');
    }
  };

  const activateScope = async (scope, synchronizeOnly = false) => {
    if (scopeSwitchRef.current || working || !synchronizeOnly && scope === scopes?.activeScope) return;
    scopeSwitchRef.current = true;
    scopeTarget.current = scope;
    setScopeWorking(true);
    setScopeError('');
    onScopeBusyChange?.(true);
    let changedScope = synchronizeOnly;
    try {
      const next = await sourceApi('/provider-scopes', synchronizeOnly ? undefined : { method: 'POST', body: { scope } });
      changedScope = true;
      if (!alive.current) return;
      setScopes(next);
      setLoadError('');
      await onChanged();
      if (!alive.current) return;
      setScopeSyncPending(false);
      onScopeBusyChange?.(false);
      setNotice({ kind: 'success', text: `当前工作区正在使用${scopeNames[next.activeScope]}。新任务将使用这套配置。` });
    } catch (error) {
      if (!alive.current) return;
      if (!changedScope && !synchronizeOnly) {
        try {
          const reconciled = await sourceApi('/provider-scopes');
          if (!alive.current) return;
          setScopes(reconciled);
          setLoadError('');
          await onChanged();
          if (!alive.current) return;
          setScopeSyncPending(false);
          onScopeBusyChange?.(false);
          if (reconciled.activeScope === scope) setNotice({ kind: 'success', text: `配置来源已重新确认：当前使用${scopeNames[scope]}。` });
          else setScopeError(`无法切换配置来源，当前使用${scopeNames[reconciled.activeScope]}。${error.message}`);
        } catch (failure) {
          if (!alive.current) return;
          setScopeSyncPending(true);
          setScopeError(`暂时无法确认配置来源，请重试同步后再发送任务。${failure.message}`);
        }
      } else {
        setScopeSyncPending(true);
        setScopeError(!synchronizeOnly ? `配置来源已保存，但工作台同步失败。重试同步后即可发送任务。${error.message}` : `暂时无法确认配置来源，请重试同步后再发送任务。${error.message}`);
      }
    } finally {
      scopeSwitchRef.current = false;
      if (alive.current) setScopeWorking(false);
    }
  };

  useEffect(() => {
    const sequence = ++loadSequence.current;
    setLoadError('');
    if (!catalogRef.current) setLoading(true);
    sourceApi('/provider-scopes').then(nextScopes => {
      if (!alive.current || sequence !== loadSequence.current) return;
      setScopes(nextScopes);
      const next = nextScopes[editingScope];
      setCatalog(next);
      const existing = next.providers.find(provider => provider.id === selectedRef.current);
      if (!localDirtyRef.current && selectedRef.current !== 'new') {
        if (existing && catalogRef.current) {
          const refreshed = providerDraft(existing);
          setDraft(refreshed);
          setSavedDraft(refreshed);
        } else selectProvider(next.providers.find(provider => provider.id === next.active?.providerId) || next.providers[0]);
      }
    }).catch(error => {
      if (alive.current && sequence === loadSequence.current) setLoadError(error.message);
    }).finally(() => {
      if (alive.current && sequence === loadSequence.current) setLoading(false);
    });
  }, [sourceApi, editingScope, revision, loadVersion, selectProvider]);

  const requestChange = useCallback(action => {
    if (working || scopeWorking || scopeSyncPending) {
      setNotice({ kind: 'info', text: '操作正在进行，请完成后再离开当前编辑。' });
      return;
    }
    if (!dirtyRef.current) { action(); return; }
    originRef.current = document.activeElement;
    pendingRef.current = action;
    setConfirmation({ kind: 'discard', title: '有未保存的更改', detail: '离开会放弃两套配置中的供应商、模型或运行策略未保存编辑。已保存的设置与工作台任务不受影响。' });
  }, [working, scopeWorking, scopeSyncPending]);

  useEffect(() => registerGuard(requestChange), [registerGuard, requestChange]);
  useEffect(() => {
    const prevent = event => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, []);

  const confirmAction = (title, detail, action) => {
    originRef.current = document.activeElement;
    pendingRef.current = action;
    setConfirmation({ kind: 'delete', title, detail });
  };
  const acceptConfirmation = () => {
    const action = pendingRef.current;
    pendingRef.current = null;
    if (confirmation.kind === 'discard') {
      setDraft(savedDraft);
      setModelForm(null);
      setPolicy(savedPolicy);
      setImports([]);
      scopeDrafts.current.clear();
      setCachedDirty(false);
      dirtyRef.current = false;
    }
    setConfirmation(null);
    action?.();
  };
  const run = async (key, operation) => {
    setWorking(key);
    setNotice(null);
    try { await operation(); } catch (error) { if (alive.current) setNotice({ kind: 'error', text: error.message }); } finally { if (alive.current) setWorking(''); }
  };
  const changed = async (next, message) => {
    loadSequence.current += 1;
    setCatalog(next);
    setScopes(previous => previous ? { ...previous, [editingScope]: next } : previous);
    await onChanged(next);
    if (alive.current) setNotice({ kind: 'success', text: message });
  };
  const persistProvider = async () => {
    const patch = { name: draft.name.trim(), protocol: draft.protocol, baseUrl: draft.baseUrl.trim(), enabled: draft.enabled };
    if (draft.clearKey || draft.apiKey) patch.apiKey = draft.clearKey ? '' : draft.apiKey;
    const next = await api(selected ? providerPath : '/providers', { method: selected ? 'PATCH' : 'POST', body: patch });
    const saved = selected ? next.providers.find(provider => provider.id === selectedId) : next.providers.find(provider => !catalog.providers.some(existing => existing.id === provider.id));
    if (!saved) throw new Error('保存响应缺少供应商，请重新载入配置。');
    loadSequence.current += 1;
    setCatalog(next);
    setScopes(previous => previous ? { ...previous, [editingScope]: next } : previous);
    selectedRef.current = saved.id;
    setSelectedId(saved.id);
    const cleanDraft = providerDraft(saved);
    setDraft(cleanDraft);
    setSavedDraft(cleanDraft);
    setDiscovered(null);
    setDiscoveryFailure('');
    setDiscoverySource('');
    setImports([]);
    return { provider: saved, catalog: next };
  };
  const saveProvider = event => {
    event.preventDefault();
    run('provider-save', async () => {
      const result = await persistProvider();
      await changed(result.catalog, '供应商已保存。密钥不会返回浏览器。');
    });
  };
  const changeProviderState = () => requestChange(() => run('provider-state', async () => {
    const next = await api(providerPath, { method: 'PATCH', body: { enabled: !selected.enabled } });
    selectProvider(next.providers.find(provider => provider.id === selectedId));
    await changed(next, selected.enabled ? '供应商已禁用。' : '供应商已启用。');
  }));
  const deleteProvider = () => requestChange(() => confirmAction('删除这个供应商？', `将移除「${selected.name}」及其全部模型与已保存密钥。历史会话和文件不会删除。`, () => run('provider-delete', async () => {
    const next = await api(providerPath, { method: 'DELETE' });
    selectProvider(next.providers.find(provider => provider.id === next.active?.providerId) || next.providers[0]);
    await changed(next, '供应商已删除。');
  })));
  const editModel = model => requestChange(() => {
    const next = modelDraft(model);
    setModelForm(next);
    setSavedModel(next);
    setEditingModelId(model?.id || '');
    setNotice(null);
  });
  const saveModel = event => {
    event.preventDefault();
    run('model-save', async () => {
      const model = { id: modelForm.id.trim(), name: modelForm.name.trim() || modelForm.id.trim(), enabled: modelForm.enabled };
      for (const key of ['maxTokens', 'temperature', 'maxContextTokens']) model[key] = modelForm[key] === '' ? null : Number(modelForm[key]);
      if (!versionMismatch) {
        model.reasoning = validateReasoning(modelForm.reasoning);
        const issue = reasoningIssue({ provider: selected.protocol, reasoning: model.reasoning, maxTokens: model.maxTokens ?? settings.maxTokens });
        if (issue) throw new Error(issue);
      }
      const next = await api(editingModelId ? `${providerPath}/models/${encodeURIComponent(editingModelId)}` : `${providerPath}/models`, { method: editingModelId ? 'PATCH' : 'POST', body: editingModelId ? model : { models: [model] } });
      setModelForm(null);
      setSavedModel(null);
      await changed(next, '模型已保存。');
    });
  };
  const modelAction = (model, action) => requestChange(() => {
    setModelForm(null);
    setSavedModel(null);
    if (action === 'delete') {
      confirmAction('删除这个模型？', `将从「${selected.name}」移除 ${model.id}。历史任务不会改变。`, () => run(`delete:${model.id}`, async () => changed(await api(`${providerPath}/models/${encodeURIComponent(model.id)}`, { method: 'DELETE' }), '模型已删除。')));
    } else run(`${action}:${model.id}`, async () => {
      if (action === 'test') {
        const result = await api(`${providerPath}/test`, { method: 'POST', body: { modelId: model.id } });
        if (!result.ok) throw new Error(result.error || '模型没有返回有效响应。');
        setNotice({ kind: 'success', text: `连接成功 · ${result.model || model.id} · ${result.latencyMs} ms` });
      } else if (action === 'active') {
        await changed(await api('/providers/active', { method: 'POST', body: { providerId: selectedId, modelId: model.id } }), `${scopeNames[editingScope]}的默认供应商与模型已保存。${scopes?.activeScope === editingScope ? '将用于下一次运行。' : '启用这套配置后即可使用。'}`);
      } else {
        await changed(await api(`${providerPath}/models/${encodeURIComponent(model.id)}`, { method: 'PATCH', body: { enabled: !model.enabled } }), model.enabled ? '模型已禁用。' : '模型已启用。');
      }
    });
  });
  const discover = () => {
    if (busy || confirmation) return;
    if (providerNeedsSave && !providerFormRef.current?.reportValidity()) return;
    run('discover', async () => {
      setDiscoveryAction(providerNeedsSave ? '保存并获取模型列表' : '从接口获取模型列表');
      setDiscoveryPhase(providerNeedsSave ? 'saving' : 'fetching');
      setDiscoveryFailure('');
      setDiscovered(null);
      setDiscoveryTruncated(false);
      setDiscoverySource('');
      setImports([]);
      setDiscoverySearch('');
      let provider = selected;
      let saved = false;
      let synchronizationFailed = false;
      try {
        if (providerNeedsSave) {
          const result = await persistProvider();
          provider = result.provider;
          saved = true;
          try { await onChanged(result.catalog); } catch { synchronizationFailed = true; }
        }
        setDiscoveryPhase('fetching');
        const result = await api(`/providers/${encodeURIComponent(provider.id)}/discover`, { method: 'POST', body: {} });
        if (!alive.current) return;
        setDiscovered(result.models || []);
        setDiscoveryTruncated(!!result.truncated);
        setDiscoverySource(modelsEndpoint(provider));
        if (synchronizationFailed) setNotice({ kind: 'info', text: '供应商已保存，模型列表已获取；工作台状态同步失败，请刷新后重试。' });
      } catch (error) {
        if (!alive.current) return;
        const prefix = saved ? '供应商已保存，但获取模型列表失败。配置已保留，可直接重试。' : providerNeedsSave ? '保存供应商失败，未获取模型列表。请检查配置后重试。' : '获取模型列表失败，请检查接口地址、密钥或服务是否启动后重试。';
        setDiscoveryFailure(`${prefix} ${error.message}`);
      } finally {
        if (alive.current) { setDiscoveryAction(''); setDiscoveryPhase(''); }
      }
    });
  };
  const importModels = () => run('import', async () => {
    const models = discovered.filter(model => imports.includes(model.id) && !selected.models.some(existing => existing.id === model.id)).map(model => ({ id: model.id, name: model.name || model.id, enabled: true }));
    const next = await api(`${providerPath}/models`, { method: 'POST', body: { models } });
    setDiscovered(null);
    setImports([]);
    await changed(next, `已导入 ${models.length} 个模型。`);
  });
  const clearActive = () => requestChange(() => run('active-clear', async () => {
    await changed(await api('/providers/active', { method: 'POST', body: { providerId: null, modelId: null } }), '已取消默认选择。重新选择一个默认模型后即可发送任务。');
  }));
  const savePolicy = event => {
    event.preventDefault();
    run('policy-save', async () => {
      const values = { ...policy, ...Object.fromEntries(numericFields.map(field => [field.key, Number(policy[field.key])])) };
      values.modelOrchestration = validateOrchestration(values.modelOrchestration);
      const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => !same(value, savedPolicy[key])));
      const next = await onSaveSettings(patch);
      const saved = policyDraft(next || values);
      setPolicy(saved);
      setSavedPolicy(saved);
      setNotice({ kind: 'success', text: '运行策略已保存。审批策略立即生效，其余参数用于下一次运行。' });
    });
  };
  const providers = catalog?.providers.filter(provider => `${provider.name} ${provider.protocol} ${provider.baseUrl}`.toLowerCase().includes(providerSearch.toLowerCase())) || [];
  const models = selected?.models.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(modelSearch.toLowerCase())) || [];
  const candidates = discovered?.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(discoverySearch.toLowerCase())) || [];
  const importableCandidates = candidates.filter(model => !selected?.models.some(existing => existing.id === model.id));
  const selectedImports = imports.filter(id => !selected?.models.some(model => model.id === id));
  const endpoint = modelsEndpoint(draft);
  const selectedIsActive = catalog?.active?.providerId === selectedId;
  const changeDraft = (key, value) => { setDraft(previous => ({ ...previous, [key]: value })); setNotice(null); };

  return <main className="management-page" aria-label={page === 'providers' ? '供应商与模型' : '运行策略'} aria-busy={loading}>
    <header className="management-heading"><div><span className="eyebrow">BUILD YOUR LOADOUT</span><h1 ref={headingRef} tabIndex={-1}>{page === 'providers' ? '供应商与模型' : '运行策略'}</h1><p>连接你的模型，把每一次构建交给合适的伙伴。</p></div><button className="button button-quiet" onClick={() => onNavigate('workspace')}><Icon name="arrow" className="back-arrow" size={15} />返回工作台</button></header>
    <nav className="management-navigation" aria-label="设置页面"><a href="#/providers" aria-current={page === 'providers' ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate('providers'); }}><Icon name="spark" size={15} />供应商与模型</a><a href="#/settings" aria-current={page === 'settings' ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate('settings'); }}><Icon name="shield" size={15} />运行策略</a></nav>
    <div className="management-body">
      {page === 'providers' && <><ProviderScopes scopes={scopes} editingScope={editingScope} onEdit={editScope} onActivate={activateScope} busy={!!working || scopeWorking} switching={scopeWorking} pending={scopeSyncPending} error={scopeError} onRetry={() => activateScope(scopeTarget.current, scopeSyncPending)} /><div className="provider-editing-heading"><span className="eyebrow">EDITING / {editingScope.toUpperCase()}</span><h2>正在编辑{scopeNames[editingScope]}</h2><p>{scopes?.activeScope === editingScope ? '当前工作区正在使用下方配置。' : `当前工作区使用${scopeNames[scopes?.activeScope] || '工作区配置'}；下方内容可独立配置。`}</p></div></>}
      <section className="active-model-card" aria-label="当前默认模型"><span className="management-section-icon"><Icon name="spark" size={21} /></span><div><span className="eyebrow">CURRENT LOADOUT</span><strong>{activeProvider?.name || (!catalog && settings?.providerName) || '尚未选择供应商'}<span> / </span>{activeModel?.name || (!catalog && settings?.model) || '尚未选择模型'}</strong><p>{activeModel ? `${protocols[activeProvider.protocol]} · ${activeModel.id}` : '添加供应商与模型后，点击「设为默认」开始使用。'}</p></div><span className={`management-tag ${activeModel ? 'enabled' : ''}`}>{activeModel ? '默认配置' : '待配置'}</span>{page === 'providers' && catalog?.active && <button className="text-button" disabled={busy} onClick={clearActive}>取消默认选择</button>}</section>
      {isRunning && <div className="management-run-note"><PixelActivity /><span>任务仍在工作台运行。供应商与模型的更改用于下一次运行；审批策略立即生效。</span></div>}
      {confirmation && <section className="management-confirm" ref={confirmationRef} tabIndex={-1} role="region" aria-label={confirmation.title}><div><strong>{confirmation.title}</strong><p>{confirmation.detail}</p></div><div className="management-actions"><button className="button button-quiet" onClick={() => { setConfirmation(null); pendingRef.current = null; originRef.current?.focus(); }}>{confirmation.kind === 'discard' ? '继续编辑' : '取消删除'}</button><button className="button button-danger" onClick={acceptConfirmation}>{confirmation.kind === 'discard' ? '放弃更改并继续' : '确认删除'}</button></div></section>}
      <Notice notice={notice} onDismiss={() => setNotice(null)} Icon={Icon} />
      {loadError && <div className="management-notice error" role="alert"><Icon name="alert" size={16} /><span>{loadError}</span><button className="text-button" onClick={() => setLoadVersion(value => value + 1)}>重试载入供应商</button></div>}
      {loading ? <PixelLoader label="正在载入供应商" detail="正在整理已保存的连接与模型…" /> : page === 'settings' ? <form className="policy-form management-card" aria-label="运行策略表单" onSubmit={savePolicy}><fieldset disabled={busy || !settings}>
        <div className="management-card-title"><span className="section-number">01</span><div><h2>执行与审批</h2><p>审批策略立即生效，其余参数用于下一次运行。Token 上限与 Temperature 显示当前模型有效参数，模型专属配置优先。</p></div></div>
        <label>工具审批策略<select aria-label="工具审批策略" value={policy.approval} onChange={event => setPolicy(previous => ({ ...previous, approval: event.target.value }))}><option value="ask">请求审批 · 写入文件和执行命令前确认</option><option value="readonly">只读模式 · 禁止写入和命令</option><option value="auto">自动批准（YOLO）· 已启用工具直接执行</option></select></label>
        {policy.approval === 'auto' && <p className="management-warning">自动批准覆盖文件、命令、MCP 及已启用的浏览器和桌面工具，不再逐次弹出审批。</p>}
        <ToolPolicyEditor api={sourceApi} revision={`${revision}:${toolsRevision}`} value={policy.autoApproveTools} onChange={autoApproveTools => setPolicy(previous => ({ ...previous, autoApproveTools }))} mode={policy.approval} />
        <p className="management-hint">任务没有步数或累计 Token 上限。默认在模型窗口占用接近 80% 时生成摘要并自动继续；响应 Token 上限仅限制一次输出，触顶会自动续写。窗口大小请按供应商提供的模型规格填写，可在模型编辑页单独覆盖。</p>
        <div className="management-field-grid">{numericFields.map(field => <label key={field.key}>{field.label}{field.unit && `（${field.unit}）`}<input aria-label={field.label} type="number" min={field.minimum} max={field.maximum} step={field.step || 1} required value={policy[field.key]} onChange={event => setPolicy(previous => ({ ...previous, [field.key]: event.target.value }))} /></label>)}</div>
        <label>系统提示词<textarea aria-label="系统提示词" rows="5" value={policy.systemPrompt} onChange={event => setPolicy(previous => ({ ...previous, systemPrompt: event.target.value }))} placeholder="你的工作方式、代码风格或项目约束…" /></label>
        <ModelOrchestration value={policy.modelOrchestration} scopes={scopes} onChange={modelOrchestration => setPolicy(previous => ({ ...previous, modelOrchestration }))} />
        <div className="management-form-footer"><span><Icon name="shield" size={14} />本地保存 · 审批策略立即生效</span><button className="button button-primary" type="submit" aria-busy={working === 'policy-save'}>{working === 'policy-save' ? <PixelActivity /> : <Icon name="check" size={15} />}保存运行策略</button></div>
      </fieldset></form> : catalog && <div className="provider-layout">
        <aside className="provider-list-panel" aria-label="供应商列表"><div className="provider-list-heading"><h2>我的供应商 <span>{catalog.providers.length}</span></h2><button className="icon-button" aria-label="新增供应商" title="新增供应商" disabled={busy} onClick={() => requestChange(() => selectProvider(null))}><Icon name="plus" size={16} /></button></div><label className="management-search"><span className="sr-only">搜索供应商</span><input aria-label="搜索供应商" type="search" value={providerSearch} onChange={event => setProviderSearch(event.target.value)} placeholder="搜索供应商…" /></label><div className="provider-list">{providers.map(provider => <button className={`provider-list-item ${provider.id === selectedId ? 'selected' : ''}`} data-provider-id={provider.id} aria-label={`选择供应商 ${provider.name}`} aria-current={provider.id === selectedId ? 'true' : undefined} disabled={busy} key={provider.id} onClick={() => requestChange(() => selectProvider(provider))}><span className={`mini-dot ${provider.enabled ? '' : 'amber'}`} /><span><strong>{provider.name}</strong><small>{protocols[provider.protocol]}</small><span className="provider-list-meta">{provider.models.length} 个模型 · {provider.enabled ? '已启用' : '已禁用'}</span></span>{catalog.active?.providerId === provider.id && <span className="provider-default-mark">默认</span>}</button>)}{!providers.length && <p className="management-empty">{catalog.providers.length ? '没有匹配的供应商。' : '还没有供应商。添加你的第一条连接。'}</p>}</div><button className="provider-add-button" disabled={busy} onClick={() => requestChange(() => selectProvider(null))}><Icon name="plus" size={15} />添加一个供应商</button><p className="provider-privacy"><Icon name="shield" size={15} />密钥仅保存在本机，页面不会回显，也不会写入浏览器存储。</p></aside>
        <div className="provider-detail">
          <form ref={providerFormRef} className="management-card provider-form" aria-label="供应商详情" onSubmit={saveProvider}><fieldset disabled={busy || !!confirmation || !!modelForm}>
            <div className="management-card-title"><span className="section-number">01</span><div><h2>{selected ? selected.name : '新增供应商'}</h2><p>同一种协议也可以配置多个独立连接。</p></div>{selected && <span className={`management-tag ${selected.enabled ? 'enabled' : ''}`}>{selected.enabled ? '已启用' : '已禁用'}</span>}</div>
            <div className="management-field-grid"><label>供应商名称<input aria-label="供应商名称" required maxLength="100" value={draft.name} onChange={event => changeDraft('name', event.target.value)} placeholder="例如：我的 OpenAI / 本地网关" /></label><label>API 协议<select aria-label="API 协议" value={draft.protocol} onChange={event => changeDraft('protocol', event.target.value)}>{Object.entries(protocols).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label></div>
            <label>API Base URL<input aria-label="API Base URL" type="url" value={draft.baseUrl} onChange={event => changeDraft('baseUrl', event.target.value)} placeholder="留空使用协议默认地址" /></label><p className="management-field-note">原生协议 <code>POST /{{ responses: 'responses', openai: 'chat/completions', anthropic: 'messages', systemone: 'systemone' }[draft.protocol]}</code>；填写 API 根地址，通常以 <code>/v1</code> 结尾。</p>
            <label>API 密钥<span className="label-note">{selected?.hasApiKey ? selected.apiKeySource === 'environment' ? '来自环境变量' : '已保存 · 留空保留' : '可使用对应环境变量'}</span><input aria-label="API 密钥" type="password" autoComplete="new-password" spellCheck="false" value={draft.apiKey} disabled={draft.clearKey} onChange={event => changeDraft('apiKey', event.target.value)} placeholder={selected?.hasApiKey ? '留空保留已配置密钥' : '输入 API 密钥'} /></label>
            <div className="management-checks"><label className="checkbox-field"><input type="checkbox" aria-label="清除已保存的密钥" checked={draft.clearKey} onChange={event => setDraft(previous => ({ ...previous, clearKey: event.target.checked, apiKey: '' }))} />清除已保存的密钥</label><label className="checkbox-field"><input type="checkbox" aria-label="供应商已启用" checked={draft.enabled} disabled={selectedIsActive} onChange={event => changeDraft('enabled', event.target.checked)} />供应商已启用</label></div>
            {draft.clearKey && <p className="management-warning">保存后移除本机密钥；如果存在对应环境变量，仍会使用环境变量中的密钥。</p>}
            <div className="management-form-footer"><span>{!same(draft, savedDraft) ? '有未保存的更改' : selected ? '已保存的连接配置' : '先保存供应商，再添加模型'}</span><button className="button button-primary" type="submit" aria-busy={working === 'provider-save'}>{working === 'provider-save' ? <PixelActivity /> : <Icon name="check" size={15} />}保存供应商</button></div>
          </fieldset></form>
          <section className="model-discovery-card" aria-label="接口模型列表" aria-busy={working === 'discover'}>
            <div className="discovery-entry-heading"><span className="discovery-entry-icon"><Icon name="link" size={23} /></span><div><span className="eyebrow">CONNECT + COLLECT</span><h2>从接口获取模型列表</h2><p>填写 API 地址与密钥，让供应商告诉你有哪些模型可用。</p></div></div>
            <div className="discovery-endpoint" aria-label="模型列表请求地址"><span>GET</span><code>{endpoint || '请输入有效的 HTTP(S) API 根地址'}</code></div>
            <p className="discovery-entry-help">支持本地服务，例如 <code>http://127.0.0.1:11434/v1</code>（替换为你的端口）。请求在本机代理端执行，密钥不会显示在地址中。</p>
            <div className="discovery-entry-actions"><div><strong>{providerNeedsSave ? '先保存当前连接，再获取模型列表' : '读取已保存连接的模型列表'}</strong><p>获取后选择要导入的模型，不会自动添加或更改默认模型。</p></div><button type="button" className="button button-primary" aria-label={discoveryLabel} disabled={busy || !!confirmation} onClick={discover} aria-busy={working === 'discover'}>{working === 'discover' ? <PixelActivity /> : <Icon name="link" size={15} />}{discoveryLabel}</button></div>
            <p className="discovery-entry-note">{modelForm ? '正在编辑的模型草稿会保留。' : '接口不支持模型列表时，仍可在下方手动添加模型。'}{discovered && ' 重新获取会清空上次结果与未导入的选择。'}</p>
            {working === 'discover' && <PixelLoader compact label="正在获取模型列表" detail={discoveryPhase === 'saving' ? '正在保存当前供应商配置，随后请求接口…' : '正在读取真实接口返回的模型信息…'} />}
            {discoveryFailure && <div className="discovery-request-error" ref={discoveryErrorRef} role="alert"><Icon name="alert" size={17} /><div><strong>无法获取模型列表</strong><p>{discoveryFailure}</p><p>接口可能不支持模型列表；已保存的模型和正在编辑的模型草稿不会改变。</p>{providerNeedsSave ? <p>修正后的配置尚未保存，请点击「保存并获取模型列表」重试。</p> : <button type="button" className="button button-quiet" disabled={busy || !!confirmation} onClick={discover}><Icon name="retry" size={14} />重试获取模型列表</button>}</div></div>}
          </section>
          {selected && <>
            <section className="management-card models-card" aria-label="供应商模型"><div className="management-card-title"><span className="section-number">02</span><div><h2>模型背包 <span>{selected.models.length}</span></h2><p>独立管理模型。测试、默认选择均使用已保存的配置。</p></div></div><div className="model-toolbar"><input type="search" aria-label="搜索模型" placeholder="搜索模型 ID 或名称…" value={modelSearch} onChange={event => setModelSearch(event.target.value)} /><button className="button button-primary" disabled={busy || !!confirmation} onClick={() => editModel(null)}><Icon name="plus" size={14} />添加模型</button></div>
              {modelForm && <form className="model-editor" aria-label={editingModelId ? '编辑模型' : '添加模型'} onSubmit={saveModel}><fieldset disabled={busy || !!confirmation}><h3>{editingModelId ? '编辑模型' : '添加模型'}</h3><div className="management-field-grid"><label>模型 ID<input aria-label="模型 ID" required disabled={selectedIsActive && catalog.active.modelId === editingModelId} value={modelForm.id} onChange={event => setModelForm(previous => ({ ...previous, id: event.target.value }))} placeholder="服务商的精确模型标识" /></label><label>模型显示名称<input aria-label="模型显示名称" value={modelForm.name} onChange={event => setModelForm(previous => ({ ...previous, name: event.target.value }))} placeholder="可选，便于识别的名称" /></label><label>响应 Token 上限<input aria-label="模型响应 Token 上限" type="number" min="1" max="131072" value={modelForm.maxTokens} onChange={event => setModelForm(previous => ({ ...previous, maxTokens: event.target.value }))} placeholder="留空继承运行策略" /></label><label>上下文窗口（Token）<input aria-label="模型上下文窗口" type="number" min="1024" max="2000000" value={modelForm.maxContextTokens} onChange={event => setModelForm(previous => ({ ...previous, maxContextTokens: event.target.value }))} placeholder="留空继承运行策略" /></label><label>Temperature<input aria-label="模型 Temperature" type="number" min="0" max="2" step="0.1" value={modelForm.temperature} onChange={event => setModelForm(previous => ({ ...previous, temperature: event.target.value }))} placeholder="留空继承运行策略" /></label></div><fieldset className="model-reasoning-group" disabled={versionMismatch || selected.protocol === 'systemone'}><ReasoningFields prefix="模型" protocol={selected.protocol} value={modelForm.reasoning} onChange={reasoning => setModelForm(previous => ({ ...previous, reasoning }))} maxTokens={modelForm.maxTokens === '' ? settings.maxTokens : Number(modelForm.maxTokens)} /></fieldset>{versionMismatch && <p className="reasoning-issue" role="status">后台 v{backendVersion} 与前端 v{VERSION} 不一致，思考设置已禁用。请重启 npm run web 并刷新；其他模型字段仍可保存。</p>}<label className="checkbox-field"><input aria-label="模型已启用" type="checkbox" checked={modelForm.enabled} disabled={selectedIsActive && catalog.active.modelId === editingModelId} onChange={event => setModelForm(previous => ({ ...previous, enabled: event.target.checked }))} />模型已启用</label><div className="management-actions"><button className="button button-quiet" type="button" onClick={() => requestChange(() => setModelForm(null))}>取消编辑模型</button><button className="button button-primary" type="submit" aria-busy={working === 'model-save'}>{working === 'model-save' && <PixelActivity />}保存模型</button></div></fieldset></form>}
              {discovered && <section className="discovery-panel" ref={discoveryResultRef} aria-label="远端模型发现">
                <div className="discovery-heading"><div><h3 aria-live="polite">已获取 {discovered.length} 个模型</h3><p>{discoveryTruncated ? '列表达到上限，可搜索本次结果或手动添加其它模型。' : '选择要导入的模型。已添加的模型不会重复导入。'}</p></div><button className="icon-button" aria-label="关闭远端模型发现" disabled={busy} onClick={() => { setDiscovered(null); setImports([]); }}><Icon name="close" size={15} /></button></div>
                <p className="discovery-result-source">列表来源 <code>{discoverySource}</code></p>
                {providerNeedsSave && <p className="management-warning">当前连接有未保存的更改。请保存并重新获取，确认模型列表来自最新配置。</p>}
                <input type="search" aria-label="搜索远端模型" placeholder="搜索获取到的模型名称或 ID…" value={discoverySearch} onChange={event => setDiscoverySearch(event.target.value)} />
                <div className="discovery-selection-toolbar"><span>当前匹配 {candidates.length} 个 · 可导入 {importableCandidates.length} 个</span><div><button type="button" className="text-button" disabled={busy || !importableCandidates.some(model => !imports.includes(model.id))} onClick={() => setImports(previous => [...new Set([...previous, ...importableCandidates.map(model => model.id)])])}>全选当前搜索结果</button><button type="button" className="text-button" disabled={busy || !imports.length} onClick={() => setImports([])}>清空选择</button></div></div>
                <div className="discovery-models">{candidates.map(model => { const exists = selected.models.some(existing => existing.id === model.id); return <label className="checkbox-field" key={model.id}><input type="checkbox" aria-label={`导入模型 ${model.id}`} disabled={busy || exists} checked={exists || imports.includes(model.id)} onChange={event => setImports(previous => event.target.checked ? [...previous, model.id] : previous.filter(id => id !== model.id))} /><span><strong>{model.name || model.id}</strong><code>{model.id}</code></span>{exists && <small>已添加</small>}</label>; })}{!candidates.length && <div className="management-empty"><p>{discovered.length ? '没有匹配的模型，请调整搜索关键词。' : '接口没有返回可用模型。你可以手动填写模型 ID。'}</p>{!discovered.length && <button type="button" className="text-button" disabled={busy} onClick={() => editModel(null)}>手动添加模型</button>}</div>}</div>
                <div className="management-form-footer"><span>已选择 {selectedImports.length} 个模型</span><button className="button button-primary" disabled={busy || providerNeedsSave || !selectedImports.length} onClick={importModels} aria-busy={working === 'import'}>{working === 'import' && <PixelActivity />}导入所选模型</button></div>
              </section>}
              {models.length ? <div className="models-table-wrap"><table className="models-table" aria-label="模型列表"><thead><tr><th scope="col">模型</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>{models.map(model => { const active = selectedIsActive && catalog.active.modelId === model.id; return <tr data-model-id={model.id} aria-label={model.id} key={model.id}><td><strong>{model.name || model.id}</strong><code>{model.id}</code>{model.reasoning && model.reasoning.mode !== 'default' && <small>思考：{reasoningLabel(model.reasoning)}</small>}{model.maxContextTokens != null && <small>上下文窗口：{model.maxContextTokens} tokens</small>}{(model.maxTokens != null || model.temperature != null) && <small>{model.maxTokens != null && `${model.maxTokens} tokens`}{model.maxTokens != null && model.temperature != null && ' · '}{model.temperature != null && `T ${model.temperature}`}</small>}</td><td><span className={`management-tag ${model.enabled ? 'enabled' : ''}`}>{active ? '当前默认' : model.enabled ? '已启用' : '已禁用'}</span></td><td><div className="model-row-actions"><button className="text-button" disabled={busy || !selected.enabled || !model.enabled || !selected.hasApiKey} aria-busy={working === `test:${model.id}`} onClick={() => modelAction(model, 'test')}>{working === `test:${model.id}` ? <PixelActivity /> : <Icon name="activity" size={13} />}测试连接</button><button className="text-button" disabled={busy || active || selected.protocol === 'systemone' || !selected.enabled || !model.enabled || !selected.hasApiKey} onClick={() => modelAction(model, 'active')}>设为默认</button><button className="text-button" disabled={busy} onClick={() => editModel(model)}>编辑模型</button><button className="text-button" disabled={busy || active} title={active ? '请先切换默认模型' : undefined} onClick={() => modelAction(model, 'state')}>{model.enabled ? '禁用模型' : '启用模型'}</button><button className="text-button danger-text" disabled={busy || active} title={active ? '请先切换默认模型' : undefined} onClick={() => modelAction(model, 'delete')}>删除模型</button></div></td></tr>; })}</tbody></table></div> : <div className="management-empty model-empty"><Icon name="spark" size={29} /><h3>{selected.models.length ? '没有匹配的模型' : '为这个供应商添加第一个模型'}</h3><p>手动填写模型 ID，或从远端发现并选择导入。</p></div>}
            </section>
            <section className="provider-danger-zone"><div><strong>管理这个供应商</strong><p>{selectedIsActive ? '此供应商正在用作默认配置。请先切换默认供应商，再禁用或删除。' : '禁用会保留配置；删除会移除此供应商及其全部模型。'}</p></div><div className="management-actions"><button className="button button-quiet" disabled={busy || selectedIsActive} onClick={changeProviderState}>{selected.enabled ? '禁用供应商' : '启用供应商'}</button><button className="button button-danger" disabled={busy || selectedIsActive} onClick={deleteProvider}>删除供应商</button></div></section>
          </>}
        </div>
      </div>}
      <footer className="management-footer"><Icon name="shield" size={14} /><span>{page === 'providers' ? `正在编辑${scopeNames[editingScope]}。密钥仅保存在本机；两套配置各自保存。` : '运行策略保存在当前工作区，任务会话始终留在工作台。'}</span><span>LOCAL FIRST + NATIVE MODELS</span></footer>
    </div>
  </main>;
}

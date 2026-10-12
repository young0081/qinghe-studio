import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateSettings, apiKeyFor, assertConfigured, atomicJson, redact } from './settings.js';
import { orchestrationReferences, selectionKey } from './orchestration-config.js';
import { discoverModels } from './model-discovery.js';
import { GlobalProviders, processAlive } from './global-providers.js';

const protocols = ['responses', 'openai', 'anthropic', 'systemone'];
const protocolNames = { responses: 'OpenAI Responses', openai: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages', systemone: 'System One / Jev' };
const connectionKeys = ['provider', 'baseUrl', 'model', 'apiKey'];
const modelKeys = ['maxTokens', 'temperature', 'reasoning', 'maxContextTokens'];
const owns = (value, key) => Object.hasOwn(value, key);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`);
  return value;
}

function fields(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}包含未知字段`);
}

function text(value, label, maximum = 512) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label}必须是 1–${maximum} 字符的文本`);
  return value.trim();
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label}必须是布尔值`);
  return value;
}

function model(input, current) {
  fields(input, ['id', 'name', 'enabled', ...modelKeys], '模型');
  const next = { ...current, ...input };
  const result = { id: text(next.id, '模型 ID'), name: text(next.name === undefined ? next.id : next.name, '模型名称'), enabled: boolean(next.enabled === undefined ? true : next.enabled, '模型启用状态') };
  for (const key of modelKeys) {
    if (next[key] !== undefined && next[key] !== null) result[key] = validateSettings({ [key]: next[key] })[key];
  }
  return result;
}

function provider(input, current) {
  fields(input, ['name', 'protocol', 'baseUrl', 'enabled', 'apiKey', 'models'], '供应商');
  const next = { protocol: 'responses', baseUrl: '', enabled: true, apiKey: '', models: [], ...current, ...input };
  if (input.apiKey === undefined) next.apiKey = current?.apiKey ?? '';
  if (!protocols.includes(next.protocol)) fail('不支持的模型提供商，请选择 responses、openai、anthropic 或 systemone');
  if (typeof next.apiKey !== 'string' || next.apiKey.length > 8192) fail('API Key 必须是不超过 8192 字符的字符串');
  if (typeof next.baseUrl !== 'string') fail('baseUrl 必须是字符串');
  const baseUrl = validateSettings({ baseUrl: next.baseUrl.trim() }).baseUrl;
  if (!Array.isArray(next.models) || next.models.length > 1000) fail('每个供应商最多保存 1000 个模型');
  const models = next.models.map(value => model(value));
  if (new Set(models.map(value => value.id)).size !== models.length) fail('同一供应商的模型 ID 不能重复', 409);
  return { id: current?.id ?? randomUUID(), name: text(next.name === undefined ? protocolNames[next.protocol] : next.name, '供应商名称', 160), protocol: next.protocol, baseUrl, enabled: boolean(next.enabled, '供应商启用状态'), apiKey: next.apiKey, models };
}

function findProvider(catalog, providerId) {
  const found = catalog.providers.find(value => value.id === providerId);
  if (!found) fail('供应商不存在', 404);
  return found;
}

function findModel(profile, modelId) {
  const found = profile.models.find(value => value.id === modelId);
  if (!found) fail('模型不存在', 404);
  return found;
}

function projection(state) {
  const selected = state.catalog.active;
  const profile = state.catalog.providers.find(value => value.id === (selected?.providerId ?? state.catalog.legacyProviderId));
  const selectedModel = selected && profile?.models.find(value => value.id === selected.modelId);
  return validateSettings({ ...state.base, ...(profile?.protocol === 'systemone' ? { reasoning: { mode: 'default' } } : {}), provider: profile?.protocol ?? 'responses', baseUrl: profile?.baseUrl ?? '', apiKey: profile?.apiKey ?? '', model: selectedModel?.id ?? '', ...Object.fromEntries(modelKeys.filter(key => selectedModel?.[key] !== undefined).map(key => [key, selectedModel[key]])) });
}

function snapshot(state, scope = 'workspace') {
  const { autoApproveTools, modelOrchestration, ...settings } = projection(state);
  return { ...settings, providerCatalog: { ...state.catalog, scope, autoApproveTools, modelOrchestration, modelDefaults: Object.fromEntries(modelKeys.map(key => [key, state.base[key]])) } };
}

function legacyPatch(state, input) {
  object(input, '设置');
  const patch = { ...input };
  if (patch.apiKey === undefined) delete patch.apiKey;
  const candidate = validateSettings({ ...projection(state), ...patch });
  state.base = validateSettings({ ...state.base, ...Object.fromEntries(Object.entries(patch).filter(([key]) => !connectionKeys.includes(key))) });
  if (!connectionKeys.some(key => owns(patch, key))) {
    const selected = state.catalog.active;
    if (selected) {
      const current = findModel(findProvider(state.catalog, selected.providerId), selected.modelId);
      for (const key of modelKeys) if (owns(patch, key) && owns(current, key)) current[key] = patch[key];
    }
    return;
  }
  let profile = state.catalog.providers.find(value => value.id === (state.catalog.active?.providerId ?? state.catalog.legacyProviderId));
  if (!profile || profile.protocol !== candidate.provider) profile = state.catalog.providers.find(value => value.protocol === candidate.provider && value.baseUrl === candidate.baseUrl);
  if (!profile) {
    profile = provider({ protocol: candidate.provider, baseUrl: candidate.baseUrl, apiKey: owns(patch, 'apiKey') ? candidate.apiKey : '' });
    state.catalog.providers.push(profile);
  }
  if (!profile.enabled) fail('供应商已禁用，请先启用', 409);
  if (owns(patch, 'baseUrl')) profile.baseUrl = candidate.baseUrl;
  if (owns(patch, 'apiKey')) profile.apiKey = candidate.apiKey;
  if (candidate.model) {
    let selectedModel = profile.models.find(value => value.id === candidate.model);
    if (!selectedModel) { selectedModel = model({ id: candidate.model }); profile.models.push(selectedModel); }
    if (!selectedModel.enabled) fail('模型已禁用，请先启用', 409);
    for (const key of modelKeys) if (owns(patch, key) && owns(selectedModel, key)) selectedModel[key] = patch[key];
    state.catalog.active = { providerId: profile.id, modelId: selectedModel.id };
    state.catalog.legacyProviderId = null;
  } else {
    state.catalog.active = null;
    state.catalog.legacyProviderId = profile.id;
  }
}

function validateCatalog(value) {
  object(value, '供应商目录');
  if (value.version !== 1 || !Array.isArray(value.providers) || value.providers.length > 100) fail('供应商目录格式无效或超过 100 个供应商');
  const providers = value.providers.map(item => {
    object(item, '供应商');
    const { id, ...input } = item;
    return { ...provider(input), id: text(id, '供应商 ID', 160) };
  });
  if (new Set(providers.map(item => item.id)).size !== providers.length) fail('供应商 ID 不能重复', 409);
  const catalog = { version: 1, providers, active: null, legacyProviderId: value.legacyProviderId ?? null };
  if (value.active !== null) {
    fields(value.active, ['providerId', 'modelId'], '活动模型');
    const profile = findProvider(catalog, value.active.providerId);
    const selectedModel = findModel(profile, value.active.modelId);
    if (!profile.enabled || !selectedModel.enabled) fail('活动供应商和模型必须启用', 409);
    if (profile.protocol === 'systemone') fail('System One 仅可作为决策模型，不能设为默认聊天模型');
    catalog.active = { providerId: profile.id, modelId: selectedModel.id };
    catalog.legacyProviderId = null;
  }
  if (catalog.legacyProviderId !== null) findProvider(catalog, catalog.legacyProviderId);
  return catalog;
}

function assertSafeIdentities(catalog, priorSecrets = []) {
  const secrets = [...priorSecrets, ...catalog.providers.flatMap(profile => [profile.apiKey, profile.apiKey.trim()]), process.env.TYPESAFE_API_KEY, process.env.HARNESS_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY].filter(secret => typeof secret === 'string' && secret.trim().length > 3).map(secret => secret.trim());
  for (const profile of catalog.providers) {
    for (const identifier of [profile.id, ...profile.models.map(value => value.id)]) {
      if (secrets.some(secret => identifier === secret || secret.length >= 12 && identifier.includes(secret))) fail('供应商和模型 ID 不能包含 API Key，请使用非秘密标识');
    }
  }
}

export function prepareProviderSettings(stored, overrides = {}) {
  object(stored, '设置');
  const { providerCatalog, providerScope: legacyScope = 'workspace', ...flat } = stored;
  const providerScope = providerCatalog && owns(providerCatalog, 'scope') ? providerCatalog.scope : legacyScope;
  if (!['workspace', 'global'].includes(providerScope)) fail('providerScope 必须是 workspace 或 global');
  if (flat.provider === 'demo') flat.provider = 'responses';
  const base = validateSettings({ ...flat, ...Object.fromEntries(['autoApproveTools', 'modelOrchestration'].filter(key => providerCatalog && owns(providerCatalog, key)).map(key => [key, providerCatalog[key]])) });
  let catalog;
  if (providerCatalog !== undefined) {
    catalog = validateCatalog(providerCatalog);
    const modelDefaults = providerCatalog.modelDefaults ?? {};
    fields(modelDefaults, modelKeys, '模型默认值');
    Object.assign(base, Object.fromEntries(modelKeys.filter(key => modelDefaults[key] !== undefined).map(key => [key, validateSettings({ [key]: modelDefaults[key] })[key]])));
  } else {
    catalog = { version: 1, providers: [], active: null, legacyProviderId: null };
    if (connectionKeys.some(key => owns(flat, key))) {
      const migrated = provider({ protocol: base.provider, baseUrl: base.baseUrl, apiKey: base.apiKey, models: base.model ? [{ id: base.model }] : [] });
      catalog.providers.push(migrated);
      if (base.model) catalog.active = { providerId: migrated.id, modelId: base.model };
      else catalog.legacyProviderId = migrated.id;
    }
  }
  const state = { base, catalog };
  assertSafeIdentities(catalog);
  const persisted = structuredClone(snapshot(state, providerScope));
  if (Object.keys(object(overrides, '设置')).length) {
    if (providerScope === 'workspace') legacyPatch(state, overrides);
    else state.base = validateSettings({ ...state.base, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !connectionKeys.includes(key))) });
  }
  state.catalog = validateCatalog(state.catalog);
  assertSafeIdentities(state.catalog);
  return { ...state, providerScope, globalOverrides: providerScope === 'global' ? overrides : {}, persisted, migrated: providerCatalog?.scope === undefined || owns(stored, 'providerScope') || owns(stored, 'maxSteps') || owns(stored, 'maxRunTokens') };
}

export class ProviderCatalog {
  constructor(harness, state, globalConfigDir) {
    this.harness = harness;
    this.workspaceState = { base: state.base, catalog: state.catalog };
    this.activeScope = state.providerScope;
    this.globalStore = new GlobalProviders(globalConfigDir);
    this.globalCatalog = { version: 1, providers: [], active: null, legacyProviderId: null };
    this.globalOverrides = state.globalOverrides;
    this.globalFingerprint = null;
    this.ownedLeases = new Set();
    this.reservations = new Map();
    this.pending = Promise.resolve();
    this.refresh(this.activeScope, false);
    this.harness.settings = projection(this.state);
  }

  get state() { return { base: this.workspaceState.base, catalog: this.activeScope === 'global' ? this.globalCatalog : this.workspaceState.catalog }; }
  scope(value = this.activeScope) { if (!['workspace', 'global'].includes(value)) fail('scope 必须是 workspace 或 global'); return value; }
  secrets() { return [...this.workspaceState.catalog.providers, ...this.globalCatalog.providers].flatMap(profile => [profile.apiKey, apiKeyFor({ provider: profile.protocol, apiKey: profile.apiKey })]); }
  settled() { return this.pending; }

  rememberSecrets() {
    if (!this.harness.redactionSecrets) return;
    for (const secret of this.secrets()) if (secret) { this.harness.redactionSecrets.add(secret); this.harness.redactionSecrets.add(secret.trim()); }
  }

  notify() { this.harness.emit('event', { id: randomUUID(), type: 'settings.updated', timestamp: new Date().toISOString(), data: {} }); }

  refresh(scope = this.activeScope, notify = true) {
    if (this.scope(scope) !== 'global') return;
    const record = this.globalStore.read();
    const fingerprint = JSON.stringify(record.providerCatalog);
    if (fingerprint === this.globalFingerprint) return;
    const previous = this.globalFingerprint;
    const state = { base: this.workspaceState.base, catalog: validateCatalog(record.providerCatalog) };
    if (Object.keys(this.globalOverrides).length) legacyPatch(state, this.globalOverrides);
    assertSafeIdentities(state.catalog, this.harness.redactionSecrets ? this.harness.secrets() : []);
    this.globalCatalog = state.catalog;
    this.globalFingerprint = fingerprint;
    this.harness.settings = projection(this.state);
    this.rememberSecrets();
    if (notify && previous !== null) this.notify();
  }

  publicCatalog(catalog) {
    return this.harness.sanitize({ providers: catalog.providers.map(({ apiKey, ...profile }) => ({ ...profile, hasApiKey: Boolean(apiKeyFor({ provider: profile.protocol, apiKey })), apiKeySource: apiKey.trim() ? 'saved' : apiKeyFor({ provider: profile.protocol, apiKey }) ? 'environment' : 'none' })), active: catalog.active });
  }

  get(scope = this.activeScope) {
    this.refresh(scope);
    return this.publicCatalog(scope === 'global' ? this.globalCatalog : this.workspaceState.catalog);
  }

  scopes() {
    this.refresh('global');
    return { activeScope: this.activeScope, global: this.publicCatalog(this.globalCatalog), workspace: this.publicCatalog(this.workspaceState.catalog) };
  }

  selection() { this.refresh(); return structuredClone(this.state.catalog.active); }

  enqueue(change) {
    const operation = this.pending.then(async () => {
      if (this.harness.closed) fail('青禾 Studio 已关闭', 503);
      return change();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async writeWorkspace(state, scope = this.activeScope) {
    const filename = path.join(this.harness.dataDir, 'settings.json');
    if (await realpath(this.harness.dataDir) !== this.harness.dataDir) fail('配置目录已变更或指向符号链接');
    try { if ((await lstat(filename)).isSymbolicLink()) fail('设置文件不能是符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await atomicJson(filename, snapshot(state, scope));
  }

  setScope(scope) {
    this.scope(scope);
    return this.enqueue(async () => {
      this.refresh('global');
      await this.writeWorkspace(this.workspaceState, scope);
      this.activeScope = scope;
      this.harness.settings = projection(this.state);
      this.notify();
      return this.scopes();
    });
  }

  startWatching() {
    this.watchTimer = setInterval(() => {
      if (this.harness.closed) return;
      try { this.refresh('global'); this.refreshError = null; }
      catch (error) { if (!this.refreshError) this.notify(); this.refreshError = error; }
    }, 500);
    this.watchTimer.unref();
  }

  reserveRun(id) {
    return this.enqueue(async () => {
      const scope = this.activeScope;
      const base = structuredClone(this.workspaceState.base);
      const references = orchestrationReferences(base.modelOrchestration);
      let result;
      const prepare = globalCatalog => {
        const catalogs = { global: globalCatalog, workspace: this.workspaceState.catalog };
        const state = { base, catalog: catalogs[scope] };
        const selected = state.catalog.active;
        const resolve = ref => {
          const profile = findProvider(catalogs[ref.scope], ref.providerId);
          const chosen = findModel(profile, ref.modelId);
          if (!profile.enabled || !chosen.enabled) fail(`模型已禁用：${chosen.id}`);
          const settings = projection({ base, catalog: { ...catalogs[ref.scope], active: { providerId: ref.providerId, modelId: ref.modelId } } });
          assertConfigured(settings);
          settings.apiKey = apiKeyFor(settings);
          return { scope: ref.scope, selection: { providerId: ref.providerId, modelId: ref.modelId }, providerName: profile.name, settings, specialty: ref.specialty || '' };
        };
        const configuration = base.modelOrchestration;
        const primary = selected ? resolve({ scope, ...selected }) : { settings: projection(state), scope, selection: null, providerName: null };
        if (primary.settings.provider === 'systemone') fail('System One 仅可作为决策模型，请选择可生成文本的默认模型');
        const compression = configuration.compressionModel ? resolve(configuration.compressionModel) : null;
        const decision = configuration.decision.enabled || configuration.routing.enabled ? resolve(configuration.decision.model) : null;
        const candidates = configuration.routing.enabled ? configuration.routing.candidates.map(resolve) : [];
        if ([compression, ...candidates].some(item => item?.settings.provider === 'systemone')) fail('System One 不能作为压缩模型或路由执行模型');
        result = { ...primary, orchestration: { compression, decision, candidates }, references: [...new Map([...(selected ? [{ scope, ...selected }] : []), ...references].map(ref => [selectionKey(ref), ref])).values()] };
      };
      if (scope === 'global' || references.some(ref => ref.scope === 'global')) {
        let globalCatalog;
        const transaction = await this.globalStore.transaction(record => {
          const state = { base, catalog: validateCatalog(record.providerCatalog) };
          if (Object.keys(this.globalOverrides).length) legacyPatch(state, this.globalOverrides);
          globalCatalog = state.catalog;
          prepare(globalCatalog);
          for (const ref of result.references.filter(item => item.scope === 'global')) record.runLeases.push({ id, owner: this.harness.lockToken, pid: process.pid, providerId: ref.providerId, modelId: ref.modelId });
        });
        this.globalCatalog = globalCatalog;
        this.globalFingerprint = JSON.stringify(transaction.record.providerCatalog);
        if (result.references.some(ref => ref.scope === 'global')) this.ownedLeases.add(id);
        this.harness.settings = projection(this.state);
        this.rememberSecrets();
      } else prepare(this.globalCatalog);
      this.reservations.set(id, result.references);
      return { ...structuredClone(result), release: () => this.releaseRun(id) };
    });
  }

  async releaseRun(id) {
    this.reservations.delete(id);
    if (!this.ownedLeases.has(id)) return;
    await this.globalStore.transaction(record => { record.runLeases = record.runLeases.filter(lease => lease.id !== id || lease.owner !== this.harness.lockToken); });
    this.ownedLeases.delete(id);
  }

  async close() {
    clearInterval(this.watchTimer);
    if (!this.ownedLeases.size) return;
    await this.globalStore.transaction(record => { record.runLeases = record.runLeases.filter(lease => lease.owner !== this.harness.lockToken); });
    this.ownedLeases.clear();
  }

  assertUnused(providerId, modelId) {
    const matches = selected => selected?.providerId === providerId && (modelId === undefined || selected.modelId === modelId);
    const { scope, draft, leases = [] } = this.mutation;
    if (matches(draft.catalog.active) || [...this.reservations.values()].some(refs => refs.some(ref => ref.scope === scope && matches(ref))) || [...this.harness.activeRuns.values()].some(active => (active.references || [{ scope: active.scope || 'workspace', ...active.selection }]).some(ref => ref.scope === scope && matches(ref))) || scope === 'global' && leases.some(lease => processAlive(lease.pid) && matches(lease))) fail('供应商或模型正在使用，请先切换活动模型并等待相关任务结束', 409);
  }

  mutate(change, scope = this.activeScope, saveBase = false) {
    this.scope(scope);
    return this.enqueue(async () => {
      const update = async (draft, leases = []) => {
        this.mutation = { scope, draft, leases };
        try { change(draft); }
        finally { this.mutation = null; }
        draft.catalog = validateCatalog(draft.catalog);
        assertSafeIdentities(draft.catalog, this.harness.secrets());
        projection(draft);
        if (scope === 'workspace') await this.writeWorkspace(draft);
        return draft;
      };
      if (scope === 'global') {
        const { record, result } = await this.globalStore.transaction(async record => {
          const draft = { base: structuredClone(this.workspaceState.base), catalog: validateCatalog(record.providerCatalog) };
          if (Object.keys(this.globalOverrides).length) legacyPatch(draft, this.globalOverrides);
          await update(draft, record.runLeases);
          record.providerCatalog = draft.catalog;
          return draft;
        }, saveBase ? ({ result }) => this.writeWorkspace({ base: result.base, catalog: this.workspaceState.catalog }) : undefined);
        this.globalOverrides = {};
        this.globalCatalog = result.catalog;
        this.globalFingerprint = JSON.stringify(record.providerCatalog);
        if (saveBase) this.workspaceState.base = result.base;
      } else this.workspaceState = await update(structuredClone(this.workspaceState));
      this.harness.settings = projection(this.state);
      for (const pending of [...this.harness.approvals.values()]) if (this.harness.autoApproves(pending.approval.tool)) pending.settle(true);
      this.rememberSecrets();
      this.notify();
      return this.get(scope);
    });
  }

  async updateSettings(patch) {
    object(patch, '设置');
    const scope = Object.keys(patch).some(key => connectionKeys.includes(key) || modelKeys.includes(key)) ? this.activeScope : 'workspace';
    if (owns(patch, 'modelOrchestration')) this.refresh('global');
    await this.mutate(draft => {
      legacyPatch(draft, patch);
      if (!owns(patch, 'modelOrchestration')) return;
      const config = draft.base.modelOrchestration;
      for (const ref of orchestrationReferences(config)) {
        const catalog = ref.scope === scope ? draft.catalog : ref.scope === 'global' ? this.globalCatalog : this.workspaceState.catalog;
        const profile = findProvider(catalog, ref.providerId);
        const selected = findModel(profile, ref.modelId);
        if (!profile.enabled || !selected.enabled) fail(`模型已禁用：${selected.id}`);
        if (profile.protocol === 'systemone' && (selectionKey(config.compressionModel) === selectionKey(ref) || config.routing.enabled && config.routing.candidates.some(item => selectionKey(item) === selectionKey(ref)))) fail('System One 仅可作为决策模型');
      }
    }, scope, true);
    return this.harness.getSettings();
  }

  createProvider(input, scope) { return this.mutate(draft => { draft.catalog.providers.push(provider(input)); }, scope); }

  updateProvider(providerId, patch, scope) {
    return this.mutate(draft => {
      fields(patch, ['name', 'protocol', 'baseUrl', 'enabled', 'apiKey'], '供应商');
      const current = findProvider(draft.catalog, providerId);
      if (patch.enabled === false) this.assertUnused(providerId);
      Object.assign(current, provider(patch, current));
    }, scope);
  }

  deleteProvider(providerId, scope) {
    return this.mutate(draft => {
      findProvider(draft.catalog, providerId);
      this.assertUnused(providerId);
      draft.catalog.providers = draft.catalog.providers.filter(value => value.id !== providerId);
      if (draft.catalog.legacyProviderId === providerId) draft.catalog.legacyProviderId = null;
    }, scope);
  }

  addModel(providerId, input, scope) { return this.addProviderModels(providerId, [input], scope); }

  addProviderModels(providerId, input, scope) {
    return this.mutate(draft => {
      if (!Array.isArray(input)) fields(input, ['models'], '模型导入');
      const models = Array.isArray(input) ? input : input.models;
      if (!Array.isArray(models) || !models.length || models.length > 1000) fail('请提供 1–1000 个待导入模型');
      const profile = findProvider(draft.catalog, providerId);
      profile.models.push(...models.map(value => model(value)));
    }, scope);
  }

  updateModel(providerId, modelId, patch, scope) {
    return this.mutate(draft => {
      const selected = findModel(findProvider(draft.catalog, providerId), modelId);
      const next = model(patch, selected);
      if (!next.enabled || next.id !== modelId) this.assertUnused(providerId, modelId);
      Object.assign(selected, next);
      for (const key of modelKeys) if (!owns(next, key)) delete selected[key];
    }, scope);
  }

  deleteModel(providerId, modelId, scope) {
    return this.mutate(draft => {
      const profile = findProvider(draft.catalog, providerId);
      findModel(profile, modelId);
      this.assertUnused(providerId, modelId);
      profile.models = profile.models.filter(value => value.id !== modelId);
    }, scope);
  }

  activateModel(providerId, modelId, scope) {
    return this.mutate(draft => {
      if (providerId === null && modelId === null) { draft.catalog.active = null; draft.catalog.legacyProviderId = null; return; }
      const profile = findProvider(draft.catalog, providerId);
      const selected = findModel(profile, modelId);
      if (profile.protocol === 'systemone') fail('System One 仅可作为决策模型，不能设为默认聊天模型');
      if (!profile.enabled || !selected.enabled) fail('请先启用供应商和模型，再设为活动模型', 409);
      draft.catalog.active = { providerId, modelId };
      draft.catalog.legacyProviderId = null;
    }, scope);
  }

  candidate(providerId, options = {}, scope = this.activeScope) {
    this.refresh(scope);
    const state = { base: this.workspaceState.base, catalog: scope === 'global' ? this.globalCatalog : this.workspaceState.catalog };
    fields(options, ['modelId', 'protocol', 'baseUrl', 'apiKey', ...modelKeys, 'signal'], '连接参数');
    const profile = findProvider(state.catalog, providerId);
    const modelId = options.modelId === undefined ? (state.catalog.active?.providerId === providerId ? state.catalog.active.modelId : profile.models.find(value => value.enabled)?.id) ?? '' : options.modelId;
    if (typeof modelId !== 'string') fail('模型 ID 必须是字符串');
    const selectedModel = profile.models.find(value => value.id === modelId);
    return validateSettings({ ...state.base, ...((options.protocol || profile.protocol) === 'systemone' ? { reasoning: { mode: 'default' } } : {}), provider: options.protocol === undefined ? profile.protocol : options.protocol, baseUrl: options.baseUrl === undefined ? profile.baseUrl : options.baseUrl, apiKey: options.apiKey === undefined ? profile.apiKey : options.apiKey, model: modelId, ...Object.fromEntries(modelKeys.filter(key => selectedModel?.[key] !== undefined).map(key => [key, selectedModel[key]])), ...Object.fromEntries(modelKeys.filter(key => options[key] !== undefined).map(key => [key, options[key]])) });
  }

  async testProviderConnection(providerId, options = {}, scope) {
    const candidate = this.candidate(providerId, options, scope);
    return redact({ ...await this.harness.testConnection(candidate, { signal: options.signal }), providerId, modelId: candidate.model }, [...this.harness.secrets(), candidate.apiKey, apiKeyFor(candidate)]);
  }

  async discoverProviderModels(providerId, options = {}, scope) {
    if (this.harness.closed) fail('青禾 Studio 已关闭', 503);
    const candidate = this.candidate(providerId, options, scope);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const check = { controller, done: null };
    const secrets = [...this.harness.secrets(), candidate.apiKey, apiKeyFor(candidate)];
    this.harness.connectionChecks.add(check);
    check.done = (async () => {
      try { return redact(await discoverModels(candidate, signal, value => redact(value, secrets)), secrets); }
      catch (error) {
        const message = redact(error.message || String(error), secrets);
        throw Object.assign(new Error(message), { statusCode: signal.aborted ? 499 : error.name === 'TimeoutError' ? 504 : error.statusCode ?? 502, name: signal.aborted ? 'AbortError' : error.name });
      } finally { this.harness.connectionChecks.delete(check); }
    })();
    return check.done;
  }
}

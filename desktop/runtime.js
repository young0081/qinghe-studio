import { EventEmitter } from 'node:events';
import path from 'node:path';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { createHarness as createCoreHarness } from '../src/core/harness.js';
import { atomicJson } from '../src/core/settings.js';
import { VERSION } from '../src/version.js';

const copy = value => structuredClone(value);
const activeStatuses = new Set(['running', 'waiting_approval', 'waiting_input']);
const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const samePath = (first, second) => process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;

function cleanError(error) {
  return String(error?.message || error || '未知错误').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 800);
}

export function parseLaunchArguments(argumentsList, workingDirectory = process.cwd()) {
  const result = {};
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    const match = /^--(workspace|user-data)(?:=(.*))?$/.exec(argument);
    if (!match) continue;
    const value = match[2] ?? argumentsList[++index];
    if (!value || value.startsWith('--')) throw new Error(`${match[1]} 需要目录路径`);
    const key = match[1] === 'workspace' ? 'workspace' : 'userData';
    if (result[key]) throw new Error(`${match[1]} 只能指定一次`);
    result[key] = path.resolve(workingDirectory, value);
  }
  return result;
}

export function sanitizeWindowBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isInteger) || width < 400 || height < 300 || width > 10000 || height > 10000) return null;
  return { x, y, width, height };
}

export function visibleWindowBounds(saved, workAreas) {
  const areas = workAreas.filter(area => area && Number.isFinite(area.width) && Number.isFinite(area.height) && area.width > 0 && area.height > 0);
  const fallback = areas[0] || { x: 0, y: 0, width: 1280, height: 800 };
  const bounds = sanitizeWindowBounds(saved);
  const area = bounds && areas.find(candidate => Math.min(bounds.x + bounds.width, candidate.x + candidate.width) - Math.max(bounds.x, candidate.x) > 100 && Math.min(bounds.y + bounds.height, candidate.y + candidate.height) - Math.max(bounds.y, candidate.y) > 100) || fallback;
  const width = Math.min(bounds?.width || 1320, area.width);
  const height = Math.min(bounds?.height || 860, area.height);
  return {
    x: bounds ? Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)) : Math.round(area.x + (area.width - width) / 2),
    y: bounds ? Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) : Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

export function isTrustedRenderer(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || window.webContents.isDestroyed()) return false;
  const frame = event.senderFrame;
  const mainFrame = window.webContents.mainFrame;
  if (!frame || !mainFrame || frame !== mainFrame || frame.routingId !== mainFrame.routingId || frame.processId !== mainFrame.processId) return false;
  try {
    const url = new URL(frame.url);
    return url.origin === origin && ['/', '/index.html'].includes(url.pathname);
  } catch { return false; }
}

class DesktopRuntime extends EventEmitter {
  constructor(userData, factory, preferences, preferencesError) {
    super();
    this.userData = userData;
    this.factory = factory;
    this.preferences = preferences;
    this.activeHarness = null;
    this.retiredHarnesses = new Set();
    this.relay = event => this.emit('event', event);
    this.operations = Promise.resolve();
    this.persistence = Promise.resolve();
    this.closed = false;
    this.automationPorts = new Set();
    this.desktopPresentation = null;
    this.state = { status: preferencesError ? 'error' : 'idle', workspace: null, recentWorkspaces: [...preferences.recentWorkspaces], maximized: preferences.maximized, version: VERSION, ...(preferencesError ? { error: preferencesError } : {}) };
  }

  get workspace() { return this.activeHarness?.workspace || null; }
  get extensions() { return this.assertReady().extensions || []; }
  listSkills() { return this.assertReady().listSkills(); }
  getSkill(name) { return this.assertReady().getSkill(name); }
  importSkill(input) { return this.assertReady().importSkill(input); }
  updateSkill(name, input) { return this.assertReady().updateSkill(name, input); }
  deleteSkill(name) { return this.assertReady().deleteSkill(name); }
  getMcp() { return this.assertReady().getMcp(); }
  saveMcp(name, input, create) { return this.assertReady().saveMcp(name, input, create); }
  importMcp(input) { return this.assertReady().importMcp(input); }
  deleteMcp(name) { return this.assertReady().deleteMcp(name); }
  reconnectMcp(name) { return this.assertReady().reconnectMcp(name); }
  reloadMcp() { return this.assertReady().reloadMcp(); }
  getState() { return copy(this.state); }
  getLastWorkspace() { return this.preferences.lastWorkspace; }
  getWindowBounds() { return copy(this.preferences.windowBounds); }

  assertReady() {
    if (this.closed) throw failure('桌面工作台已关闭', 503);
    if (!this.activeHarness || this.activeHarness.closed || this.state.status !== 'ready') throw failure(this.state.status === 'loading' ? '正在切换工作区，请稍候' : '请先选择一个工作区');
    return this.activeHarness;
  }

  updateState(patch) {
    this.state = { ...this.state, ...patch };
    if (this.state.error === undefined) delete this.state.error;
    this.emit('state', this.getState());
    return this.getState();
  }

  serialize(operation) {
    const pending = this.operations.catch(() => {}).then(operation);
    this.operations = pending.catch(() => {});
    return pending;
  }

  savePreferences() {
    const snapshot = copy(this.preferences);
    this.persistence = this.persistence.catch(() => {}).then(() => atomicJson(path.join(this.userData, 'desktop-settings.json'), snapshot));
    return this.persistence;
  }

  async updateWindowState(bounds, maximized) {
    const valid = sanitizeWindowBounds(bounds);
    if (valid) this.preferences.windowBounds = valid;
    if (typeof maximized === 'boolean') {
      this.preferences.maximized = maximized;
      if (maximized !== this.state.maximized) this.updateState({ maximized });
    }
    await this.savePreferences();
  }

  activeWork() {
    if (!this.activeHarness || this.activeHarness.closed) return [];
    return this.activeHarness.listSessions().filter(session => activeStatuses.has(session.run?.status));
  }

  async canonicalWorkspace(directory) {
    if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw failure('请选择有效的工作区目录', 400);
    const resolved = await realpath(path.resolve(directory));
    if (!(await stat(resolved)).isDirectory()) throw failure('工作区必须是目录', 400);
    return resolved;
  }

  openWorkspace(directory, { confirmStop = async () => true } = {}) {
    return this.serialize(async () => {
      if (this.closed) throw failure('桌面工作台已关闭', 503);
      const before = this.getState();
      this.updateState({ status: 'loading', error: undefined });
      let candidate;
      try {
        const canonical = await this.canonicalWorkspace(directory);
        if (this.activeHarness && !this.activeHarness.closed && samePath(this.workspace, canonical)) return this.updateState({ status: 'ready', error: undefined });
        const active = this.activeWork();
        if (active.length && !await confirmStop({ reason: 'switch', workspace: this.workspace, nextWorkspace: canonical, count: active.length })) return this.updateState({ status: before.status, error: before.error });
        candidate = await this.factory({ workspace: canonical });
        for (const port of this.automationPorts) candidate.protectAutomationPort?.(port);
        candidate.automation?.setDesktopPresentation(this.desktopPresentation);
      } catch (error) {
        if (candidate) await candidate.close().catch(() => {});
        const detail = error.code === 'ENOENT' ? '目录不存在，请重新选择或检查磁盘连接。' : cleanError(error);
        return this.updateState({ status: this.activeHarness && !this.activeHarness.closed ? 'ready' : 'error', workspace: this.workspace, error: `无法打开工作区：${detail}` });
      }
      const previous = this.activeHarness;
      let warning;
      if (previous) {
        try { await previous.close(); }
        catch (error) { this.retiredHarnesses.add(previous); warning = `新工作区已打开，但关闭旧工作区失败：${cleanError(error)}`; }
        previous.off('event', this.relay);
      }
      this.activeHarness = candidate;
      candidate.on('event', this.relay);
      this.preferences.lastWorkspace = candidate.workspace;
      this.preferences.recentWorkspaces = [candidate.workspace, ...this.preferences.recentWorkspaces.filter(item => !samePath(item, candidate.workspace))].slice(0, 10);
      try { await this.savePreferences(); }
      catch (error) { warning = `工作区已打开，但无法保存最近项目：${cleanError(error)}`; }
      return this.updateState({ status: 'ready', workspace: candidate.workspace, recentWorkspaces: [...this.preferences.recentWorkspaces], error: warning });
    });
  }

  openRecentWorkspace(directory, options) {
    if (typeof directory !== 'string' || !this.preferences.recentWorkspaces.some(item => samePath(item, directory))) throw failure('只能打开最近项目列表中已有的工作区', 403);
    return this.openWorkspace(directory, options);
  }

  shutdown({ confirmStop = async () => true } = {}) {
    return this.serialize(async () => {
      if (this.closed) return true;
      const before = this.getState();
      this.updateState({ status: 'loading', error: undefined });
      const active = this.activeWork();
      try {
        if (active.length && !await confirmStop({ reason: 'close', workspace: this.workspace, count: active.length })) {
          this.updateState({ status: before.status, error: before.error });
          return false;
        }
        if (this.activeHarness) {
          await this.activeHarness.close();
          this.activeHarness.off('event', this.relay);
          this.activeHarness = null;
        }
        for (const harness of this.retiredHarnesses) await harness.close().catch(() => {});
        this.retiredHarnesses.clear();
        await this.savePreferences();
        this.closed = true;
        this.updateState({ status: 'idle', workspace: null, error: undefined });
        return true;
      } catch (error) {
        this.updateState({ status: this.activeHarness && !this.activeHarness.closed ? 'ready' : 'error', workspace: this.workspace, error: `关闭工作区失败：${cleanError(error)}` });
        throw error;
      }
    });
  }

  close() { return this.shutdown(); }
  getSettings() { return this.assertReady().getSettings(); }
  updateSettings(patch) { return this.assertReady().updateSettings(patch); }
  testConnection(patch) { return this.assertReady().testConnection(patch); }
  getProviderCatalog(scope) { return this.assertReady().getProviderCatalog(scope); }
  getProviderScopes() { return this.assertReady().getProviderScopes(); }
  setProviderScope(scope) { return this.assertReady().setProviderScope(scope); }
  createProvider(input, scope) { return this.assertReady().createProvider(input, scope); }
  updateProvider(id, patch, scope) { return this.assertReady().updateProvider(id, patch, scope); }
  deleteProvider(id, scope) { return this.assertReady().deleteProvider(id, scope); }
  addProviderModels(id, input, scope) { return this.assertReady().addProviderModels(id, input, scope); }
  updateModel(providerId, modelId, patch, scope) { return this.assertReady().updateModel(providerId, modelId, patch, scope); }
  deleteModel(providerId, modelId, scope) { return this.assertReady().deleteModel(providerId, modelId, scope); }
  activateModel(providerId, modelId, scope) { return this.assertReady().activateModel(providerId, modelId, scope); }
  testProviderConnection(id, input, scope) { return this.assertReady().testProviderConnection(id, input, scope); }
  discoverProviderModels(id, options, scope) { return this.assertReady().discoverProviderModels(id, options, scope); }
  listSessions() { return this.assertReady().listSessions(); }
  createSession(options) { return this.assertReady().createSession(options); }
  forkSession(id, options) { return this.assertReady().forkSession(id, options); }
  getSession(id) { return this.assertReady().getSession(id); }
  deleteSession(id) { return this.assertReady().deleteSession(id); }
  run(id, prompt, options) { return this.assertReady().run(id, prompt, options); }
  importAttachment(input) { return this.assertReady().importAttachment(input); }
  getAttachment(id) { return this.assertReady().getAttachment(id); }
  attachmentContent(id, thumbnail) { return this.assertReady().attachmentContent(id, thumbnail); }
  deleteAttachment(id) { return this.assertReady().deleteAttachment(id); }
  cancelRun(id) { return this.assertReady().cancelRun(id); }
  resolveApproval(id, approved) { return this.assertReady().resolveApproval(id, approved); }
  getQuestions() { return this.assertReady().getQuestions(); }
  answerQuestion(id, answer) { return this.assertReady().answerQuestion(id, answer); }
  restoreCheckpoint(id, checkpointId) { return this.assertReady().restoreCheckpoint(id, checkpointId); }
  listFiles(relative) { return this.assertReady().listFiles(relative); }
  readFile(relative) { return this.assertReady().readFile(relative); }
  getTools() { return this.assertReady().getTools(); }
  getToolPolicies() { return this.assertReady().getToolPolicies(); }
  getAutomation() { return this.assertReady().getAutomation(); }
  configureAutomation(patch) { return this.assertReady().configureAutomation(patch); }
  stopAutomation() { return this.assertReady().stopAutomation(); }
  getScreenshot(id) { return this.assertReady().getScreenshot(id); }
  getBrowserLive() { return this.assertReady().automation.getBrowserLive(); }
  getBrowserFrame() { return this.assertReady().automation.getBrowserFrame(); }
  setDesktopPresentation(hook) {
    this.desktopPresentation = hook;
    this.activeHarness?.automation?.setDesktopPresentation(hook);
  }
  protectAutomationPort(port) { this.automationPorts.add(port); this.activeHarness?.protectAutomationPort(port); }
}

export async function createDesktopRuntime({ userData, globalConfigDir, createHarness = createCoreHarness } = {}) {
  if (typeof userData !== 'string' || !userData) throw new Error('需要明确的桌面应用数据目录');
  if (typeof createHarness !== 'function') throw new Error('createHarness 必须是函数');
  const location = path.resolve(userData);
  await mkdir(location, { recursive: true });
  let stored = {};
  let preferencesError;
  try { stored = JSON.parse(await readFile(path.join(location, 'desktop-settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') preferencesError = '桌面偏好文件无法读取；请选择工作区重新开始。'; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  const recentWorkspaces = Array.isArray(stored.recentWorkspaces) ? [...new Set(stored.recentWorkspaces.filter(item => typeof item === 'string' && path.isAbsolute(item)))].slice(0, 10) : [];
  const lastWorkspace = typeof stored.lastWorkspace === 'string' && path.isAbsolute(stored.lastWorkspace) ? stored.lastWorkspace : null;
  const factory = options => createHarness({ ...options, ...(globalConfigDir ? { globalConfigDir } : {}) });
  return new DesktopRuntime(location, factory, { recentWorkspaces, lastWorkspace, windowBounds: sanitizeWindowBounds(stored.windowBounds), maximized: stored.maximized === true }, preferencesError);
}

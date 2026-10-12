import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, screen, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { externalHttpUrl } from '../src/core/links.js';
import { createDesktopRuntime, isTrustedRenderer, parseLaunchArguments, visibleWindowBounds } from './runtime.js';
import { OrbState, orbBounds } from './orb-state.js';

app.setName('青禾 Studio');
app.setAppUserModelId('dev.harness.studio');

let launchOptions = {};
let launchError;
try { launchOptions = parseLaunchArguments(process.argv.slice(1)); }
catch (error) { launchError = error; }
const userData = launchOptions.userData || path.join(app.getPath('appData'), 'Harness Studio');
try { mkdirSync(userData, { recursive: true }); app.setPath('userData', userData); app.setPath('sessionData', userData); }
catch (error) { launchError = error; }

const hasInstanceLock = app.requestSingleInstanceLock({ workspace: launchOptions.workspace || null });
let window;
let runtime;
let backend;
let trustedOrigin;
let closingPromise;
let chooserPromise;
let externalLinkPromise;
let pendingWorkspace;
let shutdownComplete = false;
let unsavedChanges = false;
let boundsTimer;
let orbWindow;
let orbPromise;
let desktopSession;
let collapsed = false;
let presentingDesktop = false;
let restoreAfterDesktop = false;
let backgroundTimer;
let orbWorkspace;
const orbState = new OrbState();
const captureExclusionSupported = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 19041;
const icon = fileURLToPath(new URL('./assets/icon.png', import.meta.url));
const preload = fileURLToPath(new URL('./preload.cjs', import.meta.url));

function trustedDocument(location) {
  try { const url = new URL(location); return url.origin === trustedOrigin && ['/', '/index.html'].includes(url.pathname); }
  catch { return false; }
}

function focusWindow() {
  if (!window || window.isDestroyed()) return;
  if (presentingDesktop) { restoreAfterDesktop = true; return; }
  collapsed = false;
  if (orbWindow && !orbWindow.isDestroyed()) orbWindow.hide();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function sendOrbState() {
  if (orbWindow && !orbWindow.isDestroyed() && trustedDocument(orbWindow.webContents.getURL())) orbWindow.webContents.send('harness-desktop:orb-state', orbState.snapshot());
}

function windowIsInBackground() {
  return window && !window.isDestroyed() && !window.isFocused() && !window.webContents.isDevToolsFocused() && !orbWindow?.isFocused() && !chooserPromise && !closingPromise && !externalLinkPromise;
}

function secureOrbWindow(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, location) => { if (!trustedDocument(location) || new URL(location).hash !== '#orb') event.preventDefault(); });
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
}

async function ensureOrb() {
  if (orbPromise) return orbPromise;
  if (orbWindow && !orbWindow.isDestroyed()) return orbWindow;
  orbPromise = (async () => {
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    orbWindow = new BrowserWindow({
      ...orbBounds({ x: area.x + area.width - 144, y: area.y + area.height - 152, width: 132, height: 132 }, area),
      title: '青禾 Studio · 悬浮球', icon, frame: false, transparent: true, hasShadow: false, show: false,
      resizable: false, maximizable: false, minimizable: false, skipTaskbar: true, alwaysOnTop: true,
      backgroundColor: '#00000000', autoHideMenuBar: true,
      webPreferences: { preload, session: desktopSession, additionalArguments: ['--harness-surface=orb'], contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: !app.isPackaged, backgroundThrottling: false },
    });
    orbWindow.setAlwaysOnTop(true, 'floating');
    orbWindow.setContentProtection(true);
    secureOrbWindow(orbWindow.webContents);
    orbWindow.on('close', event => { if (!shutdownComplete) { event.preventDefault(); focusWindow(); } });
    orbWindow.on('closed', () => { orbWindow = null; });
    orbWindow.webContents.on('render-process-gone', () => {
      const crashed = orbWindow;
      focusWindow();
      if (crashed && !crashed.isDestroyed()) crashed.destroy();
    });
    await orbWindow.loadURL(`${trustedOrigin}/#orb`);
    return orbWindow;
  })().finally(() => { orbPromise = null; });
  return orbPromise;
}

async function collapseWindow() {
  if (shutdownComplete || !window || window.isDestroyed()) return;
  collapsed = true;
  window.hide();
  try {
    const orb = await ensureOrb();
    sendOrbState();
    if (collapsed && !presentingDesktop && !shutdownComplete) orb.showInactive();
  } catch (error) {
    focusWindow();
    throw error;
  }
}

async function desktopPresentation(phase) {
  if (phase === 'before') {
    presentingDesktop = true;
    await collapseWindow();
    if (orbWindow && !orbWindow.isDestroyed()) {
      orbWindow.setIgnoreMouseEvents(true);
      orbWindow.setFocusable(false);
      if (captureExclusionSupported) orbWindow.showInactive();
      else orbWindow.hide();
    }
    await new Promise(resolve => setTimeout(resolve, 90));
  } else {
    presentingDesktop = false;
    if (orbWindow && !orbWindow.isDestroyed()) { orbWindow.setIgnoreMouseEvents(false); orbWindow.setFocusable(true); }
    if (restoreAfterDesktop) { restoreAfterDesktop = false; focusWindow(); }
    else if (collapsed && orbWindow && !orbWindow.isDestroyed() && !shutdownComplete) { sendOrbState(); orbWindow.showInactive(); }
  }
}

function registerOrbBridge() {
  const handlers = {
    'get-orb-state': () => orbState.snapshot(),
    'restore-window': () => { focusWindow(); },
    'move-orb': input => {
      const bounds = orbWindow.getBounds();
      const next = { ...bounds, x: bounds.x + input.dx, y: bounds.y + input.dy };
      orbWindow.setBounds(orbBounds(next, screen.getDisplayMatching(next).workArea, { snap: input.finish }));
    },
    'resize-orb': input => {
      const bounds = orbWindow.getBounds();
      const width = input.expanded ? 396 : 132;
      const height = input.expanded ? Math.round(input.height) : 132;
      const next = { x: bounds.x + bounds.width - width, y: bounds.y + bounds.height - height, width, height };
      orbWindow.setBounds(orbBounds(next, screen.getDisplayMatching(bounds).workArea));
    },
    'answer-question': (id, answer) => runtime.answerQuestion(id, { answer }),
    'resolve-orb-approval': (id, approved) => runtime.resolveApproval(id, approved),
    'cancel-orb-run': id => runtime.cancelRun(id),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`harness-desktop:${name}`, (event, ...args) => {
      if (!isTrustedRenderer(event, orbWindow, trustedOrigin) || new URL(event.senderFrame.url).hash !== '#orb') throw new Error('拒绝不受信任的悬浮球请求');
      const input = args[0];
      if (name === 'move-orb') {
        if (args.length !== 1 || !input || Object.keys(input).some(key => !['dx', 'dy', 'finish'].includes(key)) || !Number.isFinite(input.dx) || !Number.isFinite(input.dy) || Math.abs(input.dx) > 2000 || Math.abs(input.dy) > 2000 || typeof input.finish !== 'boolean') throw new Error('无效的悬浮球位置');
      } else if (name === 'resize-orb') {
        if (args.length !== 1 || !input || Object.keys(input).some(key => !['expanded', 'height'].includes(key)) || typeof input.expanded !== 'boolean' || !Number.isFinite(input.height) || input.height < 132 || input.height > 680) throw new Error('无效的悬浮球尺寸');
      } else if (name === 'answer-question') {
        if (args.length !== 2 || typeof input !== 'string' || !orbState.questions.has(input) || typeof args[1] !== 'string' || !args[1].trim() || args[1].length > 8000) throw new Error('问题已失效或回答无效');
      } else if (name === 'resolve-orb-approval') {
        if (args.length !== 2 || typeof input !== 'string' || !orbState.approvals.has(input) || typeof args[1] !== 'boolean') throw new Error('审批已失效或参数无效');
      } else if (name === 'cancel-orb-run') {
        if (args.length !== 1 || !runtime.activeWork().some(item => item.id === input)) throw new Error('任务已结束');
      } else if (args.length) throw new Error('悬浮球操作不接受额外参数');
      return handler(...args);
    });
  }
}

async function showError(message) {
  const options = { type: 'error', title: '青禾 Studio', message: '工作区操作未完成', detail: String(message), buttons: ['知道了'], noLink: true };
  if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options);
  else await dialog.showMessageBox(options);
}

async function confirmStop({ reason, workspace, count }) {
  const options = {
    type: 'question', title: '青禾 Studio', message: reason === 'switch' ? '停止当前任务并切换工作区？' : '停止当前任务并关闭窗口？',
    detail: `${workspace}\n还有 ${count} 个任务正在运行或等待审批。继续将取消这些任务并保存会话记录。`,
    buttons: ['继续当前任务', reason === 'switch' ? '停止并切换' : '停止并关闭'], defaultId: 0, cancelId: 0, noLink: true,
  };
  const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

function unsavedOptions(reason) {
  const action = reason === 'switch' ? '切换工作区' : reason === 'reload' ? '重新加载界面' : '关闭窗口';
  return { type: 'question', title: '青禾 Studio', message: `放弃未保存的更改并${action}？`, detail: '当前供应商、模型或运行策略还有未保存的编辑。继续将放弃这些编辑，已保存的设置与会话不受影响。', buttons: ['继续编辑', `放弃并${action}`], defaultId: 0, cancelId: 0, noLink: true };
}

async function confirmUnsavedTransition(reason) {
  if (!unsavedChanges) return confirmStop;
  const options = unsavedOptions(reason);
  const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (result.response !== 1) return null;
  const active = runtime?.activeWork() || [];
  if (active.length && !await confirmStop({ reason, workspace: runtime.workspace, count: active.length })) return null;
  const approved = new Set(active.map(session => session.run.id));
  return details => runtime.activeWork().some(session => !approved.has(session.run.id)) ? confirmStop(details) : Promise.resolve(true);
}

async function rememberWindow() {
  if (!runtime || !window || window.isDestroyed() || runtime.closed) return;
  await runtime.updateWindowState(window.getNormalBounds(), window.isMaximized());
}

function scheduleBoundsSave() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => { void rememberWindow().catch(() => {}); }, 250);
}

async function requestClose({ force = false } = {}) {
  if (shutdownComplete) { app.quit(); return; }
  if (closingPromise) return closingPromise;
  closingPromise = (async () => {
    clearTimeout(boundsTimer);
    try {
      const confirm = force ? async () => true : await confirmUnsavedTransition('close');
      if (!confirm) return;
      await rememberWindow();
      if (runtime && !await runtime.shutdown({ confirmStop: confirm })) return;
      if (backend) await backend.close();
      shutdownComplete = true;
      unsavedChanges = false;
      clearTimeout(backgroundTimer);
      if (orbWindow && !orbWindow.isDestroyed()) orbWindow.destroy();
      if (window && !window.isDestroyed()) window.close();
      app.quit();
    } catch (error) {
      if (force) { app.exit(1); return; }
      const options = { type: 'error', title: '青禾 Studio', message: '无法完成保存或关闭', detail: String(error.message || error), buttons: ['保留窗口', '退出应用'], defaultId: 0, cancelId: 0, noLink: true };
      const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (result.response === 1) { await backend?.close().catch(() => {}); app.exit(1); }
    }
  })().finally(() => { closingPromise = null; });
  return closingPromise;
}

async function openWorkspace(directory, { recent = false } = {}) {
  if (typeof directory === 'string' && runtime.workspace && (process.platform === 'win32' ? path.resolve(directory).toLowerCase() === runtime.workspace.toLowerCase() : path.resolve(directory) === runtime.workspace)) return runtime.getState();
  const confirm = await confirmUnsavedTransition('switch');
  if (!confirm) return runtime.getState();
  const state = recent ? await runtime.openRecentWorkspace(directory, { confirmStop: confirm }) : await runtime.openWorkspace(directory, { confirmStop: confirm });
  if (state.error) await showError(state.error);
  return state;
}

async function chooseWorkspace() {
  if (chooserPromise) return chooserPromise;
  chooserPromise = (async () => {
    const options = { title: '选择工作区', buttonLabel: '打开工作区', properties: ['openDirectory'], ...(runtime.workspace ? { defaultPath: runtime.workspace } : {}) };
    const selected = await dialog.showOpenDialog(window, options);
    if (selected.canceled || !selected.filePaths.length) return runtime.getState();
    return openWorkspace(selected.filePaths[0]);
  })().finally(() => { chooserPromise = null; });
  return chooserPromise;
}

function registerBridge() {
  const handlers = {
    'get-state': () => runtime.getState(),
    'set-unsaved-changes': value => { if (!shutdownComplete) unsavedChanges = value; },
    'choose-workspace': () => chooseWorkspace(),
    'open-recent-workspace': directory => openWorkspace(directory, { recent: true }),
    'open-external': async value => {
      const url = externalHttpUrl(value);
      if (!url) throw new Error('只允许不含用户名和密码的 HTTP(S) 链接');
      if (externalLinkPromise) return false;
      externalLinkPromise = (async () => {
        const result = await dialog.showMessageBox(window, { type: 'question', title: '青禾 Studio', message: '在系统浏览器打开外部链接？', detail: `${url}\n\n请确认目标地址可信。`, buttons: ['取消', '打开链接'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1 || shutdownComplete || !window || window.isDestroyed()) return false;
        await shell.openExternal(url);
        return true;
      })().finally(() => { externalLinkPromise = null; });
      return externalLinkPromise;
    },
    'reveal-workspace': async () => {
      const workspace = runtime.assertReady().workspace;
      const error = await shell.openPath(workspace);
      if (error) throw new Error(`无法在文件管理器中打开工作区：${error}`);
    },
    minimize: () => { window.minimize(); },
    'toggle-maximize': async () => {
      if (window.isMaximized()) window.unmaximize(); else window.maximize();
      await rememberWindow();
      return runtime.getState();
    },
    close: () => { window.close(); },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`harness-desktop:${name}`, (event, ...args) => {
      if (!isTrustedRenderer(event, window, trustedOrigin)) throw new Error('拒绝不受信任的桌面请求');
      if (name === 'open-recent-workspace') {
        if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('需要最近工作区路径');
      } else if (name === 'open-external') {
        if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('需要单个 HTTP(S) 链接');
      } else if (name === 'set-unsaved-changes') {
        if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('未保存状态必须是单个布尔值');
      } else if (args.length) throw new Error('桌面操作不接受额外参数');
      return handler(...args);
    });
  }
}

function applicationMenu() {
  const open = () => { void chooseWorkspace().catch(error => showError(error.message)); };
  const entries = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: [{ label: '打开工作区…', accelerator: 'CmdOrCtrl+Shift+O', click: open }, { type: 'separator' }, { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', click: () => { void requestClose(); } }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(entries));
}

function secureSession(desktopSession, token) {
  desktopSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    try { callback({ cancel: new URL(details.url).origin !== trustedOrigin }); }
    catch { callback({ cancel: true }); }
  });
  desktopSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    try {
      const trustedContents = [window, orbWindow].some(candidate => candidate && !candidate.isDestroyed() && details.webContentsId === candidate.webContents.id);
      if (new URL(details.url).origin !== trustedOrigin || !trustedContents) { callback({ cancel: true }); return; }
      callback({ requestHeaders: { ...details.requestHeaders, 'X-Harness-Token': token } });
    } catch { callback({ cancel: true }); }
  });
  const allowClipboard = (contents, permission) => Boolean(window && !window.isDestroyed() && contents === window.webContents && trustedDocument(contents.getURL()) && permission === 'clipboard-sanitized-write');
  desktopSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowClipboard(contents, permission)));
  desktopSession.setPermissionCheckHandler((contents, permission) => allowClipboard(contents, permission));
  desktopSession.setDevicePermissionHandler(() => false);
  desktopSession.on('will-download', event => event.preventDefault());
}

async function createWindow() {
  const token = randomBytes(32).toString('hex');
  runtime = await createDesktopRuntime({ userData: app.getPath('userData'), globalConfigDir: process.env.HARNESS_CONFIG_DIR || (launchOptions.userData ? path.join(launchOptions.userData, 'shared-config') : undefined) });
  runtime.setDesktopPresentation(desktopPresentation);
  backend = await startServer({ harness: runtime, host: '127.0.0.1', port: 0, authToken: token });
  trustedOrigin = new URL(backend.url).origin;
  desktopSession = session.fromPartition('persist:harness-studio');
  secureSession(desktopSession, token);
  const areas = screen.getAllDisplays().map(display => display.workArea);
  const bounds = visibleWindowBounds(runtime.getWindowBounds(), areas);
  window = new BrowserWindow({
    ...bounds, minWidth: Math.min(860, bounds.width), minHeight: Math.min(560, bounds.height), title: '青禾 Studio', icon,
    frame: false, show: false, backgroundColor: '#f3eedf', autoHideMenuBar: true,
    webPreferences: { preload, session: desktopSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: !app.isPackaged },
  });
  window.setBounds(bounds);
  if (process.platform === 'win32') {
    const actual = window.getNormalBounds();
    const corrected = { ...bounds };
    for (const dimension of ['x', 'y', 'width', 'height']) {
      const difference = actual[dimension] - bounds[dimension];
      if (Math.abs(difference) <= 16) corrected[dimension] -= difference;
    }
    if (Object.keys(bounds).some(dimension => corrected[dimension] !== bounds[dimension])) window.setBounds(corrected);
  }
  registerBridge();
  registerOrbBridge();
  applicationMenu();
  runtime.on('state', state => {
    if (state.workspace !== orbWorkspace) {
      orbWorkspace = state.workspace;
      orbState.reset();
      sendOrbState();
      if (collapsed) focusWindow();
    }
    if (!window || window.isDestroyed()) return;
    window.setTitle(state.workspace ? `${path.basename(state.workspace)} · 青禾 Studio` : '青禾 Studio');
    if (trustedDocument(window.webContents.getURL())) window.webContents.send('harness-desktop:state', state);
  });
  runtime.on('event', event => {
    orbState.apply(event);
    sendOrbState();
    if (event.type === 'tool.started' && event.data?.name === 'computer') void collapseWindow().catch(error => showError(error.message));
    if (event.type === 'run.started' && (window.isMinimized() || !window.isVisible() || windowIsInBackground())) void collapseWindow().catch(error => showError(error.message));
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, location) => { if (!trustedDocument(location)) event.preventDefault(); });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    if (shutdownComplete) { event.preventDefault(); return; }
    if (dialog.showMessageBoxSync(window, unsavedOptions('reload')) === 1) { unsavedChanges = false; event.preventDefault(); }
    else unsavedChanges = true;
  });
  window.webContents.on('context-menu', (_event, parameters) => {
    const editable = parameters.isEditable;
    const privateInput = parameters.inputFieldType === 'password';
    const template = [
      ...(editable ? [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }] : []),
      ...(editable && !privateInput ? [{ role: 'cut' }] : []),
      ...(!privateInput && parameters.selectionText ? [{ role: 'copy' }] : []),
      ...(editable ? [{ role: 'paste' }, { role: 'selectAll' }] : []),
    ];
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  });
  window.webContents.on('render-process-gone', () => {
    if (shutdownComplete) return;
    unsavedChanges = false;
    void dialog.showMessageBox(window, { type: 'error', title: '青禾 Studio', message: '界面进程已停止', detail: '会话保存在工作区中。可以重新加载界面或关闭应用。', buttons: ['重新加载', '关闭应用'], defaultId: 0, cancelId: 1, noLink: true }).then(result => {
      if (result.response === 0 && window && !window.isDestroyed()) void window.loadURL(backend.url);
      else void requestClose();
    });
  });
  window.on('resize', scheduleBoundsSave);
  window.on('minimize', () => { if (runtime.activeWork().length) void collapseWindow().catch(error => showError(error.message)); });
  window.on('blur', () => {
    clearTimeout(backgroundTimer);
    backgroundTimer = setTimeout(() => {
      if (shutdownComplete || collapsed || presentingDesktop || !windowIsInBackground() || !runtime.activeWork().length) return;
      void collapseWindow().catch(error => showError(error.message));
    }, 180);
  });
  window.on('move', scheduleBoundsSave);
  window.on('maximize', () => { void rememberWindow().catch(() => {}); });
  window.on('unmaximize', () => { void rememberWindow().catch(() => {}); });
  window.on('close', event => { if (!shutdownComplete) { event.preventDefault(); void requestClose(); } });
  window.on('closed', () => { window = null; if (!shutdownComplete) void requestClose({ force: true }); });
  window.once('ready-to-show', () => {
    if (runtime.getState().maximized) window.maximize();
    window.show();
  });
  await window.loadURL(backend.url);
  const initialWorkspace = pendingWorkspace || launchOptions.workspace || runtime.getLastWorkspace();
  pendingWorkspace = null;
  if (initialWorkspace) await openWorkspace(initialWorkspace);
}

if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argumentsList, workingDirectory, additionalData) => {
    focusWindow();
    try {
      let options;
      if (additionalData && Object.hasOwn(additionalData, 'workspace')) {
        if (additionalData.workspace !== null && typeof additionalData.workspace !== 'string') throw new Error('桌面启动工作区参数无效');
        options = { workspace: additionalData.workspace ? path.resolve(workingDirectory, additionalData.workspace) : undefined };
      } else options = parseLaunchArguments(argumentsList, workingDirectory);
      if (options.workspace) {
        if (runtime && window && !window.isDestroyed()) void openWorkspace(options.workspace).catch(error => showError(error.message));
        else pendingWorkspace = options.workspace;
      }
    } catch (error) { void showError(error.message); }
  });
  app.on('before-quit', event => {
    if (shutdownComplete || !runtime && !backend) return;
    event.preventDefault();
    void requestClose();
  });
  app.on('window-all-closed', () => { if (shutdownComplete) app.quit(); else void requestClose({ force: true }); });
  app.on('activate', focusWindow);
  app.on('will-quit', () => globalShortcut.unregisterAll());
  process.on('SIGINT', () => { void requestClose({ force: true }); });
  process.on('SIGTERM', () => { void requestClose({ force: true }); });
  app.whenReady().then(async () => {
    if (launchError) throw launchError;
    await createWindow();
    runtime.on('event', event => {
      if (event.type !== 'automation.updated') return;
      const shortcut = 'CommandOrControl+Shift+F12';
      if (event.data.browser || event.data.desktop) {
        if (!globalShortcut.isRegistered(shortcut)) globalShortcut.register(shortcut, () => { void runtime.stopAutomation().catch(() => {}); });
      } else globalShortcut.unregister(shortcut);
    });
  }).catch(async error => {
    await showError(`桌面应用启动失败：${error.message}\n开发环境请先运行 npm run build，再重新启动。`);
    await requestClose({ force: true });
  });
}

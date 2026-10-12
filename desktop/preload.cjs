const { contextBridge, ipcRenderer } = require('electron');

const invoke = name => (...args) => ipcRenderer.invoke(`harness-desktop:${name}`, ...args);

const orbSurface = process.argv.includes('--harness-surface=orb');

contextBridge.exposeInMainWorld('harnessDesktop', Object.freeze(orbSurface ? {
  platform: process.platform,
  getOrbState: invoke('get-orb-state'),
  restoreWindow: invoke('restore-window'),
  moveOrb: invoke('move-orb'),
  resizeOrb: invoke('resize-orb'),
  answerQuestion: invoke('answer-question'),
  resolveApproval: invoke('resolve-orb-approval'),
  cancelRun: invoke('cancel-orb-run'),
  onOrbState(callback) {
    if (typeof callback !== 'function') throw new TypeError('状态监听器必须是函数');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('harness-desktop:orb-state', listener);
    return () => ipcRenderer.removeListener('harness-desktop:orb-state', listener);
  },
} : {
  platform: process.platform,
  getState: invoke('get-state'),
  setUnsavedChanges: invoke('set-unsaved-changes'),
  chooseWorkspace: invoke('choose-workspace'),
  openRecentWorkspace: invoke('open-recent-workspace'),
  revealWorkspace: invoke('reveal-workspace'),
  openExternal: invoke('open-external'),
  minimize: invoke('minimize'),
  toggleMaximize: invoke('toggle-maximize'),
  close: invoke('close'),
  onState(callback) {
    if (typeof callback !== 'function') throw new TypeError('状态监听器必须是函数');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('harness-desktop:state', listener);
    return () => ipcRenderer.removeListener('harness-desktop:state', listener);
  },
}));

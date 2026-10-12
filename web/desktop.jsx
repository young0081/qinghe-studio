import React, { useEffect, useRef, useState } from 'react';
import { PixelLoader } from './motion.jsx';
import { VERSION } from '../src/version.js';
import './desktop.css';

const initialState = {
  status: 'loading',
  workspace: null,
  recentWorkspaces: [],
  maximized: false,
  version: VERSION,
};

function workspaceName(workspace) {
  return workspace?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || workspace || '工作区';
}

function WindowButton({ label, symbol, onClick, danger = false }) {
  return <button className={`desktop-window-button ${danger ? 'window-close' : ''}`} aria-label={label} title={label} onClick={onClick}>
    <span className={`window-symbol symbol-${symbol}`} aria-hidden="true" />
  </button>;
}

function WorkspaceLauncher({ state, busy, chooseWorkspace, openRecent, Mark, Icon, Landscape }) {
  return <main className="desktop-launcher" aria-label="工作区启动器">
    <div className="desktop-launcher-inner">
      <div className="desktop-launcher-heading">
        <div className="desktop-launcher-copy">
          <div className="desktop-launcher-eyebrow"><Mark small /><span>青禾 Studio · 桌面版</span><span className="desktop-release">v{state.version}</span></div>
          <h1>为下一个想法，<br /><span>打开一片工作区。</span></h1>
          <p>选择你的项目，让 AI 和你一起构建。<br />阅读代码、规划任务、执行工具，都在一个窗口里。</p>
          <button className="button button-primary desktop-choose-button" aria-label="选择工作区" aria-busy={busy} onClick={chooseWorkspace} disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="folder" size={19} />}选择工作区<Icon name="chevron" size={13} />
          </button>
          <span className="desktop-launcher-hint">选择已有文件夹，开始你的下一次构建。</span>
        </div>
        <div className="desktop-launcher-world"><Landscape /><span className="desktop-world-caption">YOUR PROJECT. YOUR WORLD.</span></div>
      </div>
      <section className="desktop-recents" aria-labelledby="recent-workspaces-title">
        <div className="desktop-section-heading"><h2 id="recent-workspaces-title">最近的工作区</h2><span>{state.recentWorkspaces.length ? `${state.recentWorkspaces.length} PROJECTS` : 'START EXPLORING'}</span></div>
        {state.recentWorkspaces.length ? <div className="desktop-recent-list">
          {state.recentWorkspaces.map((workspace, index) => <button className="desktop-recent-workspace" style={{ '--desktop-item-delay': `${Math.min(index, 5) * 32}ms` }} aria-label={`打开最近工作区 ${workspace}`} title={workspace} key={workspace} onClick={() => openRecent(workspace)} disabled={busy}>
            <span className="desktop-recent-icon"><Icon name="folder" size={22} /></span>
            <span className="desktop-recent-details"><strong>{workspaceName(workspace)}</strong><span>{workspace}</span></span>
            <Icon name="chevron" size={13} />
          </button>)}
        </div> : <div className="desktop-recent-empty"><span className="desktop-recent-icon"><Icon name="folder" size={23} /></span><div><strong>你的第一个项目，从这里开始。</strong><p>打开过的工作区会保存在这里，随时接着构建。</p></div></div>}
      </section>
      <div className="desktop-launcher-footer"><span><Icon name="shield" size={14} />会话与快照保存在你的项目中</span><span>LOCAL FIRST <span className="desktop-footer-plus">+</span> NATIVE MODELS</span></div>
    </div>
  </main>;
}

export default function DesktopShell({ Studio, Mark, Icon, Landscape }) {
  const bridge = window.harnessDesktop;
  const [state, setState] = useState(initialState);
  const [actionError, setActionError] = useState('');
  const [dismissedError, setDismissedError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const update = next => {
      if (!mounted.current) return;
      if (!next || !['idle', 'loading', 'ready', 'error'].includes(next.status)) {
        setActionError('桌面程序返回了无效的工作区状态，请关闭窗口后重新启动。');
        setState(previous => ({ ...previous, status: 'error' }));
        return;
      }
      revision.current += 1;
      setState({ ...initialState, ...next, recentWorkspaces: next.recentWorkspaces || [] });
      setDismissedError('');
    };
    const unsubscribe = bridge.onState(update);
    const initialRevision = revision.current;
    bridge.getState().then(next => {
      if (mounted.current && revision.current === initialRevision) update(next);
    }).catch(error => {
      if (!mounted.current || revision.current !== initialRevision) return;
      setActionError(error.message || '无法连接桌面程序，请重新启动。');
      setState(previous => ({ ...previous, status: 'error' }));
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [bridge]);

  const invoke = async (operation, workspaceAction = false) => {
    if (workspaceAction && busy) return;
    if (workspaceAction) setBusy(true);
    setActionError('');
    setDismissedError('');
    const currentRevision = revision.current;
    try {
      const next = await operation();
      if (mounted.current && next && revision.current === currentRevision) {
        revision.current += 1;
        setState({ ...initialState, ...next, recentWorkspaces: next.recentWorkspaces || [] });
      }
    } catch (error) {
      if (mounted.current) setActionError(error.message || '操作失败，请重试。');
    } finally {
      if (mounted.current && workspaceAction) setBusy(false);
    }
  };

  const ready = state.status === 'ready' && !!state.workspace;
  const loading = state.status === 'loading';
  const error = actionError || state.error || (state.status === 'ready' && !state.workspace ? '未找到工作区路径，请重新选择项目文件夹。' : '');
  const showError = error && error !== dismissedError;
  const chooseWorkspace = () => invoke(() => bridge.chooseWorkspace(), true);
  const openRecent = workspace => invoke(() => bridge.openRecentWorkspace(workspace), true);
  const windowTitle = loading ? '正在准备工作区…' : ready ? workspaceName(state.workspace) : '选择你的工作区';

  return <div className={`desktop-shell desktop-platform-${bridge.platform}`} data-desktop-status={state.status}>
    <header className="desktop-titlebar">
      <div className="desktop-title-brand"><Mark small /><strong>青禾</strong><span>Studio</span></div>
      <div className="desktop-window-title" title={ready ? state.workspace : undefined}><Icon name="folder" size={13} /><span>{windowTitle}</span></div>
      <div className="desktop-title-actions">
        {ready && <>
          <button className="desktop-switch-workspace" aria-label="切换工作区" aria-busy={busy} onClick={chooseWorkspace} disabled={busy}>{busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="folder" size={13} />}<span>切换工作区</span></button>
          <button className="desktop-reveal-workspace" aria-label="在文件管理器中打开" title="在文件管理器中打开" onClick={() => invoke(() => bridge.revealWorkspace())}><Icon name="link" size={14} /></button>
        </>}
      </div>
      <div className="desktop-window-buttons">
        <WindowButton label="最小化窗口" symbol="minimize" onClick={() => invoke(() => bridge.minimize())} />
        <WindowButton label={state.maximized ? '还原窗口' : '最大化窗口'} symbol={state.maximized ? 'restore' : 'maximize'} onClick={() => invoke(() => bridge.toggleMaximize())} />
        <WindowButton label="关闭窗口" symbol="close" danger onClick={() => invoke(() => bridge.close())} />
      </div>
    </header>
    {showError && <div className="desktop-error-banner" role="alert"><Icon name="alert" size={16} /><span>{error}</span><button className="icon-button" aria-label="关闭桌面错误提示" onClick={() => { setDismissedError(error); setActionError(''); }}><Icon name="close" size={14} /></button></div>}
    <div className="desktop-content">
      {ready ? <Studio key={state.workspace} sessionStorageKey={`harness.session:${state.workspace}`} /> : loading ? <main className="desktop-loading" aria-label="正在准备工作区"><PixelLoader label="正在准备工作区" detail="连接代理引擎，载入会话与工具…" /></main> : <WorkspaceLauncher state={state} busy={busy} chooseWorkspace={chooseWorkspace} openRecent={openRecent} Mark={Mark} Icon={Icon} Landscape={Landscape} />}
    </div>
  </div>;
}

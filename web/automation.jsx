import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PixelActivity, PixelLoader } from './motion.jsx';
import './automation.css';

const cards = [
  { kind: 'browser', label: 'Browser-Use', title: 'Browser 网页操作', subtitle: '隔离浏览器 · DOM + 视觉', icon: 'link', description: '打开网页、阅读页面、定位元素、点击与填写表单、快捷键、滚动、多标签页和截图。无需浏览器扩展。', consent: '允许代理访问网站和提交表单；页面内容及截图可能发送给当前模型供应商。', detail: '自动查找 Edge / Chrome / Chromium；使用后台临时浏览器，不读取你日常浏览器的登录态。任务结束即关闭。' },
  { kind: 'desktop', label: 'Computer-Use', title: '电脑 / 桌面操作', subtitle: 'Windows 原生输入 · 服从审批策略', icon: 'panel', description: '查看桌面截图和窗口列表、切换窗口、单击 / 双击 / 右击、输入中文、使用快捷键与滚轮。', consent: '允许查看并操纵真实桌面；已隐藏隐私和凭据，理解全屏截图会发送给当前模型供应商。', detail: '不是沙箱，会影响真实应用。自动执行策略下直接操作；请求审批策略下逐次确认。无需剪贴板，Esc 可打断输入；不支持 UAC、锁屏或更高权限窗口。' },
];

export function AutomationSwitches({ api, state, onState, loadError, onReload, settings, disabled, visible, isRunning, onBusyChange, detailTarget, Icon }) {
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const workingRef = useRef(false);
  const originRef = useRef(null);
  const consentRef = useRef(null);
  const card = cards.find(entry => entry.kind === pending);
  const readonly = settings?.approval === 'readonly';
  const cancel = () => {
    if (workingRef.current) return;
    setPending('');
    onBusyChange(false);
    originRef.current?.focus();
  };
  useEffect(() => {
    if (!pending || busy) return;
    if (!visible || readonly || state?.[pending] || pending === 'desktop' && !state?.desktopSupported) {
      setPending('');
      onBusyChange(false);
      return;
    }
    consentRef.current?.focus({ preventScroll: true });
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [pending, busy, visible, readonly, state?.browser, state?.desktop, state?.desktopSupported, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const change = async (kind, enabled) => {
    if (workingRef.current || disabled || enabled && (readonly || !settings || kind === 'desktop' && !state?.desktopSupported)) return;
    workingRef.current = true;
    onBusyChange(true);
    setBusy(kind);
    setError('');
    try { onState(await api('/automation', { method: 'PATCH', body: { [kind]: enabled } })); }
    catch (failure) { setError(failure.message); await onReload(); }
    finally {
      workingRef.current = false;
      setBusy('');
      setPending('');
      onBusyChange(false);
      requestAnimationFrame(() => { if (originRef.current?.getClientRects().length) originRef.current.focus(); });
    }
  };
  return <div className="composer-automation" role="group" aria-label="操作能力">
    <div className="automation-switches">{cards.map(entry => {
      const enabled = !!state?.[entry.kind];
      const reason = readonly ? '只读模式禁止启用' : entry.kind === 'desktop' && state && !state.desktopSupported ? '仅支持 Windows' : '';
      return <button key={entry.kind} type="button" role="switch" aria-label={entry.label} aria-checked={enabled} aria-busy={busy === entry.kind} aria-describedby="automation-switch-note" className={`automation-switch ${enabled ? 'enabled' : ''}`} disabled={disabled || !!busy || !state || !settings || !enabled && (!!reason || !!loadError)} title={enabled ? '关闭会停止使用自动化的任务，并清除截图' : reason || `启用${entry.title}`} onClick={event => {
        originRef.current = event.currentTarget;
        if (enabled) { change(entry.kind, false); return; }
        setError('');
        setPending(entry.kind);
        onBusyChange(true);
      }}>{busy === entry.kind ? <PixelActivity /> : <Icon name={entry.icon} size={12} />}<span>{entry.label}</span><span className="automation-switch-track" aria-hidden="true"><span /></span><small className="sr-only">{!state ? '待连接' : reason && !enabled ? reason : enabled ? '已开启' : '已关闭'}</small></button>;
    })}</div>
    <p className="automation-switch-note sr-only" id="automation-switch-note">{busy ? '正在同步操作能力，请稍候…' : readonly ? '只读模式禁止启用操作能力；已开启的能力仍可关闭。' : isRunning ? '运行中开启仅对下一次任务生效；关闭会停止使用自动化的任务并清除截图。' : '仅本次工作区 · 所有会话共用 · 工具服从当前审批策略；关闭会停止自动化任务并清除截图。'}</p>
    {detailTarget && (!state || loadError || error || card) && createPortal(<div className="automation-feedback">
    {!state && !loadError && <PixelLoader compact label="正在载入操作能力" />}
    {loadError && <div className="automation-switch-error" role="alert"><span>操作能力同步失败：{loadError}</span><button type="button" className="text-button" disabled={!!busy} onClick={onReload}>重试连接操作能力</button></div>}
    {error && <p className="automation-switch-error" role="alert">{error}</p>}
    {card && <div className="automation-inline-consent" role="group" aria-label={`授权 ${card.label}`} tabIndex={-1} ref={consentRef}>
      <strong><Icon name="shield" size={14} />启用 {card.label}</strong><p>{card.consent}</p><p>{card.detail}</p>
      <p>仅本次工作区有效，所有会话共用。运行中开启用于下一次任务；关闭会停止自动化任务并清除截图。</p>
      <div><button type="button" className="button button-primary" disabled={!!busy || disabled || readonly || !!loadError} aria-busy={!!busy} onClick={() => change(card.kind, true)}>{busy && <PixelActivity />}同意并启用 {card.label}</button><button type="button" className="button button-quiet" disabled={!!busy} onClick={cancel}>取消启用</button></div>
    </div>}
    </div>, detailTarget)}
  </div>;
}

export function Screenshot({ id, label = '工具截图' }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <p className="automation-expired">截图已过期；停止、关闭或重启后不保留图像。</p>;
  return <img className="automation-screenshot" src={`/api/automation/screenshots/${encodeURIComponent(id)}`} alt={label} loading="lazy" onError={() => setFailed(true)} />;
}

export default function AutomationPage({ api, state, onState, onNavigate, settings, Icon }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [consent, setConsent] = useState({ browser: false, desktop: false });
  useEffect(() => {
    let cancelled = false;
    api('/automation').then(value => { if (!cancelled) onState(value); }).catch(failure => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [api, onState]);
  const change = async (kind, enabled) => {
    setBusy(kind);
    setError('');
    try { onState(await api('/automation', { method: 'PATCH', body: { [kind]: enabled } })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  };
  return <main className="management-page automation-page" aria-label="电脑与浏览器">
    <header className="management-heading"><div><span className="eyebrow">INTERACT WITH YOUR WORLD</span><h1>电脑与浏览器</h1><p>从代码到屏幕，每一个动作都可查看、可审批、可停止。</p></div><button className="button button-quiet" onClick={() => onNavigate('workspace')}>返回工作台</button></header>
    <div className="management-body">
      {error && <div className="management-notice error" role="alert">{error}</div>}
      {!state && !error && <PixelLoader label="正在检查操作能力" detail="连接本地自动化服务…" />}
      <div className="automation-policy"><Icon name="shield" /><div><strong>默认关闭 · 仅本次工作区有效</strong><p>重启或切换工作区需要重新启用。先启用再发送任务。截图仅在内存中保留最近 8 张，不写入会话文件；文字结果和操作参数仍记录到会话，请勿输入密码或密钥。</p></div></div>
      {settings?.approval === 'readonly' && <div className="management-notice info" role="status">当前为只读模式，禁止所有电脑和网页操作。请先在运行策略中调整。</div>}
      <div className="automation-grid">{cards.map(card => <section className={`automation-card ${state?.[card.kind] ? 'enabled' : ''}`} key={card.kind} aria-label={card.title}>
        <div className="automation-card-heading"><span className="management-section-icon"><Icon name={card.icon} size={24} /></span><div><h2>{card.title}</h2><p>{card.subtitle}</p></div><span className={`management-tag ${state?.[card.kind] ? 'enabled' : ''}`}>{state?.[card.kind] ? '已启用' : '已关闭'}</span></div>
        <p>{card.description}</p><p className="automation-detail">{card.detail}</p>
        {card.kind === 'desktop' && state && !state.desktopSupported && <p role="status">当前平台不支持桌面操作，请使用 Windows。</p>}
        {!state?.[card.kind] && <label className="automation-consent"><input type="checkbox" checked={consent[card.kind]} onChange={event => setConsent(previous => ({ ...previous, [card.kind]: event.target.checked }))} />{card.consent}</label>}
        <button className={`button ${state?.[card.kind] ? 'button-danger' : 'button-primary'}`} disabled={!!busy || !state || !state[card.kind] && (!consent[card.kind] || settings?.approval === 'readonly' || card.kind === 'desktop' && !state.desktopSupported)} aria-busy={busy === card.kind} onClick={() => change(card.kind, !state[card.kind])}>{busy === card.kind && <PixelActivity />}{state?.[card.kind] ? `关闭${card.kind === 'browser' ? ' Browser' : '桌面操作'}` : `启用${card.kind === 'browser' ? ' Browser' : '桌面操作'}`}</button>
      </section>)}</div>
      <section className="automation-observer" aria-label="操作观察台"><div className="section-heading"><h2>操作观察台</h2><span role="status">{state?.busy ? <><PixelActivity /> {state.busy}</> : '等待任务'}</span></div><p>在工作台描述任务，操作和审批会出现在活动记录中。截图需使用支持视觉输入的模型；纯文本模型可使用 Browser 页面文本。</p>{state?.ownerSessionId && <p className="automation-detail">正在操作的会话：{state.ownerSessionId}</p>}
        {state?.captures?.length ? <div className="automation-captures">{[...state.captures].reverse().map(capture => <figure key={capture.id}><figcaption>{capture.kind === 'browser' ? 'Browser' : '桌面'} · {capture.width} × {capture.height} · {new Date(capture.createdAt).toLocaleTimeString()}<span>{capture.title || capture.url || '桌面截图'}</span></figcaption><Screenshot id={capture.id} /></figure>)}</div> : <div className="automation-empty"><Icon name="panel" size={36} /><p>还没有截图</p><small>让代理“打开网页并截图”或“查看桌面”后，在这里观察结果。</small></div>}
      </section>
      <footer className="management-footer"><Icon name="info" /><span>随时使用顶部「停止自动化」。桌面 GUI 也支持全局 Ctrl + Shift + F12；Browser 不允许下载、文件上传、权限请求和 WebSocket。</span></footer>
    </div>
  </main>;
}

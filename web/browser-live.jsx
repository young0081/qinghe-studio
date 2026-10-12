import React, { useEffect, useRef, useState } from 'react';
import { PixelActivity, PixelLoader } from './motion.jsx';
import { sproutPath } from './brand.jsx';
import './browser-live.css';

const actions = { navigate: '正在打开网页', snapshot: '正在阅读页面', click: '正在点击', fill: '正在填写', press: '正在按键', scroll: '正在滚动', tabs: '正在切换标签', screenshot: '正在观察页面', close: '正在关闭浏览器' };

export default function BrowserLive({ api, enabled, open, onOpenChange, requestedRun }) {
  const [state, setState] = useState(null);
  const [frame, setFrame] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const lastRun = useRef('');
  useEffect(() => {
    if (requestedRun && requestedRun !== lastRun.current) {
      lastRun.current = requestedRun;
      onOpenChange(true);
    }
  }, [requestedRun, onOpenChange]);
  useEffect(() => {
    let disposed = false;
    let timer;
    let objectUrl = '';
    let sequence = '';
    let owner = '';
    const controller = new AbortController();
    const clearFrame = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = '';
      sequence = '';
      setFrame('');
    };
    if (!enabled) { setState(null); setFrame(''); setError(''); return; }
    const poll = async () => {
      let delay = open ? 250 : 900;
      try {
        const next = await api('/automation/browser-live', { signal: controller.signal });
        if (disposed) return;
        setState(next);
        setError('');
        const nextOwner = next.active ? `${next.sessionId}:${next.runId}:${next.tabId}` : '';
        if (owner !== nextOwner) { clearFrame(); owner = nextOwner; }
        if (next.active && next.runId && lastRun.current !== next.runId) {
          lastRun.current = next.runId;
          onOpenChange(true);
        }
        if (open && next.active && !document.hidden && String(next.sequence) !== sequence) {
          const response = await fetch(`/api/automation/browser-live/frame?after=${encodeURIComponent(sequence)}`, { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error('浏览器画面暂时不可用');
          if (response.status !== 204) {
            const blob = await response.blob();
            if (disposed) return;
            const nextUrl = URL.createObjectURL(blob);
            const previous = objectUrl;
            objectUrl = nextUrl;
            sequence = response.headers.get('X-Frame-Sequence') || String(next.sequence);
            setFrame(nextUrl);
            if (previous) URL.revokeObjectURL(previous);
          }
        }
      } catch (failure) {
        if (disposed || controller.signal.aborted) return;
        setError(failure.message || '监控连接已中断');
        delay = 1500;
      } finally {
        if (!disposed) timer = setTimeout(poll, delay);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, enabled, open, onOpenChange, retry]);
  if (!open) return null;
  return <aside className="browser-live" aria-label="Browser 实时画面" data-active={!!state?.active}>
    <header className="browser-live-heading"><span className="browser-live-icon" aria-hidden="true">▣</span><div><span className="browser-live-eyebrow">BROWSER / LIVE VIEW</span><h2>看见每一步</h2></div><button type="button" className="icon-button" aria-label="收起浏览器实时画面" onClick={() => onOpenChange(false)}>×</button></header>
    <div className="browser-live-status" role="status"><span className={state?.active && !error ? 'live-lamp' : 'live-lamp inactive'} /><strong>{error ? '连接中断 · 正在重连' : state?.active ? '正在直播' : '等待网页操作'}</strong><span>{state?.active && !error ? <PixelActivity /> : 'LOCAL VIEW'}</span></div>
    <div className="browser-live-address"><span aria-hidden="true">↗</span><span title={state?.url || ''}>{state?.url || '网页地址将在这里显示'}</span></div>
    <div className="browser-live-canvas">
      {frame && state?.active ? <img src={frame} alt="青禾 Studio 正在操作的浏览器实时画面" /> : state?.active && !error ? <PixelLoader label="正在连接浏览器画面" detail="网页加载后，画面会持续更新" /> : <div className="browser-live-empty"><span className="live-pixel-window" aria-hidden="true"><i /><i /><i /><b><svg width="28" height="28" viewBox="0 0 32 32" fill="currentColor" shapeRendering="crispEdges"><path d={sproutPath} /></svg></b></span><strong>{error ? '画面暂时断开' : '你的网页搭档，随时就位。'}</strong><p>{error ? error : '青禾 Studio 使用 Browser 时，这里会自动展开，实时呈现阅读、点击与滚动。'}</p>{error && <button className="button button-quiet" onClick={() => setRetry(value => value + 1)}>立即重连</button>}</div>}
    </div>
    <div className="browser-live-caption"><span className="live-action-mark" aria-hidden="true">→</span><div><strong>{state?.active ? actions[state.action] || '正在浏览网页' : '浏览器待命'}</strong><p>{state?.error || state?.title || (state?.active ? '画面随页面实时更新' : '操作结束后，临时浏览器与画面会清除。')}</p></div></div>
    <footer className="browser-live-footer"><span>只读观察 · 操作由青禾 Studio 执行</span><span>● LIVE</span></footer>
  </aside>;
}

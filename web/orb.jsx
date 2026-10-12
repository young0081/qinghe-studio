import React, { useEffect, useRef, useState } from 'react';
import { QuestionCard } from './questions.jsx';
import { sproutPath } from './brand.jsx';
import './orb.css';

const labels = { idle: '青禾 Studio 就绪', running: '正在运行', compacting: '上下文压缩中', question: '等待你的回答', approval: '等待你的批准', error: '任务已中断', completed: '任务已完成' };
const emptyState = { mode: 'idle', activeCount: 0, pendingCount: 0 };

function OrbArtwork({ mode }) {
  return <span className="orb-artwork" aria-hidden="true">
    <span className="orb-satellite satellite-a" /><span className="orb-satellite satellite-b" /><span className="orb-satellite satellite-c" />
    <span className="orb-core"><svg viewBox="0 0 64 64" shapeRendering="crispEdges">
      <path fill="#426b31" d="M20 2h24v4h10v6h6v10h4v22h-4v10h-6v6H44v4H20v-4H10v-6H4V44H0V22h4V12h6V6h10Z" />
      <path fill="#80aa55" d="M20 6h24v4h10v12h6v22h-6v10H44v6H20v-6H10V44H4V22h6V12h10Z" />
      <path fill="#abd280" d="M20 6h24v4H20v8H12v14H4V22h6V12h10Z" />
      <path fill="#648c43" d="M54 22h6v22h-6v10H44v6H20v-6h24v-8h10Z" />
      {mode === 'completed' ? <path fill="#fffde5" d="M14 30h8v8h8V28h8v-8h8v-8h8v16h-8v8h-8v8h-8v8h-8V42h-8Z" />
        : mode === 'error' ? <><path fill="#ffe8c7" d="M14 20h6v6h6v-6h6v6h-6v6h-6v-6h-6Zm24 0h6v6h6v-6h6v6h-6v6h-6v-6h-6Z" /><path fill="#ffe8c7" d="M22 40h20v6H22Z" /></>
          : mode === 'question' || mode === 'approval' ? <path fill="#fff8d4" d="M22 14h22v6h6v12h-6v6h-8v6h-8V32h8v-6h6v-6H22Zm6 34h8v8h-8Z" />
            : <path fill="#f5f5de" d={sproutPath} transform="scale(2)" />}
    </svg></span>
    {mode === 'compacting' && <span className="orb-compression"><i /><i /><i /></span>}
    <span className="orb-status-pixel" />
  </span>;
}

function ApprovalBubble({ approval, onResolve }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const resolve = async approved => {
    setWorking(true);
    setError('');
    try { await onResolve(approval.id, approved); }
    catch (failure) { setError(failure.message || '审批失败，请重试。'); }
    finally { setWorking(false); }
  };
  return <section className="orb-approval" aria-label="悬浮球待审批工具">
    <strong>这个操作需要你的批准</strong><p>{approval.tool}</p>
    <pre>{JSON.stringify(approval.args, null, 2)}</pre>
    {approval.target && <p>目标窗口：{approval.target.title || approval.target.windowId}</p>}
    {approval.tool === 'computer' && <p>将操作真实桌面并向当前模型发送截图。批准后请勿同时操作。</p>}
    {approval.tool === 'run_command' && <p>命令将在本机工作区执行，请检查后批准。</p>}
    {error && <p role="alert" className="orb-error-copy">{error}</p>}
    <div className="orb-approval-actions"><button className="button button-quiet" disabled={working} onClick={() => resolve(false)}>拒绝</button><button className="button button-primary" disabled={working} onClick={() => resolve(true)}>{working ? '处理中…' : '批准执行'}</button></div>
  </section>;
}

export default function Orb() {
  const bridge = window.harnessDesktop;
  const [state, setState] = useState(emptyState);
  const [error, setError] = useState('');
  const bubble = useRef(null);
  const drag = useRef(null);
  const terminal = state.mode === 'completed' || state.mode === 'error';
  const notice = state.activeCount > 0 ? state.result : null;
  const expanded = Boolean(state.question || state.approval || terminal || notice || error);

  useEffect(() => {
    document.documentElement.classList.add('orb-document');
    document.title = '青禾 Studio · 悬浮球';
    let active = true;
    let received = false;
    const unsubscribe = bridge.onOrbState(next => { received = true; if (active) setState(next); });
    bridge.getOrbState().then(next => { if (active && !received) setState(next); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; unsubscribe(); document.documentElement.classList.remove('orb-document'); };
  }, [bridge]);

  useEffect(() => {
    let frame;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = expanded ? Math.min(680, Math.max(240, (bubble.current?.scrollHeight || 300) + 146)) : 132;
        bridge.resizeOrb({ expanded, height }).catch(failure => setError(failure.message));
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (bubble.current) observer.observe(bubble.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [bridge, expanded, state.question?.id, state.approval?.id, state.mode, state.result?.runId, state.pendingCount, error]);

  const restore = () => bridge.restoreWindow().catch(failure => setError(failure.message));
  const pointerDown = event => {
    if (event.button !== 0) return;
    drag.current = { x: event.screenX, y: event.screenY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = event => {
    if (!drag.current) return;
    const dx = event.screenX - drag.current.x;
    const dy = event.screenY - drag.current.y;
    drag.current = { x: event.screenX, y: event.screenY };
    if (dx || dy) bridge.moveOrb({ dx, dy, finish: false }).catch(failure => setError(failure.message));
  };
  const pointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    bridge.moveOrb({ dx: 0, dy: 0, finish: true }).catch(failure => setError(failure.message));
  };
  const label = state.mode === 'error' && state.result?.status === 'failed' ? '任务遇到错误' : labels[state.mode];

  return <main className={`orb-shell orb-${state.mode}`} data-mode={state.mode} aria-label="青禾 Studio 悬浮助手">
    {expanded && <aside ref={bubble} className="orb-bubble" aria-label="悬浮球消息气泡">
      <div className="orb-bubble-heading"><span>青禾 Studio</span><button onClick={restore} aria-label="展开工作台">展开 ↗</button></div>
      {state.question ? <QuestionCard key={state.question.id} question={state.question} compact onAnswer={answer => bridge.answerQuestion(state.question.id, answer)} />
        : state.approval ? <ApprovalBubble key={state.approval.id} approval={state.approval} onResolve={bridge.resolveApproval} />
          : terminal ? <div className="orb-result" role="status"><strong>{label}</strong><p>{state.mode === 'completed' ? '已完成本次任务。打开工作台查看结果。' : state.result?.error || '任务已停止。打开工作台后可以继续。'}</p><button className="button button-primary" onClick={restore}>查看任务 ↗</button></div> : null}
      {notice && <div className={`orb-notice ${notice.status === 'completed' ? 'notice-completed' : 'notice-error'}`} role="status"><span aria-hidden="true">{notice.status === 'completed' ? '✓' : '!'}</span><p>{notice.status === 'completed' ? '一项任务已完成' : '一项任务已中断'}<small>{notice.error || `另外 ${state.activeCount} 项任务仍在进行`}</small></p></div>}
      {state.pendingCount > 1 && <p className="orb-queue">还有 {state.pendingCount - 1} 项等待处理；提交后显示下一项。</p>}
      {error && <p role="alert" className="orb-error-copy">{error}<button onClick={() => { setError(''); bridge.getOrbState().then(setState).catch(failure => setError(failure.message)); }}>重试</button></p>}
    </aside>}
    <div className="orb-dock">
      <button className="orb-drag" aria-label="拖动悬浮球" title="拖动后自动靠边；方向键移动" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={event => {
        const moves = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] };
        if (!moves[event.key]) return;
        event.preventDefault();
        const [dx, dy] = moves[event.key];
        bridge.moveOrb({ dx, dy, finish: false }).catch(failure => setError(failure.message));
      }}><i /><i /><i /></button>
      <button className="orb-open" aria-label="恢复 青禾 Studio 窗口" onClick={restore}><OrbArtwork mode={state.mode} /></button>
      <span className="orb-label" role="status" aria-live="polite">{label}</span>
      {state.activeCount > 0 && <div className="orb-mini-actions"><span>{state.activeCount > 1 ? `${state.activeCount} 项任务` : state.mode === 'compacting' ? '整理上下文' : state.steps ? `STEP ${state.steps}` : 'WORKING'}</span><button aria-label="停止当前任务" title="停止当前任务" onClick={() => bridge.cancelRun(state.sessionId).catch(failure => setError(failure.message))}>■</button></div>}
    </div>
  </main>;
}

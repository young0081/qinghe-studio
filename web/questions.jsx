import React, { useId, useState } from 'react';
import { PixelActivity } from './motion.jsx';
import './questions.css';

export function QuestionCard({ question, onAnswer, compact = false }) {
  const labelId = useId();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault();
    if (!answer.trim() || busy) return;
    setBusy(true);
    setError('');
    try { await onAnswer(answer.trim()); }
    catch (failure) { setError(failure.message || '回答未能发送，请重试。'); }
    finally { setBusy(false); }
  };
  return <form className={`question-card ${compact ? 'question-compact' : ''}`} onSubmit={submit} aria-label="回答 青禾 Studio 的问题" aria-busy={busy}>
    <div className="question-heading"><span className="question-pixel" aria-hidden="true">?</span><div><span className="question-eyebrow">青禾 Studio 正在等待</span><strong>需要你补充一点信息</strong></div><PixelActivity /></div>
    <p className="question-text" id={labelId}>{question.question}</p>
    {question.options?.length > 0 && <div className="question-options" role="group" aria-label="建议选项">{question.options.map((option, index) => <button type="button" key={`${index}:${option}`} className={answer === option ? 'selected' : ''} aria-pressed={answer === option} disabled={busy} onClick={() => setAnswer(option)}><span>{String(index + 1).padStart(2, '0')}</span>{option}</button>)}</div>}
    <label className="question-answer-label" htmlFor={`${labelId}-answer`}>{question.options?.length ? '也可以输入自己的回答' : '你的回答'}</label>
    <textarea id={`${labelId}-answer`} aria-describedby={labelId} value={answer} onChange={event => setAnswer(event.target.value)} rows={compact ? 2 : 3} maxLength={8000} disabled={busy} placeholder="补充信息，让青禾 Studio 接着完成任务…" />
    {error && <p className="question-error" role="alert">{error}</p>}
    <div className="question-submit-row"><span>回答后继续当前任务</span><button type="submit" className="button button-primary" disabled={!answer.trim() || busy}>{busy ? <><PixelActivity />发送中…</> : '提交并继续 →'}</button></div>
  </form>;
}

export function QuestionInbox({ questions, selectedId, onSelect, onAnswer, onCancel, loadError, onRetry }) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const question = questions.find(item => item.sessionId === selectedId) || questions[0];
  if (!question) return loadError ? <aside className="question-inbox question-reconnect" aria-label="恢复 青禾 Studio 提问"><p role="status">{loadError}</p><button className="button button-quiet" onClick={onRetry}>立即重试</button></aside> : null;
  const cancel = async () => {
    setCancelling(true);
    setError('');
    try { await onCancel(question.sessionId); }
    catch (failure) { setError(failure.message); }
    finally { setCancelling(false); }
  };
  return <aside className="question-inbox" aria-label="青禾 Studio 提问气泡" aria-live="polite">
    <div className="question-inbox-bar"><span>{questions.length > 1 ? `${questions.length} 个问题等待回答` : '任务正在等你'}</span>{question.sessionId !== selectedId && <button type="button" onClick={() => onSelect(question.sessionId)}>查看对应会话 ↗</button>}<button type="button" disabled={cancelling} onClick={cancel}>{cancelling ? '正在停止…' : '停止此任务'}</button></div>
    {error && <p className="question-error" role="alert">{error}</p>}
    <QuestionCard key={question.id} question={question} onAnswer={answer => onAnswer(question.id, answer)} />
  </aside>;
}

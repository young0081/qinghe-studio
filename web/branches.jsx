import React, { useEffect, useRef } from 'react';
import { PixelActivity } from './motion.jsx';
import { AttachmentList } from './attachments.jsx';
import './branches.css';

export function MessageActions({ message, disabled, onStart, Icon }) {
  return <div className="message-actions"><button type="button" className="text-button" disabled={disabled} onClick={event => onStart(message, 'retry', event.currentTarget)}><Icon name="retry" size={12} />{message.role === 'user' ? '编辑并重发' : '重新生成'}</button><button type="button" className="text-button" disabled={disabled} onClick={event => onStart(message, 'continue', event.currentTarget)}><Icon name="branch" size={13} />从这里分支</button></div>;
}

export function BranchEditor({ draft, onChange, onCancel, onConfirm, busy, blocked, canSend, model, api, Icon }) {
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const retry = draft.mode === 'retry';
  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  return <form className="message-branch-editor" aria-label="消息分支编辑器" ref={panelRef} onSubmit={event => { event.preventDefault(); onConfirm(); }}><fieldset disabled={busy}>
    <div className="branch-editor-heading"><Icon name="branch" size={17} /><strong>{retry ? draft.role === 'user' ? '编辑这条消息并重新发送' : '重新生成这轮回复' : '从这条消息创建分支'}</strong></div>
    <p>{retry ? '复制这一轮用户消息之前的上下文，在新分支发送。原回复及后续对话都不会被覆盖，也不会进入这次重试。' : '复制到所选消息为止的上下文及必要的配套工具结果，然后在新会话继续。不会自动调用模型。'}</p>
    {retry ? <label>重发消息<textarea ref={inputRef} aria-label="重发消息" rows="4" maxLength={200000} required={!draft.attachments?.length} value={draft.prompt} onChange={event => onChange({ prompt: event.target.value })} /></label> : <blockquote>{draft.preview}</blockquote>}
    {retry && <AttachmentList items={draft.attachments} api={api} Icon={Icon} disabled={busy} onRemove={file => onChange({ attachments: draft.attachments.filter(item => item.id !== file.id) })} />}
    <label>分支名称（可选）<input ref={retry ? undefined : inputRef} aria-label="分支名称" maxLength={200} value={draft.title} onChange={event => onChange({ title: event.target.value })} placeholder="留空按来源自动命名" /></label>
    <p className="branch-workspace-warning"><Icon name="info" size={13} />分支只复制对话，不回滚或隔离工作区文件。重发可能再次执行工具，仍遵循当前审批策略。</p>
    {retry && <p className="branch-model-note">使用当前默认模型：{model || '尚未配置，请先在输入框旁选择模型'}</p>}
    <div className="branch-editor-actions"><button type="button" className="button button-quiet" onClick={onCancel}>取消分支操作</button><button type="submit" className="button button-primary" disabled={blocked || retry && (!canSend || !draft.prompt.trim() && !draft.attachments?.length || draft.prompt.length > 200000)} aria-busy={busy}>{busy ? <PixelActivity /> : <Icon name="branch" size={14} />}{retry ? '新建分支并发送' : '创建分支'}</button></div>
  </fieldset></form>;
}

export function SessionBranches({ session, sessions, onSelect, disabled, Icon }) {
  if (!session) return null;
  const rootId = session.branch?.rootSessionId || session.id;
  const family = sessions.filter(entry => entry.id === rootId || entry.branch?.rootSessionId === rootId);
  if (!session.branch && family.length < 2) return null;
  const parent = sessions.find(entry => entry.id === session.branch?.parentSessionId);
  const byId = new Map(family.map(entry => [entry.id, entry]));
  const depth = entry => {
    const visited = new Set([entry.id]);
    let current = entry;
    let count = 0;
    while (current.branch && !visited.has(current.branch.parentSessionId)) {
      count++;
      visited.add(current.branch.parentSessionId);
      current = byId.get(current.branch.parentSessionId);
      if (!current) break;
    }
    return Math.min(count, 3);
  };
  return <section className="session-branches" aria-label="会话分支">
    <div className="branch-lineage"><Icon name="branch" size={14} /><span>{session.branch ? `来自：${parent?.title || session.branch.parentTitle}${parent ? '' : '（来源会话已删除）'}` : '原会话 · 已保留所有历史'}</span>{parent && <button type="button" className="text-button" disabled={disabled} onClick={() => onSelect(parent.id)}>返回上级会话</button>}</div>
    <details><summary>会话分支（{family.length}）<span>查看与切换</span></summary><nav aria-label="相关会话分支">{[...family].sort((first, second) => String(first.createdAt).localeCompare(String(second.createdAt))).map(entry => <button type="button" key={entry.id} className="branch-session-option" style={{ '--branch-depth': depth(entry) }} data-branch-session={entry.id} aria-label={`打开会话分支 ${entry.title}`} aria-current={entry.id === session.id ? 'page' : undefined} disabled={disabled} title={entry.title} onClick={() => onSelect(entry.id)}><Icon name={entry.branch ? 'branch' : 'chat'} size={13} /><span>{entry.title}</span><small>{entry.id === session.id ? '当前' : entry.branch ? entry.branch.mode === 'retry' ? '重试分支' : '分支' : '原会话'}</small></button>)}</nav></details>
    {session.branch && <p>各分支对话独立，工作区文件共享且不会自动回滚。</p>}
  </section>;
}

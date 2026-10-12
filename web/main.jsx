import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DesktopShell from './desktop.jsx';
import Mark from './brand.jsx';
import Orb from './orb.jsx';
import BrowserLive from './browser-live.jsx';
import { QuestionInbox } from './questions.jsx';
import ManagementPage from './providers.jsx';
import ExtensionsPage from './extensions.jsx';
import ModelPicker from './model-picker.jsx';
import ReasoningPicker from './reasoning.jsx';
import SponsorshipButton from './sponsorship.jsx';
import DisclaimerDialog from './disclaimer.jsx';
import Markdown from './markdown.jsx';
import AutomationPage, { AutomationSwitches, Screenshot } from './automation.jsx';
import { AttachmentButton, AttachmentList, useAttachments } from './attachments.jsx';
import { attachmentIssue } from '../src/core/attachment-types.js';
import { reasoningLabel } from '../src/core/reasoning.js';
import { BranchEditor, MessageActions, SessionBranches } from './branches.jsx';
import { PixelActivity, PixelLoader, SkeletonRows } from './motion.jsx';
import { VERSION } from '../src/version.js';
import './styles.css';
import './motion.css';

const providerNames = {
  responses: 'OpenAI Responses',
  openai: 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
};
const activeStatuses = new Set(['running', 'waiting_approval', 'waiting_input']);
const statusNames = { running: '正在运行', waiting_approval: '等待审批', waiting_input: '等待你的回答', completed: '已完成', failed: '运行失败', cancelled: '已停止' };
const toolNames = { web_fetch: '网页抓取 · WebFetch', web_search: '网页搜索 · WebSearch', ask_user: '等待用户补充', browser: 'Browser 网页操作', computer: '电脑 / 桌面操作', list_files: '浏览工作区', read_file: '读取文件', read_attachment: '读取附件', search_files: '搜索文件', write_file: '写入文件', edit_file: '编辑文件', run_command: '执行命令', update_plan: '更新计划', save_memory: '保存记忆', read_skill: '读取技能', list_skills: '查找技能', read_skill_file: '读取技能参考文件' };
const iconPaths = {
  plus: 'M11 3h2v8h8v2h-8v8h-2v-8H3v-2h8Z',
  arrow: 'M11 3h2v2h2v2h2v2h2v2h-4V9h-2v12h-2V9H9v2H5V9h2V7h2V5h2Z',
  chevron: 'M8 4h3v3h3v3h3v4h-3v3h-3v3H8v-4h3v-3h3v-2h-3V8H8Z',
  down: 'M4 7h4v3h3v3h2v-3h3V7h4v4h-3v3h-3v3h-4v-3H7v-3H4Z',
  check: 'M3 11h3v3h3v3h3v-3h3v-3h3V8h3V5h-4v3h-3v3h-3v3H9v-3H6V8H3Z',
  close: 'M4 4h4v4h3v3h2V8h3V4h4v4h-4v3h-3v2h3v3h4v4h-4v-4h-3v-3h-2v3H8v4H4v-4h4v-3h3v-2H8V8H4Z',
  stop: 'M5 5h14v14H5Z',
  menu: 'M3 4h18v3H3Zm0 7h18v3H3Zm0 7h18v3H3Z',
  chat: 'M3 3h18v14H9v3H6v-3H3Zm3 3v8h12V6Z',
  folder: 'M2 5h8v3h12v13H2Zm3 6v7h14v-7Z',
  file: 'M4 2h11v3h3v3h3v14H4Zm3 3v14h11V11h-6V5Zm2 8h6v2H9Zm0 4h6v1H9Z',
  terminal: 'M3 4h3v3h3v3h3v3H9v3H6v3H3v-4h3v-3h3v-1H6V8H3Zm10 13h8v3h-8Z',
  settings: 'M9 1h6v4h4v4h4v6h-4v4h-4v4H9v-4H5v-4H1V9h4V5h4Zm0 8v6h6V9Z',
  branch: 'M3 2h6v6H7v7h8v-3h6v9h-6v-3H4V8H3Zm10 0h8v6h-8ZM7 5v4h10V6h2v6H5V5Z',
  clock: 'M6 2h12v3h3v14h-3v3H6v-3H3V5h3Zm1 4v2H6v9h2v2h9v-2h1V7h-2V6Zm4 2h2v5h4v2h-6Z',
  shield: 'M3 3h18v12h-3v3h-3v3H9v-3H6v-3H3Zm3 3v7h3v3h3v2h1v-2h3v-3h2V6Z',
  activity: 'M2 11h5V5h4v12h3V9h4v3h4v3h-7v6H8V9H7v5H2Z',
  trash: 'M8 2h8v3h5v3H3V5h5ZM5 9h3v11h2V9h4v11h2V9h3v14H5Z',
  copy: 'M2 2h14v4H5v11H2Zm6 6h14v15H8Zm3 3v9h8v-9Z',
  retry: 'M7 2h11v3h3v14h-3v3H7v-3h10v-3h2V7h-3V5H8v3h4v3H2V1h3v5h2Z',
  spark: 'M10 1h4v7h3v3h6v3h-6v3h-3v6h-4v-6H7v-3H1v-3h6V8h3Z',
  heart: 'M3 3h6v3h6V3h6v3h3v9h-3v3h-3v3h-3v3H9v-3H6v-3H3v-3H0V6h3Z',
  panel: 'M2 3h20v18H2Zm3 3v12h8V6Zm11 0v12h3V6Z',
  info: 'M5 2h14v3h3v14h-3v3H5v-3H2V5h3Zm1 3v2H5v10h2v2h10v-2h2V7h-2V5Zm4 3h4v3h-4Zm0 5h4v5h-4Z',
  alert: 'M9 2h6v4h3v5h3v5h2v6H1v-6h2v-5h3V6h3Zm1 6v7h4V8Zm0 9v3h4v-3Z',
  link: 'M12 2h10v10h-3V7h-3v3h-3v3h-3v3H7v-4h3V9h3V6h-1ZM2 5h7v3H5v12h12v-5h3v8H2Z',
};

function Icon({ name, size = 18, className = '', ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" shapeRendering="crispEdges" className={className} aria-hidden="true" {...props}><path d={iconPaths[name] || iconPaths.spark} /></svg>;
}

function VoxelScene() {
  return <svg className="voxel-scene" viewBox="0 0 220 160" fill="none" shapeRendering="crispEdges" aria-hidden="true">
    <g className="scene-sun"><path fill="#f6c95a" d="M172 14h22v22h-22Z" /><path fill="#ffe9a0" d="M172 14h22v5h-17v17h-5Z" /></g>
    <path className="scene-clouds" fill="#fffefa" d="M12 32h12V20h30v12h15v12H12Zm111 16h12v-9h23v9h16v10h-51Z" />
    <path fill="#c6e4d5" d="M8 98h21V84h23V71h29v16h22v20h25V91h24V73h22v12h21v17h21v42H8Z" />
    <path fill="#9ac475" d="M13 115h27v-14h45v14h34V97h39v13h26v17h26v17H13Z" />
    <path fill="#b48c61" d="M37 117h128v23H37Z" /><path fill="#92704e" d="M37 137h128v8H37Z" />
    <path fill="#79a94b" d="M30 108h142v15h-13v6h-16v-6h-19v7H91v-7H73v6H51v-6H30Z" />
    <path fill="#a5cd6b" d="M30 108h142v7H30Z" /><path fill="#c5a37a" d="M45 132h13v6H45Zm37-6h9v9h-9Zm42 10h13v5h-13Zm26-7h9v5h-9Z" />
    <g className="scene-tree"><path fill="#806344" d="M66 76h11v35H66Z" /><path fill="#a17d50" d="M66 76h5v35h-5Z" />
    <path fill="#4a793e" d="M42 49h57v35H88v9H50V81h-8Z" /><path fill="#6eaa4c" d="M47 37h44v16h13v21H87v9H48V72H36V51h11Z" /><path fill="#94c565" d="M47 37h44v8H55v13H36v-7h11Z" /><path fill="#81b556" d="M61 62h13v10H61Zm19-13h12v9H80Z" /></g>
    <path fill="#f4e4b8" d="M130 79h18v25h-18Z" /><path fill="#bd954f" d="M126 73h25v8h-25Z" /><path fill="#658b42" d="M111 107h4v-8h5v8h4v-13h4v14h-17Z" />
    <path fill="#ddb364" d="M137 88h6v7h-6Z" /><path fill="#eff2d8" d="M183 127h21v6h-21Z" />
    <path fill="#88ad65" d="M13 144h10v4H13Zm172-1h17v4h-17Z" />
  </svg>;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}

function emptySession(id) {
  return { id, title: '新会话', messages: [], events: [], plan: [], checkpoints: [], run: null, streaming: '' };
}

function applyEvent(session, event) {
  if ((session.events || []).some(existing => existing.id === event.id)) return session;
  const next = { ...session, events: [...(session.events || []), event], updatedAt: event.timestamp };
  const data = event.data || {};
  if (event.type === 'session.created' && data.session) Object.assign(next, data.session, { events: next.events });
  if (event.type === 'message' && data.message) {
    if (data.message.role === 'user' && !next.messages?.length && next.title === '新会话') next.title = String(data.message.content).trim().slice(0, 40);
    next.messages = [...(next.messages || []).filter(message => message.id !== data.message.id), data.message];
    if (data.message.role === 'assistant') next.streaming = '';
  }
  if (event.type === 'assistant.delta') next.streaming = `${next.streaming || ''}${data.text || ''}`;
  if (event.type === 'run.started') {
    next.run = data.run;
    next.streaming = '';
  }
  if (event.type === 'run.step' && next.run) next.run = { ...next.run, steps: data.step ?? data.steps ?? next.run.steps, usage: data.usage || next.run.usage, modelUsage: data.modelUsage || next.run.modelUsage, ...data.currentModel };
  if (event.type === 'model.routed' && next.run) next.run = { ...next.run, ...data.selectedModel };
  if (event.type === 'approval.required' && next.run) next.run = { ...next.run, status: 'waiting_approval' };
  if (event.type === 'approval.resolved' && next.run && activeStatuses.has(next.run.status)) next.run = { ...next.run, status: 'running' };
  if (event.type === 'question.required' && next.run) next.run = { ...next.run, status: 'waiting_input' };
  if (event.type === 'question.resolved' && next.run?.status === 'waiting_input') next.run = { ...next.run, status: 'running' };
  if (event.type === 'plan.updated') next.plan = data.plan || [];
  if (event.type === 'checkpoint.created' && data.checkpoint) next.checkpoints = [...(next.checkpoints || []).filter(checkpoint => checkpoint.id !== data.checkpoint.id), data.checkpoint];
  if (event.type === 'checkpoint.restored') next.checkpoints = (next.checkpoints || []).map(checkpoint => checkpoint.id === (data.checkpointId || data.checkpoint?.id || data.id) ? { ...checkpoint, restored: true } : checkpoint);
  if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) next.run = data.run || { ...next.run, status: event.type.slice(4) };
  return next;
}

function mergeSnapshot(snapshot, current) {
  const knownEvents = new Set((snapshot.events || []).map(event => event.id));
  const pending = (current?.events || []).filter(event => !knownEvents.has(event.id));
  let merged = { ...snapshot, streaming: '' };
  if (activeStatuses.has(snapshot.run?.status)) {
    for (const event of snapshot.events || []) {
      if (event.type === 'run.started' || event.type === 'message' && event.data?.message?.role === 'assistant') merged.streaming = '';
      if (event.type === 'assistant.delta') merged.streaming += event.data?.text || '';
    }
  }
  for (const event of pending) merged = applyEvent(merged, event);
  return merged;
}

function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function shortPath(value) {
  return (value || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') || 'workspace';
}

function readable(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function ApprovalCard({ approval, onResolve, working }) {
  return <section className="approval-card" aria-label="待审批工具"><div className="approval-heading"><span className="approval-symbol"><Icon name="shield" /></span><div><strong>这个操作需要你的批准</strong><p>{toolNames[approval.tool] || approval.tool} <span>·</span> {approval.tool}</p></div><span className="pill pill-amber">等待审批</span></div><pre className="approval-arguments">{readable(approval.args)}</pre>{approval.target && <p className="approval-note">目标窗口：{approval.target.title || approval.target.windowId}。{approval.target.note || "批准后激活该窗口。"}</p>}{approval.tool === 'run_command' && <p className="approval-note">命令将在本机工作区执行，请检查内容后批准。</p>}{approval.tool === 'computer' && <p className="approval-note">将查看或操纵真实桌面，截图会发送给当前模型供应商。请检查目标窗口，勿批准访问凭据或操纵审批界面的操作。</p>}{approval.tool === 'browser' && <p className="approval-note">将操作隔离浏览器；网页和截图可能发送给当前模型供应商，点击或提交可能改变网站数据。</p>}<div className="approval-actions"><button className="button button-quiet" onClick={() => onResolve(approval.id, false)} disabled={working}>拒绝</button><button className="button button-primary" onClick={() => onResolve(approval.id, true)} disabled={working}><Icon name="check" size={16} />{working ? '处理中…' : '批准执行'}</button></div></section>;
}

function Activity({ events }) {
  const activities = [...events].filter(event => ['tool.started', 'tool.completed', 'tool.failed', 'run.started', 'run.completed', 'run.failed', 'run.cancelled', 'approval.required', 'approval.resolved', 'question.required', 'question.resolved', 'checkpoint.created', 'checkpoint.restored', 'context.compacting', 'context.compacted', 'context.retry', 'run.continued', 'decision.started', 'decision.completed', 'decision.fallback', 'model.routed'].includes(event.type)).reverse();
  const labels = { 'question.required': '等待用户补充信息', 'question.resolved': '用户问题已处理', 'run.started': '开始运行', 'run.completed': '运行完成', 'run.failed': '运行失败', 'run.cancelled': '运行已停止', 'approval.required': '请求操作审批', 'approval.resolved': '审批已处理', 'checkpoint.created': '已保存文件快照', 'checkpoint.restored': '已恢复文件', 'context.compacting': '正在压缩上下文', 'context.compacted': '上下文已压缩，继续执行', 'context.retry': '压缩后重试', 'run.continued': '输出已自动续接', 'decision.started': '正在评估下一步', 'decision.completed': '决策完成', 'decision.fallback': '决策回退，继续当前任务', 'model.routed': '已切换执行模型' };
  if (!activities.length) return <EmptyPanel icon="activity" title="每一步，都在这里" description="运行任务后，工具调用、审批和执行结果将实时显示。" />;
  return <div className="activity-list">{activities.map(event => <details className={`activity-item ${event.type.includes('failed') ? 'activity-error' : ''}`} key={event.id}><summary><span className="activity-dot"><Icon name={event.type === 'tool.started' ? 'terminal' : event.type.includes('approval') ? 'shield' : event.type.includes('failed') ? 'alert' : 'check'} size={13} /></span><span><strong>{event.type.startsWith('tool.') ? `${toolNames[event.data?.name] || event.data?.name || '工具'}${event.type === 'tool.started' ? '' : event.type === 'tool.failed' ? ' · 失败' : ' · 完成'}` : labels[event.type]}</strong><small>{dateLabel(event.timestamp)}{event.type === 'tool.started' ? ' · 开始执行' : ''}</small></span><Icon name="chevron" size={13} /></summary><pre>{readable(event.data)}</pre>{event.data?.result?.screenshotId && <Screenshot id={event.data.result.screenshotId} />}</details>)}</div>;
}

function EmptyPanel({ icon, title, description }) {
  return <div className="panel-empty"><div><Icon name={icon} size={22} /></div><h3>{title}</h3><p>{description}</p></div>;
}

function FilesPanel({ refreshKey, onError }) {
  const [directory, setDirectory] = useState('.');
  const [files, setFiles] = useState([]);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [requestNumber, setRequestNumber] = useState(0);
  const latestRequest = useRef(0);
  useEffect(() => () => { latestRequest.current += 1; }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure('');
    api(`/files?path=${encodeURIComponent(directory)}`).then(result => { if (!cancelled) setFiles(result); }).catch(error => { if (!cancelled) setFailure(error.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [directory, refreshKey, requestNumber]);
  const navigate = nextDirectory => {
    latestRequest.current += 1;
    setFile(null);
    setDirectory(nextDirectory);
  };
  const openFile = async entry => {
    if (entry.type === 'directory') {
      navigate(entry.path);
      return;
    }
    const request = ++latestRequest.current;
    setFile({ path: entry.path, loading: true });
    try {
      const result = await api(`/file?path=${encodeURIComponent(entry.path)}`);
      if (request === latestRequest.current) setFile(result);
    } catch (error) {
      if (request === latestRequest.current) {
        setFile(null);
        onError(error.message);
      }
    }
  };
  const parent = directory.replace(/\\/g, '/').split('/').filter(Boolean).slice(0, -1).join('/') || '.';
  return <div className="files-panel" aria-busy={loading}>
    <div className="panel-toolbar"><span title={directory}><Icon name="folder" size={14} />{directory === '.' ? '工作区根目录' : directory}</span><button className="icon-button" onClick={() => setRequestNumber(value => value + 1)} aria-label="刷新文件"><Icon name="retry" size={14} /></button></div>
    {directory !== '.' && <button className="file-entry parent-directory" onClick={() => navigate(parent)}>← 返回上级目录</button>}
    {loading ? <><PixelLoader compact label="读取文件列表" detail="正在浏览你的工作区…" /><SkeletonRows /></> : failure ? <div className="error-message" role="alert">{failure}</div> : files.length ? <div className="file-list">{[...files].sort((left, right) => Number(right.type === 'directory') - Number(left.type === 'directory') || left.name.localeCompare(right.name)).map(entry => <button key={entry.path} className={`file-entry ${file?.path === entry.path ? 'selected' : ''}`} onClick={() => openFile(entry)} title={entry.path}><Icon name={entry.type === 'directory' ? 'folder' : 'file'} size={16} /><span>{entry.name}</span>{entry.type === 'directory' ? <Icon name="chevron" size={12} /> : <small>{entry.size >= 1024 ? `${(entry.size / 1024).toFixed(1)} kB` : `${entry.size ?? 0} B`}</small>}</button>)}</div> : <EmptyPanel icon="folder" title="目录为空" description="在这里创建的文件将显示在工作区中。" />}
    {file && <section className="file-preview" aria-busy={!!file.loading}>
      <div className="panel-toolbar"><span title={file.path}>{file.path}</span><button className="icon-button" aria-label="关闭文件预览" onClick={() => { latestRequest.current += 1; setFile(null); }}><Icon name="close" size={14} /></button></div>
      {file.loading ? <><PixelLoader compact label="读取文件" /><SkeletonRows count={3} /></> : <pre>{file.content || '(空文件)'}</pre>}
    </section>}
  </div>;
}

function ChangesPanel({ session, onRestore, working }) {
  const [confirmId, setConfirmId] = useState(null);
  const checkpoints = session?.checkpoints || [];
  if (!checkpoints.length) return <EmptyPanel icon="branch" title="尚无文件变更" description="代理编辑文件时会记录差异和快照，你可以查看并恢复。" />;
  return <div className="changes-list"><p className="panel-description">每次工具写入均保留快照。恢复会将文件还原到此次修改之前。</p>{[...checkpoints].reverse().map(checkpoint => <details className="change-card" key={checkpoint.id} open><summary><Icon name="file" size={15} /><strong>{checkpoint.path}</strong><span>{checkpoint.restored ? '已恢复' : dateLabel(checkpoint.createdAt)}</span></summary><pre className="diff-view">{(checkpoint.diff || '').split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>)}</pre>{!checkpoint.restored && <div className="restore-actions">{confirmId === checkpoint.id ? <><p>确认用此快照恢复文件？</p><button className="button button-quiet" onClick={() => setConfirmId(null)}>取消</button><button className="button button-danger" disabled={working || activeStatuses.has(session?.run?.status)} onClick={async () => { await onRestore(checkpoint.id); setConfirmId(null); }}>确认恢复</button></> : <button className="text-button" onClick={() => setConfirmId(checkpoint.id)} disabled={activeStatuses.has(session?.run?.status)}><Icon name="retry" size={13} />恢复到修改前</button>}</div>}</details>)}</div>;
}

function Overview({ session, settings, health, tools, onSettings }) {
  const plan = session?.plan || [];
  const completed = plan.filter(item => item.status === 'completed').length;
  const run = session?.run;
  return <div className="overview" data-running={run?.status === 'running'}>
    <section className="context-section">
      <div className="section-heading"><h3>运行环境</h3><span className="tiny-label">WORKSPACE</span></div>
      <div className="workspace-card">
        <span className="workspace-icon"><Icon name="folder" size={24} /></span>
        <div><strong>{shortPath(health?.workspace)}</strong><span title={health?.workspace}>{health?.workspace || '连接工作区…'}</span></div>
      </div>
      <dl className="context-facts">
        <div><dt>供应商</dt><dd>{settings?.providerName || '未选择'}</dd></div>
        <div><dt>API 协议</dt><dd>{providerNames[settings?.provider] || '—'}</dd></div>
        <div><dt>当前模型</dt><dd title={settings?.model}>{settings?.model || '待配置'}</dd></div>
        <div><dt>默认思考</dt><dd>{reasoningLabel(settings?.reasoning)}</dd></div>
        <div><dt>模型配置</dt><dd className={settings?.configured ? 'ready-text' : 'warning-text'}><span className={`mini-dot ${settings?.configured ? '' : 'amber'}`} />{settings?.configured ? '已配置' : '需要设置'}</dd></div>
        <div><dt>审批策略</dt><dd>{{ ask: '手动审批', auto: '自动批准', readonly: '只读模式' }[settings?.approval] || '—'}</dd></div>
      </dl>
      <button className="context-settings" onClick={onSettings}>配置模型与执行策略<Icon name="chevron" size={13} /></button>
    </section>
    <section className="context-section">
      <div className="section-heading"><h3>任务计划</h3><span className="tiny-label">{plan.length ? `${completed} / ${plan.length}` : 'QUEST LOG'}</span></div>
      {plan.length ? <>
        <div className="plan-progress"><span style={{ width: `${completed / plan.length * 100}%` }} /></div>
        <ol className="plan-list">{plan.map((item, index) => <li key={`${index}-${item.step}`} className={`plan-${item.status}`}>
          <span className="plan-indicator">{item.status === 'completed' ? <Icon name="check" size={11} /> : item.status === 'in_progress' ? <span className="mini-pulse" /> : index + 1}</span><span>{item.step}</span>
        </li>)}</ol>
      </> : <div className="plan-placeholder"><Icon name="file" size={29} /><p>从第一步，到完成。<br /><span>代理制定计划后将在此显示。</span></p></div>}
    </section>
    {run && <section className="context-section">
      <div className="section-heading"><h3>本次运行</h3><span className="tiny-label">RUN</span></div>
      <dl className="context-facts">
        <div><dt>状态</dt><dd>{statusNames[run.status] || run.status}</dd></div>
        {run.providerName && <div><dt>本次供应商</dt><dd title={run.providerName}>{run.providerName}</dd></div>}
        {run.model && <div><dt>本次模型</dt><dd title={run.model}>{run.model}</dd></div>}
        {run.reasoning && <div><dt>本次思考</dt><dd>{reasoningLabel(run.reasoning)}</dd></div>}
        <div><dt>迭代步数</dt><dd>{run.steps ?? 0}（持续执行）</dd></div>
        <div><dt>输入 / 输出 Token</dt><dd>{run.usage?.inputTokens ?? 0} / {run.usage?.outputTokens ?? 0}</dd></div>
      </dl>
      {run.modelUsage?.map((item, index) => <div className="model-usage" key={index}><strong>{{ execution: '执行', compression: '压缩', decision: '决策', summary: '总结' }[item.purpose]} · {item.model}</strong><small>{item.providerName} · {item.requests} 次请求 · 输入 {item.inputTokens} / 输出 {item.outputTokens} Token</small></div>)}
      {run.error && <div className="error-message">{run.error}</div>}
    </section>}
    <section className="context-section tools-section">
      <div className="section-heading"><h3>工具背包</h3><span className="tiny-label">{tools.length} TOOLS</span></div>
      <div className="tool-chips">{tools.map(tool => <span key={tool.name} title={`${tool.name}\n${tool.description}`}>
        <Icon name={tool.name === 'run_command' ? 'terminal' : tool.name === 'update_plan' ? 'check' : 'file'} size={13} />{toolNames[tool.name] || tool.name}
      </span>)}</div>
    </section>
    <div className="local-note"><Icon name="shield" size={19} /><p>你的工作区，你来掌控<span>会话与快照保存在本地。</span></p></div>
  </div>;
}

function Welcome({ configured, configurationIssues, onPrompt, onSettings }) {
  const suggestions = [
    { icon: 'folder', title: '阅读项目', detail: '了解结构与技术栈', prompt: '请检查当前工作区，概括项目结构、技术栈和开发启动方式。' },
    { icon: 'branch', title: '实现功能', detail: '从计划到代码落地', prompt: '先了解项目结构，然后帮我规划一个新功能的实现步骤。' },
    { icon: 'spark', title: '排查问题', detail: '找到问题的根源', prompt: '请检查项目中的代码与配置，找出潜在问题，并给出有依据的修复建议。' },
    { icon: 'terminal', title: '运行测试', detail: '验证每一处改动', prompt: '请检查项目的测试和构建脚本，规划并运行相关验证，汇报真实结果。' },
  ];
  return <div className="welcome">
    <div className="welcome-eyebrow"><span />A LITTLE IDEA. A WHOLE NEW WORLD.</div>
    <div className="welcome-intro">
      <div><h1>想法准备好了，<br /><span>一起造出来。</span></h1><p className="welcome-description">把想法放进工作区，让 AI 和你一起构建。<br />读代码、做计划、运行工具，每一步都由你掌控。</p></div>
      <VoxelScene />
    </div>
    {!configured && <section className="setup-card" aria-label="首次配置">
      <span className="setup-icon"><Icon name="settings" size={22} /></span>
      <div><strong>为工作区装上 AI 引擎</strong><p>{configurationIssues?.length ? configurationIssues.join(' · ') : '选择 API 协议，填写模型与密钥，开始真实任务。'}</p></div>
      <button className="button button-primary" onClick={onSettings}>开始配置<Icon name="chevron" size={13} /></button>
    </section>}
    <div className="quick-start-heading"><span>选择你的第一步</span><span>QUICK START</span></div>
    <div className="suggestion-grid">{suggestions.map((suggestion, index) => <button className="suggestion-card" key={suggestion.title} onClick={() => onPrompt(suggestion)}>
      <span className="suggestion-top"><span className={`suggestion-icon slot-${index}`}><Icon name={suggestion.icon} size={24} /></span><kbd>{index + 1}</kbd></span>
      <strong>{suggestion.title}</strong><span className="suggestion-detail">{suggestion.detail}<Icon name="chevron" size={11} /></span>
    </button>)}</div>
    <div className="welcome-footnote"><Icon name="shield" size={14} /><span>操作前审批</span><span className="welcome-divider">+</span><span>会话自动保存</span><span className="welcome-divider">+</span><span>原生模型协议</span></div>
  </div>;
}
function App({ sessionStorageKey = 'harness.session' }) {
  const [sessions, setSessions] = useState([]);
  const [sessionMap, setSessionMap] = useState({});
  const [selectedId, setSelectedId] = useState(() => { try { return localStorage.getItem(sessionStorageKey) || ''; } catch { return ''; } });
  const [settings, setSettings] = useState(null);
  const [health, setHealth] = useState(null);
  const [tools, setTools] = useState([]);
  const [automation, setAutomation] = useState(null);
  const [browserLiveOpen, setBrowserLiveOpen] = useState(false);
  const [browserRequestedRun, setBrowserRequestedRun] = useState('');
  const [questions, setQuestions] = useState([]);
  const [questionLoadError, setQuestionLoadError] = useState('');
  const questionSnapshot = useRef(null);
  const questionRetry = useRef(null);
  const refreshQuestions = useCallback(async () => {
    clearTimeout(questionRetry.current);
    const snapshot = { events: [] };
    questionSnapshot.current = snapshot;
    try {
      let next = await api('/questions', { signal: AbortSignal.timeout(10000) });
      if (questionSnapshot.current !== snapshot) return;
      for (const event of snapshot.events) {
        if (event.type.startsWith('question.')) next = [...next.filter(question => question.id !== event.data.id), ...(event.data.status === 'pending' ? [event.data] : [])];
        else next = next.filter(question => question.sessionId !== event.sessionId);
      }
      setQuestions(next);
      setQuestionLoadError('');
    } catch (failure) {
      if (questionSnapshot.current === snapshot) {
        setQuestionLoadError('暂时无法恢复待回答的问题，正在重新连接。');
        questionRetry.current = setTimeout(() => { void refreshQuestions().catch(() => {}); }, 1500);
      }
      throw failure;
    } finally { if (questionSnapshot.current === snapshot) questionSnapshot.current = null; }
  }, []);
  useEffect(() => () => { questionSnapshot.current = null; clearTimeout(questionRetry.current); }, []);
  const [automationLoadError, setAutomationLoadError] = useState('');
  const [automationSwitching, setAutomationSwitching] = useState(false);
  const automationSwitchingRef = useRef(false);
  const setAutomationBusy = useCallback(value => {
    automationSwitchingRef.current = value;
    setAutomationSwitching(value);
  }, []);
  const refreshAutomation = useCallback(async () => {
    setAutomationLoadError('');
    try { setAutomation(await api('/automation')); }
    catch (failure) { setAutomationLoadError(failure.message); }
  }, []);
  const [automationStopping, setAutomationStopping] = useState(false);
  const stopAutomation = async () => {
    setAutomationStopping(true);
    try { setAutomation(await api('/automation/stop', { method: 'POST', body: {} })); }
    catch (failure) { setError(failure.message); }
    finally { setAutomationStopping(false); }
  };
  const [connection, setConnection] = useState('connecting');
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const draftsRef = useRef(new Map());
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const [branchDrafts, setBranchDrafts] = useState({});
  const [branchWorking, setBranchWorking] = useState(false);
  const branchWorkingRef = useRef(false);
  const branchDraftRef = useRef(null);
  const branchOriginRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [working, setWorking] = useState('');
  const [page, setPage] = useState(() => ['#/providers', '#/settings', '#/automation', '#/extensions'].includes(window.location.hash) ? window.location.hash.slice(2) : 'workspace');
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [modelSwitching, setModelSwitching] = useState(false);
  const modelSwitchingRef = useRef(false);
  const [scopeSwitching, setScopeSwitching] = useState(false);
  const scopeSwitchingRef = useRef(false);
  const setScopeSwitchBusy = useCallback(value => {
    scopeSwitchingRef.current = value;
    setScopeSwitching(value);
  }, []);
  const [reasoningSwitching, setReasoningSwitching] = useState(false);
  const reasoningSwitchingRef = useRef(false);
  const setReasoningBusy = useCallback(value => {
    reasoningSwitchingRef.current = value;
    setReasoningSwitching(value);
  }, []);
  const settingsSequence = useRef(0);
  const setModelSwitchBusy = useCallback(value => {
    modelSwitchingRef.current = value;
    setModelSwitching(value);
  }, []);
  const refreshSettings = useCallback(async () => {
    const sequence = ++settingsSequence.current;
    const next = await api('/settings');
    if (sequence === settingsSequence.current) setSettings(next);
    return next;
  }, []);
  useEffect(() => () => { settingsSequence.current += 1; }, []);
  const [extensionsRevision, setExtensionsRevision] = useState(0);
  const navigationGuard = useRef(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const registerGuard = useCallback(guard => {
    navigationGuard.current = guard;
    return () => { if (navigationGuard.current === guard) navigationGuard.current = null; };
  }, []);
  const navigate = useCallback((destination, action) => {
    if (branchWorkingRef.current) { setError('正在创建分支，请完成后再切换页面或会话。'); return; }
    const change = () => {
      if (pageRef.current !== destination) window.history.pushState(null, '', destination === 'workspace' ? '#/' : `#/${destination}`);
      pageRef.current = destination;
      setPage(destination);
      setSidebarOpen(false);
      setInspectorOpen(false);
      action?.();
    };
    if (navigationGuard.current && (destination !== pageRef.current || action)) navigationGuard.current(change);
    else change();
  }, []);
  useEffect(() => {
    const routeChanged = () => {
      const destination = ['#/providers', '#/settings', '#/automation', '#/extensions'].includes(window.location.hash) ? window.location.hash.slice(2) : 'workspace';
      if (destination === pageRef.current) return;
      if (branchWorkingRef.current) {
        window.history.replaceState(null, '', pageRef.current === 'workspace' ? '#/' : `#/${pageRef.current}`);
        setError('正在创建分支，请完成后再切换页面。');
        return;
      }
      const change = () => {
        window.history.replaceState(null, '', destination === 'workspace' ? '#/' : `#/${destination}`);
        pageRef.current = destination;
        setPage(destination);
        setSidebarOpen(false);
        setInspectorOpen(false);
      };
      if (navigationGuard.current) {
        window.history.replaceState(null, '', pageRef.current === 'workspace' ? '#/' : `#/${pageRef.current}`);
        navigationGuard.current(change);
      } else change();
    };
    window.addEventListener('hashchange', routeChanged);
    window.addEventListener('popstate', routeChanged);
    return () => {
      window.removeEventListener('hashchange', routeChanged);
      window.removeEventListener('popstate', routeChanged);
    };
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const changeBrowserLive = useCallback(open => {
    setBrowserLiveOpen(open);
    if (open) { setInspectorOpen(false); setSidebarOpen(false); }
  }, []);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const disclaimerTrigger = useRef(null);
  const openDisclaimer = event => {
    disclaimerTrigger.current = event.currentTarget;
    setDisclaimerOpen(true);
  };
  const [inspectorTab, setInspectorTab] = useState('overview');
  const [deleteSessionId, setDeleteSessionId] = useState('');
  const [initialization, setInitialization] = useState(0);
  const textareaRef = useRef(null);
  const [composerDetails, setComposerDetails] = useState(null);
  const messageEndRef = useRef(null);
  const conversationRef = useRef(null);
  const nearBottomRef = useRef(true);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const chooseSession = useCallback(id => {
    draftsRef.current.set(selectedRef.current, promptRef.current);
    selectedRef.current = id;
    setSelectedId(id);
    setPrompt(draftsRef.current.get(id) || '');
    setError('');
  }, []);
  const currentSession = sessionMap[selectedId];
  const branchDraft = branchDrafts[selectedId];
  branchDraftRef.current = branchDraft;
  const isRunning = activeStatuses.has(currentSession?.run?.status);
  const uploads = useAttachments({ api, selectedId, provider: settings?.provider, disabled: loading || !health || submitting || creatingSession || branchWorking });
  const messages = (currentSession?.messages || []).filter(message => ['user', 'assistant'].includes(message.role) && message.content);
  const approvals = useMemo(() => {
    if (!isRunning) return [];
    const map = new Map();
    for (const event of currentSession?.events || []) {
      if (event.type === 'approval.required' || event.type === 'approval.resolved') map.set(event.data.id, event.data);
    }
    return [...map.values()].filter(approval => approval.status === 'pending' && (!currentSession.run?.id || approval.runId === currentSession.run.id));
  }, [currentSession, isRunning]);
  const loadSession = useCallback(async id => {
    const snapshot = await api(`/sessions/${encodeURIComponent(id)}`);
    setSessionMap(previous => ({ ...previous, [id]: mergeSnapshot(snapshot, previous[id]) }));
    return snapshot;
  }, []);
  const refreshSessions = useCallback(async () => {
    const result = await api('/sessions');
    setSessions(result);
    return result;
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([api('/health'), refreshSettings(), api('/tools'), api('/sessions')]).then(([nextHealth, , nextTools, nextSessions]) => {
      if (cancelled) return;
      setHealth(nextHealth);
      setTools(nextTools);
      setSessions(nextSessions);
      setSelectedId(previous => nextSessions.some(session => session.id === previous) ? previous : nextSessions[0]?.id || '');
    }).catch(loadError => { if (!cancelled) setError(loadError.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialization, refreshSettings]);
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => {
      setConnection('connected');
      refreshSettings().catch(() => {});
      refreshAutomation();
      refreshQuestions().catch(() => {});
      api('/tools').then(setTools).catch(() => {});
      setSettingsRevision(value => value + 1);
      refreshSessions().catch(() => {});
      if (selectedRef.current) loadSession(selectedRef.current).catch(() => {});
    };
    source.onerror = () => setConnection('reconnecting');
    source.addEventListener('harness', message => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === 'tool.started' && event.data?.name === 'browser') setBrowserRequestedRun(event.runId);
        if (event.type === 'question.required' || event.type === 'question.resolved') {
          questionSnapshot.current?.events.push(event);
          setQuestions(previous => [...previous.filter(question => question.id !== event.data.id), ...(event.data.status === 'pending' ? [event.data] : [])]);
        }
        if (['run.completed', 'run.cancelled', 'run.failed', 'session.deleted'].includes(event.type)) {
          questionSnapshot.current?.events.push(event);
          setQuestions(previous => previous.filter(question => question.sessionId !== event.sessionId));
        }
        if (event.type === 'automation.updated') { setAutomation(event.data); setAutomationLoadError(''); }
        if (['automation.updated', 'settings.updated', 'extensions.updated'].includes(event.type)) api('/tools').then(setTools).catch(() => {});
        if (event.type === 'extensions.updated') setExtensionsRevision(value => value + 1);
        if (event.type === 'settings.updated') {
          refreshSettings().catch(() => {});
          setSettingsRevision(value => value + 1);
        }
        if (!event.sessionId) return;
        if (event.type === 'session.deleted') {
          setSessions(previous => previous.filter(session => session.id !== event.sessionId));
          if (selectedRef.current === event.sessionId) chooseSession('');
          draftsRef.current.delete(event.sessionId);
          setBranchDrafts(previous => { const next = { ...previous }; delete next[event.sessionId]; return next; });
          return;
        }
        setSessionMap(previous => ({ ...previous, [event.sessionId]: applyEvent(previous[event.sessionId] || emptySession(event.sessionId), event) }));
        if (event.type === 'session.created' || event.type === 'message' || event.type.startsWith('run.')) {
          setSessions(previous => previous.map(session => session.id === event.sessionId ? { ...session, updatedAt: event.timestamp, run: event.data?.run || session.run } : session));
          if (event.type === 'session.created' || event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') refreshSessions().catch(() => {});
        }
      } catch {
        setError('收到无法解析的实时事件，请刷新后重试。');
      }
    });
    return () => source.close();
  }, [loadSession, refreshSessions, refreshSettings, refreshAutomation, refreshQuestions, chooseSession]);
  useEffect(() => {
    try { if (selectedId) localStorage.setItem(sessionStorageKey, selectedId); else localStorage.removeItem(sessionStorageKey); } catch {}
    if (!selectedId) { setSessionLoading(false); return; }
    let cancelled = false;
    setSessionLoading(true);
    nearBottomRef.current = true;
    loadSession(selectedId).catch(loadError => { if (!cancelled) setError(loadError.message); }).finally(() => { if (!cancelled) setSessionLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, loadSession, sessionStorageKey]);
  useEffect(() => {
    if (nearBottomRef.current) messageEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages.length, currentSession?.streaming, approvals.length, selectedId]);
  useEffect(() => {
    const keyboard = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        navigate('workspace', () => requestAnimationFrame(() => textareaRef.current?.focus()));
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault();
        navigate('providers');
      }
      if (event.key === 'Escape') {
        setBrowserLiveOpen(false);
        setSidebarOpen(false);
        setInspectorOpen(false);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, []);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }
  }, [prompt]);
  const createSession = async () => {
    if (branchWorkingRef.current) return;
    const previousId = selectedRef.current;
    const previousPrompt = promptRef.current;
    setError('');
    setCreatingSession(true);
    setPrompt('');
    setSidebarOpen(false);
    try {
      const session = await api('/sessions', { method: 'POST', body: {} });
      setSessionMap(previous => ({ ...previous, [session.id]: mergeSnapshot(session, previous[session.id]) }));
      setSessions(previous => [session, ...previous.filter(existing => existing.id !== session.id)]);
      draftsRef.current.set(previousId, previousPrompt);
      selectedRef.current = session.id;
      setSelectedId(session.id);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
      return session;
    } catch (createError) {
      setError(createError.message);
      setPrompt(previousPrompt);
      throw createError;
    } finally {
      setCreatingSession(false);
    }
  };
  const submit = async event => {
    event?.preventDefault();
    const value = prompt.trim();
    const files = uploads.ready();
    if (!files || !value && !files.length || submitting || creatingSession || isRunning || loading || branchWorkingRef.current || branchDraftRef.current || modelSwitchingRef.current || scopeSwitchingRef.current || reasoningSwitchingRef.current || automationSwitchingRef.current || automationStopping || !settings?.configured) return;
    setSubmitting(true);
    setError('');
    nearBottomRef.current = true;
    try {
      const session = selectedId ? currentSession || { id: selectedId } : await createSession();
      if (!selectedId) uploads.move(selectedId, session.id);
      await api(`/sessions/${encodeURIComponent(session.id)}/run`, { method: 'POST', body: { prompt: value, attachments: files.map(file => file.id) } });
      uploads.clear(session.id);
      setPrompt('');
      await Promise.all([loadSession(session.id), refreshSessions()]);
    } catch (runError) {
      setError(runError.message);
      setPrompt(value);
    } finally {
      setSubmitting(false);
      textareaRef.current?.focus();
    }
  };
  const act = async (key, operation) => {
    setWorking(key);
    setError('');
    try { await operation(); } catch (actionError) { setError(actionError.message); } finally { setWorking(''); }
  };
  const startBranch = (message, mode, origin) => {
    if (branchWorkingRef.current || isRunning || branchDraft) return;
    const index = currentSession.messages.findIndex(entry => entry.id === message.id);
    const user = currentSession.messages.slice(0, index + 1).findLast(entry => entry.role === 'user');
    if (mode === 'retry' && !user) { setError('这条回复没有对应的用户消息，无法重新生成。'); return; }
    branchOriginRef.current = origin;
    setBranchDrafts(previous => ({ ...previous, [selectedId]: { messageId: message.id, role: message.role, mode, prompt: mode === 'retry' ? user.content : '', attachments: mode === 'retry' ? user.attachments || [] : [], preview: String(message.content).slice(0, 180), title: '' } }));
  };
  const cancelBranch = () => {
    setBranchDrafts(previous => { const next = { ...previous }; delete next[selectedId]; return next; });
    requestAnimationFrame(() => branchOriginRef.current?.focus());
  };
  const confirmBranch = async () => {
    const draft = branchDraftRef.current;
    if (!draft || branchWorkingRef.current || isRunning || submitting || creatingSession || modelSwitchingRef.current || scopeSwitchingRef.current || reasoningSwitchingRef.current || automationSwitchingRef.current || automationStopping) return;
    if (draft.mode === 'retry' && (!settings?.configured || !draft.prompt.trim() && !draft.attachments?.length || draft.prompt.length > 200000)) return;
    if (draft.mode === 'retry' && attachmentIssue(draft.attachments || [], settings?.provider)) { setError(attachmentIssue(draft.attachments, settings?.provider)); return; }
    const sourceId = selectedId;
    branchWorkingRef.current = true;
    setBranchWorking(true);
    setError('');
    let created;
    try {
      created = await api(`/sessions/${encodeURIComponent(sourceId)}/fork`, { method: 'POST', body: { messageId: draft.messageId, mode: draft.mode, ...(draft.title.trim() ? { title: draft.title.trim() } : {}) } });
      setSessionMap(previous => ({ ...previous, [created.id]: mergeSnapshot(created, previous[created.id]) }));
      setSessions(previous => [created, ...previous.filter(session => session.id !== created.id)]);
      setBranchDrafts(previous => { const next = { ...previous }; delete next[sourceId]; return next; });
      chooseSession(created.id);
      setPrompt(draft.mode === 'retry' ? draft.prompt : '');
      nearBottomRef.current = true;
      if (draft.mode === 'retry') {
        uploads.restore(created.id, draft.attachments);
        await api(`/sessions/${encodeURIComponent(created.id)}/run`, { method: 'POST', body: { prompt: draft.prompt.trim(), attachments: (draft.attachments || []).map(file => file.id) } });
        uploads.clear(created.id);
        setPrompt('');
      }
      await Promise.all([loadSession(created.id), refreshSessions()]);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (branchError) {
      setError(created ? `分支已创建，后续操作未完成。请检查当前任务状态后继续：${branchError.message}` : `无法创建分支：${branchError.message}`);
      if (created) await loadSession(created.id).catch(() => {});
    } finally {
      branchWorkingRef.current = false;
      setBranchWorking(false);
    }
  };
  const stop = () => act('stop', async () => {
    await api(`/sessions/${encodeURIComponent(selectedId)}/cancel`, { method: 'POST' });
    await loadSession(selectedId);
  });
  const resolve = (id, approved) => act(id, async () => {
    await api(`/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { approved } });
    await loadSession(selectedId);
  });
  const answerQuestion = async (id, answer) => {
    await api(`/questions/${encodeURIComponent(id)}`, { method: 'POST', body: { answer } });
    questionSnapshot.current?.events.push({ type: 'question.resolved', data: { id } });
    setQuestions(previous => previous.filter(question => question.id !== id));
  };
  const restore = id => act(id, async () => {
    await api(`/sessions/${encodeURIComponent(selectedId)}/checkpoints/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    await loadSession(selectedId);
  });
  const removeSession = id => act(`delete-${id}`, async () => {
    await api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setSessions(previous => previous.filter(session => session.id !== id));
    setSessionMap(previous => { const next = { ...previous }; delete next[id]; return next; });
    if (selectedRef.current === id) chooseSession('');
    draftsRef.current.delete(id);
    uploads.clear(id);
    setBranchDrafts(previous => { const next = { ...previous }; delete next[id]; return next; });
    setDeleteSessionId('');
  });
  const saveSettings = async patch => {
    const next = await api('/settings', { method: 'PATCH', body: patch });
    settingsSequence.current += 1;
    setSettings(next);
    return next;
  };
  const onSuggestion = suggestion => {
    if (suggestion.settings) navigate('providers');
    else { setPrompt(suggestion.prompt); textareaRef.current?.focus(); }
  };
  const sortedSessions = [...sessions].sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
  const lastToolEvent = [...(currentSession?.events || [])].reverse().find(event => event.type.startsWith('tool.'));
  const lastTool = lastToolEvent?.type === 'tool.started' ? lastToolEvent : null;
  const hasConversation = messages.length > 0 || currentSession?.streaming;
  const pendingCount = approvals.length;
  const checkpointCount = currentSession?.checkpoints?.length || 0;
  const inspectorTabs = [{ id: 'overview', label: '概览' }, { id: 'activity', label: '活动' }, { id: 'files', label: '文件' }, { id: 'changes', label: '变更', count: checkpointCount }];

  return <div className={`studio ${browserLiveOpen && page === 'workspace' ? 'browser-live-visible' : ''} ${approvals.length ? 'browser-live-pending' : ''} ${page !== 'workspace' ? 'management-visible' : ''} ${sidebarOpen ? 'sidebar-visible' : ''} ${inspectorOpen ? 'inspector-visible' : ''}`} data-phase={loading ? 'loading' : health ? 'ready' : 'error'}>
    {(sidebarOpen || inspectorOpen) && <button className="mobile-overlay" aria-label="关闭侧栏" onClick={() => { setSidebarOpen(false); setInspectorOpen(false); }} />}
    <aside className="sidebar" aria-label="会话侧栏"><a className="brand" href="#/" onClick={event => { event.preventDefault(); navigate('workspace'); }} aria-label="青禾 Studio"><Mark /><span>青禾<span className="brand-suffix"> / Studio</span></span><span className="brand-version">{(health?.version || VERSION).split('.').slice(0, 2).join('.')}</span></a><div className="sidebar-body"><button className="new-session" onClick={() => navigate('workspace', () => createSession().catch(() => {}))} disabled={loading || !health || creatingSession || branchWorking} aria-busy={creatingSession}>{creatingSession ? <PixelActivity /> : <Icon name="plus" size={17} />}<span>新建会话</span><kbd>＋</kbd></button><div className="sidebar-section-title"><span>工作会话</span><span>{sessions.length.toString().padStart(2, '0')}</span></div><nav className="sessions" aria-label="会话列表">{loading ? <SkeletonRows count={3} /> : sortedSessions.length ? sortedSessions.map(session => {
      const sessionRun = sessionMap[session.id]?.run || session.run;
      return <div className={`session-item ${session.id === selectedId ? 'active' : ''}`} key={session.id}><button className="session-select" aria-current={session.id === selectedId ? 'page' : undefined} disabled={branchWorking} onClick={() => navigate('workspace', () => chooseSession(session.id))}><Icon name={session.branch ? 'branch' : 'chat'} size={16} /><span><strong>{session.title || '新会话'}</strong><small>{session.branch && '分支 · '}{activeStatuses.has(sessionRun?.status) ? statusNames[sessionRun.status] : `${dateLabel(session.updatedAt || session.createdAt)} · ${session.messageCount ?? session.messages?.length ?? 0} 条消息`}</small></span>{activeStatuses.has(sessionRun?.status) && <span className="session-running" />}</button><button className="session-delete icon-button" aria-label={`删除会话 ${session.title || '新会话'}`} onClick={() => setDeleteSessionId(session.id)} disabled={branchWorking || activeStatuses.has(sessionRun?.status)}><Icon name="trash" size={13} /></button>{deleteSessionId === session.id && <div className="delete-confirm"><p>删除此会话及其历史？</p><div><button onClick={() => setDeleteSessionId('')}>取消</button><button className="danger-text" onClick={() => removeSession(session.id)} disabled={working === `delete-${session.id}`}>确认删除</button></div></div>}</div>;
    }) : <div className="sidebar-placeholder"><Icon name="chat" size={19} /><p>为下一个想法<br />留一个新会话。</p></div>}</nav><div className="sidebar-bottom"><div className="workspace-label"><Icon name="folder" size={15} /><span title={health?.workspace}>{shortPath(health?.workspace)}</span><span className="mini-dot" /></div><button className="sidebar-settings" aria-current={page === 'providers' ? 'page' : undefined} onClick={() => navigate('providers')}><Icon name="spark" size={17} /><span>供应商与模型</span><kbd>⌘ ,</kbd></button><button className="sidebar-settings" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Icon name="shield" size={17} /><span>运行策略</span></button><button className="sidebar-settings" aria-current={page === 'automation' ? 'page' : undefined} onClick={() => navigate('automation')}><Icon name="panel" size={17} /><span>电脑与浏览器</span>{(automation?.browser || automation?.desktop) && <span className="mini-dot" />}</button><button className="sidebar-settings" aria-current={page === 'extensions' ? 'page' : undefined} onClick={() => navigate('extensions')}><Icon name="link" size={17} /><span>技能与 MCP</span></button><SponsorshipButton Icon={Icon} /><button type="button" className="sidebar-settings" aria-haspopup="dialog" aria-expanded={disclaimerOpen} onClick={openDisclaimer}><Icon name="info" size={17} /><span>使用声明</span></button><div className="sidebar-footer"><span>Qn · LOCAL FIRST</span><span>v{health?.version || VERSION}</span></div></div></div></aside>
    <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="打开会话侧栏" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><span className="breadcrumb-workspace">Workspace</span><span className="breadcrumb-slash">/</span><span className="breadcrumb-current">{page === 'providers' ? '供应商与模型' : page === 'settings' ? '运行策略' : page === 'automation' ? '电脑与浏览器' : page === 'extensions' ? '技能与 MCP' : currentSession?.title || '新会话'}</span></div><div className="topbar-actions">{automation?.browser && <button className="live-view-button" aria-label="打开浏览器实时画面" aria-pressed={browserLiveOpen} onClick={() => changeBrowserLive(!browserLiveOpen)}>▣ 实时画面</button>}{(automation?.browser || automation?.desktop) && <button className="automation-stop" disabled={automationStopping} aria-busy={automationStopping} onClick={stopAutomation}>{automationStopping ? '正在停止…' : '停止自动化'}</button>}<span className={`connection-status ${connection}`}><span />{connection === 'connected' ? '本地已连接' : connection === 'reconnecting' ? '正在重连' : '连接中'}</span><span className={`model-readiness ${settings?.configured ? 'ready' : 'pending'}`}><Icon name={settings?.configured ? 'check' : 'settings'} size={12} />{settings?.configured ? '模型已配置' : '模型待配置'}</span><span className="topbar-divider" /><button className="icon-button" aria-label="管理供应商" title="供应商与模型 · Ctrl+," onClick={() => navigate('providers')}><Icon name="settings" size={17} /></button><button hidden={page !== 'workspace'} className={`icon-button inspector-toggle ${inspectorOpen ? 'selected' : ''}`} aria-label="切换工作区面板" title="工作区面板" onClick={() => { setInspectorOpen(value => !value); setBrowserLiveOpen(false); }}><Icon name="panel" size={18} /></button></div></header>
    <main className="main-panel" hidden={page !== 'workspace'} aria-busy={loading || sessionLoading}><div className="conversation-topline"><div className="agent-label"><span className={`agent-online ${settings?.configured ? '' : 'unconfigured'}`} /><span>青禾 Studio</span><span className="agent-edition">YOUR BUILD COMPANION</span></div><span className="conversation-mode"><Icon name="shield" size={13} />{{ ask: '操作前审批', auto: '自动执行', readonly: '只读模式' }[settings?.approval] || '本地工作区'}</span></div>
      {error && <div className="global-error" role="alert"><Icon name="alert" size={16} /><span>{error}</span>{!health && <button className="text-button" onClick={() => setInitialization(value => value + 1)}>重试连接</button>}<button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><Icon name="close" size={15} /></button></div>}
      {health?.version && health.version !== VERSION && <div className="runtime-version-warning" role="status">前端 v{VERSION} / 后台 v{health.version}：后台仍在运行其他版本。请在启动 WebUI 的终端停止并重新运行 npm run web，然后刷新网页；已有会话和配置保留，新功能可能尚不可用。</div>}
      <SessionBranches session={currentSession} sessions={sessions} onSelect={id => navigate('workspace', () => chooseSession(id))} disabled={branchWorking} Icon={Icon} />
      {connection === 'reconnecting' && <div className="reconnect-banner"><PixelActivity />连接中断，正在自动恢复。会话保存在本地。</div>}
      {!loading && sessionLoading && currentSession && <div className="session-refresh"><PixelLoader compact label="正在载入会话" /></div>}
      <div className={`conversation ${hasConversation ? 'has-messages' : ''}`} ref={conversationRef} onScroll={() => { const element = conversationRef.current; nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 110; }} aria-label="对话记录" role="log" aria-live="polite">
        {loading || sessionLoading && !currentSession ? <div className="main-loading"><PixelLoader label={loading ? '正在载入工作区' : '正在载入会话'} detail={loading ? '正在连接本地服务，整理会话与工具…' : '正在取回消息、执行记录与文件快照…'} /></div> : !health ? <div className="load-failure"><EmptyPanel icon="alert" title="工作区暂时未连接" description="请检查本地服务，并点击上方的重试连接。你的会话仍保存在本地。" /></div> : !hasConversation ? <Welcome configured={settings?.configured} configurationIssues={settings?.configurationIssues} onPrompt={onSuggestion} onSettings={() => navigate('providers')} /> : <div className="messages">
          {messages.map(message => <article className={`message message-${message.role}`} key={message.id} data-message-id={message.id}><div className="message-avatar">{message.role === 'assistant' ? <Mark small /> : <span>你</span>}</div><div className="message-body"><div className="message-heading"><strong>{message.role === 'assistant' ? '青禾 Studio' : '你'}</strong>{message.role === 'assistant' && <span className="message-model">AGENT</span>}<time>{dateLabel(message.createdAt)}</time></div><AttachmentList items={message.attachments} api={api} Icon={Icon} /><Markdown text={typeof message.content === 'string' ? message.content : readable(message.content)} />{message.toolCalls?.length > 0 && <div className="message-tools">{message.toolCalls.map((tool, index) => <span key={tool.id || index}><Icon name="terminal" size={12} />{toolNames[tool.name || tool.function?.name] || tool.name || tool.function?.name}</span>)}</div>}<MessageActions message={message} disabled={branchWorking || isRunning || loading || sessionLoading || submitting || creatingSession || !!branchDraft} onStart={startBranch} Icon={Icon} />{branchDraft?.messageId === message.id && <BranchEditor api={api} draft={branchDraft} onChange={patch => setBranchDrafts(previous => ({ ...previous, [selectedId]: { ...previous[selectedId], ...patch } }))} onCancel={cancelBranch} onConfirm={confirmBranch} busy={branchWorking} blocked={isRunning || submitting || creatingSession || scopeSwitching || modelSwitching || reasoningSwitching || automationSwitching || automationStopping} canSend={settings?.configured} model={settings?.model ? `${settings.model} · 思考：${reasoningLabel(settings.reasoning)}` : undefined} Icon={Icon} />}</div></article>)}
          {currentSession?.streaming && <article className="message message-assistant streaming-message"><div className="message-avatar"><Mark small /></div><div className="message-body"><div className="message-heading"><strong>青禾 Studio</strong><span className="message-model">STREAMING</span></div><Markdown text={currentSession.streaming} /><span className="stream-cursor" /></div></article>}
          {isRunning && !currentSession?.streaming && !pendingCount && <div className="run-thinking"><PixelActivity /><span>{currentSession?.run?.status === 'waiting_input' ? '等待你的回答…' : lastTool && currentSession.events.indexOf(lastTool) > currentSession.events.findLastIndex(event => event.type === 'run.started') ? `${toolNames[lastTool.data?.name] || lastTool.data?.name}…` : '正在处理你的任务…'}</span><button onClick={() => { setInspectorTab('activity'); setInspectorOpen(true); }}>查看活动<Icon name="chevron" size={12} /></button></div>}
          {currentSession?.run?.status === 'failed' && <div className="run-result run-error"><Icon name="alert" size={15} />{currentSession.run.error || '运行失败，请检查设置后重试。'}</div>}
          {currentSession?.run?.status === 'cancelled' && <div className="run-result"><Icon name="stop" size={14} />运行已停止。你可以继续发送消息。</div>}
        </div>}
        {pendingCount > 0 && <div className="approvals">{approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} onResolve={resolve} working={working === approval.id} />)}</div>}<div ref={messageEndRef} className="message-end" />
      </div>
      <div className="composer-area">{health && !settings?.configured && !loading && <div className="setup-banner"><Icon name="settings" size={14} /><span>配置模型后，即可发送任务。</span><button onClick={() => navigate('providers')}>配置模型<Icon name="chevron" size={12} /></button></div>}<form className={`composer ${isRunning ? 'composer-running' : ''} ${uploads.dragging ? 'composer-dragging' : ''}`} onSubmit={submit} {...uploads.events}><label className="sr-only" htmlFor="prompt">发送给 青禾 Studio 的任务</label><textarea id="prompt" ref={textareaRef} rows="2" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={!settings?.configured ? '先配置模型，再把你的下一个想法放在这里…' : isRunning ? '代理正在执行任务，你可以先写下下一条消息…' : '描述你的任务，一起把想法变成代码…'} disabled={loading || !health || creatingSession || branchWorking} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} /><AttachmentList items={uploads.items} api={api} onRemove={uploads.remove} onRetry={uploads.retry} disabled={submitting || branchWorking} Icon={Icon} />{uploads.items.length > 0 && <p className="attachment-notice">附件保存在当前工作区；发送后提供给当前模型供应商。图片 / PDF 需模型支持；视频仅发送抽帧，不含音轨。</p>}{uploads.error && <p className="attachment-notice error" role="alert">{uploads.error}{uploads.dismissible && <button type="button" className="text-button" onClick={uploads.dismissError}>关闭提示</button>}</p>}{uploads.dragging && <div className="attachment-drop-hint">松开以导入图片、文档或音视频</div>}<div className="composer-toolbar"><div className="composer-controls"><AttachmentButton onFiles={uploads.importFiles} disabled={loading || !health || submitting || creatingSession || branchWorking} Icon={Icon} /><ModelPicker settings={settings} revision={settingsRevision} api={api} onChanged={refreshSettings} onBusyChange={setModelSwitchBusy} onManage={() => navigate('providers')} visible={page === 'workspace'} disabled={loading || !health || submitting || creatingSession || branchWorking || scopeSwitching || reasoningSwitching} isRunning={isRunning} Icon={Icon} />{settings?.activeModelId && <ReasoningPicker settings={settings} api={api} onChanged={refreshSettings} onBusyChange={setReasoningBusy} disabled={loading || !health || submitting || creatingSession || branchWorking || scopeSwitching || modelSwitching} isRunning={isRunning} visible={page === 'workspace'} detailTarget={composerDetails} versionMismatch={!!health?.version && health.version !== VERSION} />}<AutomationSwitches api={api} state={automation} onState={setAutomation} loadError={automationLoadError} onReload={refreshAutomation} settings={settings} disabled={loading || !health || submitting || creatingSession || branchWorking || automationStopping} visible={page === 'workspace'} isRunning={isRunning} onBusyChange={setAutomationBusy} detailTarget={composerDetails} Icon={Icon} /></div>{isRunning ? <button type="button" className="stop-button" aria-label="停止运行" onClick={stop} disabled={working === 'stop'} aria-busy={working === 'stop'}><Icon name="stop" size={14} />停止</button> : <button className="send-button" type="submit" aria-label="发送任务" aria-busy={submitting} disabled={(!prompt.trim() && !uploads.items.length) || uploads.blocked || submitting || creatingSession || branchWorking || !!branchDraft || scopeSwitching || modelSwitching || reasoningSwitching || automationSwitching || automationStopping || loading || !health || !settings?.configured}>{submitting ? <PixelActivity /> : <Icon name="arrow" size={20} />}</button>}</div><div className="composer-details" ref={setComposerDetails} /></form><div className="composer-footer"><span><kbd>⇧ Enter</kbd> 换行 <span className="footer-dot">·</span> <kbd>Ctrl K</kbd> 聚焦输入</span><div className="composer-usage-note"><span>仅限合法、获授权的用途；AI 输出与自动操作需自行核验。</span><button type="button" aria-haspopup="dialog" aria-expanded={disclaimerOpen} onClick={openDisclaimer}>使用声明</button></div></div></div>
    </main>
    <aside className="inspector" hidden={page !== 'workspace' || browserLiveOpen} aria-label="工作区面板"><div className="inspector-heading"><span>工作区面板</span><button className="icon-button mobile-inspector-close" aria-label="关闭工作区面板" onClick={() => setInspectorOpen(false)}><Icon name="close" size={15} /></button><Icon name="panel" size={15} className="inspector-heading-icon" /></div><div className="inspector-tabs" role="tablist" aria-label="工作区信息">{inspectorTabs.map(tab => <button role="tab" id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`} aria-selected={inspectorTab === tab.id} className={inspectorTab === tab.id ? 'selected' : ''} key={tab.id} onClick={() => setInspectorTab(tab.id)}>{tab.label}{tab.count > 0 && <span>{tab.count}</span>}</button>)}</div><div className="inspector-content" role="tabpanel" id={`panel-${inspectorTab}`} aria-labelledby={`tab-${inspectorTab}`}>{inspectorTab === 'overview' && <Overview session={currentSession} settings={settings} health={health} tools={tools} onSettings={() => navigate('providers')} />}{inspectorTab === 'activity' && <Activity events={currentSession?.events || []} />}{inspectorTab === 'files' && <FilesPanel refreshKey={checkpointCount + (currentSession?.checkpoints || []).filter(checkpoint => checkpoint.restored).length} onError={setError} />}{inspectorTab === 'changes' && <ChangesPanel session={currentSession} onRestore={restore} working={!!working} />}</div><div className="inspector-footer"><span className="mini-dot" />{connection === 'connected' ? '事件流已连接' : '等待连接'}<span>SSE</span></div></aside>
    {page === 'extensions' && <ExtensionsPage api={api} revision={extensionsRevision} registerGuard={registerGuard} onNavigate={navigate} Icon={Icon} />}
    {page === 'automation' && <AutomationPage api={api} state={automation} onState={setAutomation} onNavigate={navigate} settings={settings} Icon={Icon} />}
    {['providers', 'settings'].includes(page) && <ManagementPage toolsRevision={extensionsRevision} backendVersion={health?.version} key="management" page={page} settings={settings} revision={settingsRevision} api={api} onChanged={refreshSettings} onSaveSettings={saveSettings} onScopeBusyChange={setScopeSwitchBusy} onNavigate={navigate} registerGuard={registerGuard} isRunning={sessions.some(session => activeStatuses.has((sessionMap[session.id]?.run || session.run)?.status))} Icon={Icon} />}
    {disclaimerOpen && <DisclaimerDialog trigger={disclaimerTrigger} onClose={() => setDisclaimerOpen(false)} Icon={Icon} />}
    <BrowserLive api={api} enabled={!!automation?.browser} open={browserLiveOpen && page === 'workspace'} onOpenChange={changeBrowserLive} requestedRun={browserRequestedRun} />
    <QuestionInbox questions={questions} selectedId={selectedId} loadError={questionLoadError} onRetry={() => refreshQuestions().catch(() => {})} onSelect={id => navigate('workspace', () => chooseSession(id))} onAnswer={answerQuestion} onCancel={id => api(`/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' })} />
  </div>;
}

createRoot(document.getElementById('root')).render(window.location.hash === '#orb' && window.harnessDesktop?.getOrbState ? <Orb /> : window.harnessDesktop ? <DesktopShell Studio={App} Mark={Mark} Icon={Icon} Landscape={VoxelScene} /> : <App />);

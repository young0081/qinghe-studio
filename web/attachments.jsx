import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { attachmentAccept, attachmentExtensions, attachmentIssue, attachmentSize, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL, MAX_ATTACHMENTS } from '../src/core/attachment-types.js';
import { PixelActivity, PixelLoader } from './motion.jsx';
import './attachments.css';

function readData(file, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取文件，请重新选择'));
    reader.onabort = () => reject(new DOMException('导入已取消', 'AbortError'));
    reader.onloadend = () => signal.removeEventListener('abort', abort);
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(file);
  });
}

function mediaEvent(element, name, action, signal) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); element.removeEventListener(name, done); element.removeEventListener('error', failed); signal.removeEventListener('abort', cancelled); };
    const done = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error('浏览器无法解码该视频，请转为 H.264 MP4 或 WebM')); };
    const cancelled = () => { clean(); reject(signal.reason); };
    const timer = setTimeout(() => { clean(); reject(new Error('视频解码超时，请缩短视频或换用支持的编码')); }, 15000);
    element.addEventListener(name, done, { once: true });
    element.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled(); else action();
  });
}

async function videoFrames(file, signal) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  try {
    await mediaEvent(video, 'loadeddata', () => { video.src = url; video.load(); }, signal);
    if (video.duration === Infinity) await mediaEvent(video, 'seeked', () => { video.currentTime = 10000000; }, signal);
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('视频时长须为 0–10 分钟');
    if (!video.videoWidth || !video.videoHeight) throw new Error('视频没有可读取的画面');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    const count = Math.min(6, Math.max(1, Math.ceil(duration / 5)));
    const frames = [];
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      const time = duration * (index + .5) / count;
      await mediaEvent(video, 'seeked', () => { video.currentTime = time; }, signal);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ time, data: canvas.toDataURL('image/jpeg', .75).split(',')[1] });
    }
    return { duration, frames };
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}

export function useAttachments({ api, selectedId, provider, disabled }) {
  const [drafts, setDrafts] = useState({});
  const [errors, setErrors] = useState({});
  const [dragging, setDragging] = useState(false);
  const draftsRef = useRef({});
  const controllers = useRef(new Map());
  const depth = useRef(0);
  const alive = useRef(true);
  const update = (key, transform) => {
    if (!alive.current) return;
    draftsRef.current = { ...draftsRef.current, [key]: transform(draftsRef.current[key] || []) };
    setDrafts(draftsRef.current);
  };
  const locate = clientId => Object.keys(draftsRef.current).find(key => draftsRef.current[key].some(item => item.clientId === clientId));
  useEffect(() => {
    alive.current = true;
    const protect = event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', protect);
    window.addEventListener('drop', protect);
    return () => { alive.current = false; controllers.current.forEach(controller => controller.abort()); window.removeEventListener('dragover', protect); window.removeEventListener('drop', protect); };
  }, []);
  useEffect(() => { depth.current = 0; setDragging(false); }, [selectedId]);
  const upload = async item => {
    const controller = new AbortController();
    controllers.current.set(item.clientId, controller);
    try {
      const extension = item.name.split('.').at(-1).toLowerCase();
      const video = ['mp4', 'webm'].includes(extension) ? await videoFrames(item.file, controller.signal) : {};
      const data = await readData(item.file, controller.signal);
      const key = locate(item.clientId);
      if (key === undefined) return;
      update(key, files => files.map(file => file.clientId === item.clientId ? { ...file, status: 'uploading' } : file));
      const metadata = await api('/attachments', { method: 'POST', signal: controller.signal, body: { name: item.name, data, ...video } });
      const destination = locate(item.clientId);
      if (destination === undefined) { api(`/attachments/${metadata.id}`, { method: 'DELETE' }).catch(() => {}); return; }
      update(destination, files => files.map(file => file.clientId === item.clientId ? { ...metadata, clientId: item.clientId, status: 'ready' } : file));
    } catch (failure) {
      if (controller.signal.aborted) return;
      const key = locate(item.clientId);
      if (key !== undefined) update(key, files => files.map(file => file.clientId === item.clientId ? { ...file, status: 'error', error: failure.message } : file));
    } finally { controllers.current.delete(item.clientId); }
  };
  const importFiles = files => {
    if (disabled) return;
    const key = selectedId;
    setErrors(previous => ({ ...previous, [key]: '' }));
    const rejected = [];
    for (const file of files) {
      const existing = draftsRef.current[key] || [];
      const extension = file.name.split('.').at(-1).toLowerCase();
      if (!attachmentExtensions.includes(extension)) { rejected.push(`${file.name}：不支持此格式或文件夹，请导出为 PDF、UTF-8 文本或新版 Office 文档`); continue; }
      if (!file.size || file.size > MAX_ATTACHMENT_BYTES) { rejected.push(`${file.name}：文件须为 1 字节–20 MB`); continue; }
      if (existing.length >= MAX_ATTACHMENTS || existing.reduce((sum, item) => sum + item.size, 0) + file.size > MAX_ATTACHMENT_TOTAL) { rejected.push('每条消息最多 8 个附件，合计不超过 40 MB'); break; }
      const item = { clientId: crypto.randomUUID(), name: file.name, size: file.size, file, status: 'reading' };
      update(key, previous => [...previous, item]);
      upload(item);
    }
    if (rejected.length) setErrors(previous => ({ ...previous, [key]: rejected.join('；') }));
  };
  const remove = item => {
    controllers.current.get(item.clientId)?.abort();
    const key = locate(item.clientId);
    if (key !== undefined) update(key, files => files.filter(file => file.clientId !== item.clientId));
    if (item.id) api(`/attachments/${item.id}`, { method: 'DELETE' }).catch(() => {});
  };
  const retry = item => {
    const key = locate(item.clientId);
    if (key === undefined || controllers.current.has(item.clientId)) return;
    update(key, files => files.map(file => file.clientId === item.clientId ? { ...file, status: 'reading', error: '' } : file));
    upload(item);
  };
  const move = (from, to) => {
    if (from === to) return;
    const files = draftsRef.current[from] || [];
    update(to, () => files);
    update(from, () => []);
  };
  const restore = (key, files) => update(key, () => (files || []).map(file => ({ ...file, clientId: crypto.randomUUID(), status: 'ready' })));
  const items = drafts[selectedId] || [];
  const blocked = items.some(item => item.status !== 'ready') || !!attachmentIssue(items, provider);
  const ready = () => {
    const files = draftsRef.current[selectedId] || [];
    return files.some(file => file.status !== 'ready') || attachmentIssue(files, provider) ? null : files;
  };
  return { items, blocked, ready, dragging, importFiles, remove, retry, move, restore, clear: key => update(key, () => []), error: errors[selectedId] || attachmentIssue(items, provider), dismissible: !!errors[selectedId],
    dismissError: () => setErrors(previous => ({ ...previous, [selectedId]: '' })),
    events: {
      onPaste: event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); importFiles(files); } },
      onDragEnter: event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); depth.current++; setDragging(true); } },
      onDragOver: event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } },
      onDragLeave: () => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); },
      onDrop: event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); depth.current = 0; setDragging(false); importFiles([...event.dataTransfer.files]); } },
    },
  };
}

export function AttachmentButton({ onFiles, disabled, Icon }) {
  const input = useRef(null);
  return <><input ref={input} type="file" multiple accept={attachmentAccept} className="sr-only" aria-label="导入附件文件" tabIndex={-1} disabled={disabled} onChange={event => { onFiles([...event.target.files]); event.target.value = ''; }} /><button type="button" className="attachment-add" aria-label="添加附件" title="添加图片、文档或音视频，也可粘贴 / 拖入（每个 ≤20 MB）" disabled={disabled} onClick={() => input.current?.click()}><Icon name="plus" size={16} /></button></>;
}

function AttachmentPreview({ item, api, onClose }) {
  const [file, setFile] = useState(item);
  const [error, setError] = useState('');
  const dialog = useRef(null);
  useEffect(() => {
    const origin = document.activeElement;
    dialog.current.showModal();
    let cancelled = false;
    api(`/attachments/${item.id}`).then(value => { if (!cancelled) setFile(value); }).catch(failure => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; origin?.focus(); };
  }, [item.id, api]);
  const source = `/api/attachments/${item.id}/content`;
  return createPortal(<dialog className="attachment-preview" ref={dialog} aria-label={`附件预览 ${item.name}`} onCancel={event => { event.preventDefault(); onClose(); }}><header><strong>{file.name}</strong><button type="button" className="button button-quiet" onClick={onClose} autoFocus>关闭预览</button></header><p>{attachmentSize(file.size)} · {file.note}</p>{error ? <p role="alert">{error}</p> : file.kind === 'image' ? <img src={source} alt={file.name} onError={() => setError('附件图像不可用或已移除')} /> : file.kind === 'audio' ? <audio controls src={source} onError={() => setError('浏览器无法播放此音频')} /> : file.kind === 'video' ? <video controls src={source} onError={() => setError('浏览器无法播放此视频')} /> : file.preview !== undefined ? <pre>{file.preview || '（文档中没有可提取的文字）'}</pre> : file.kind === 'pdf' ? <p>PDF 原文件已导入，将作为原生文档发送给支持 PDF 的模型；此处不运行 PDF 内嵌内容。</p> : <PixelLoader compact label="正在载入附件预览" />}</dialog>, document.body);
}

export function AttachmentList({ items = [], api, onRemove, onRetry, disabled, Icon }) {
  const [preview, setPreview] = useState(null);
  if (!items.length) return null;
  return <div className="attachment-list" role="group" aria-label={onRemove ? '待发送附件' : '消息附件'}>{items.map(item => <div className={`attachment-chip ${item.status === 'error' ? 'failed' : ''}`} key={item.clientId || item.id} data-attachment-id={item.id}>
    <button type="button" className="attachment-open" disabled={!item.id} onClick={() => setPreview(item)} title={`${item.name} · ${item.note || item.error || '正在导入'}`} aria-label={`预览附件 ${item.name}`}>
      {item.id && ['image', 'video'].includes(item.kind) ? <img src={`/api/attachments/${item.id}/content${item.kind === 'video' ? '?thumbnail=1' : ''}`} alt="" loading="lazy" /> : ['reading', 'uploading'].includes(item.status) ? <PixelActivity /> : <Icon name="file" size={19} />}
      <span><strong>{item.name}</strong><small>{item.status === 'reading' ? '读取 / 本地处理…' : item.status === 'uploading' ? '导入工作区…' : item.status === 'error' ? '导入失败' : `${attachmentSize(item.size)}${item.kind === 'video' ? ` · ${item.frameCount} 帧，无音轨` : item.truncated ? ' · 文字已截断' : ''}`}</small></span>
    </button>
    {item.status === 'error' && <button type="button" className="text-button" disabled={disabled} onClick={() => onRetry(item)} aria-label={`重试导入 ${item.name}`}>重试</button>}
    {onRemove && <button type="button" className="attachment-remove" disabled={disabled} onClick={() => onRemove(item)} aria-label={`移除附件 ${item.name}`}><Icon name="close" size={12} /></button>}
    {item.error && <span className="attachment-item-error" role="alert">{item.error}</span>}
  </div>)}{preview && <AttachmentPreview item={preview} api={api} onClose={() => setPreview(null)} />}</div>;
}

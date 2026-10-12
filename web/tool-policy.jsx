import React, { useEffect, useState } from 'react';
import './tool-policy.css';

const labels = { browser: '浏览器操作', computer: '桌面操作', write_file: '写入文件', edit_file: '编辑文件', run_command: '执行命令', save_memory: '保存记忆', web_fetch: '网页抓取 · WebFetch', web_search: '网页搜索 · WebSearch' };

export default function ToolPolicyEditor({ api, revision, value, onChange, mode }) {
  const [tools, setTools] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api('/tool-policies', { signal: controller.signal }).then(next => {
      if (!controller.signal.aborted) setTools(next);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [api, revision, retry]);
  const known = new Set((tools || []).map(tool => tool.name));
  const entries = [...(tools || []).filter(tool => tool.requiresApproval), ...value.filter(name => !known.has(name)).map(name => ({ name, description: '当前未加载的工具；再次加载同名工具时适用。', requiresApproval: true, available: false }))];
  const toggle = (name, checked) => onChange(checked ? [...new Set([...value, name])].sort() : value.filter(item => item !== name));
  return <section className="tool-policy" aria-label="按工具设置免审批">
    <h3>免审批工具</h3>
    <p>勾选后，该工具在「请求审批」模式下直接执行；未勾选的工具仍逐次审批。保存后立即生效，匹配的待审批请求也会继续。</p>
    {mode !== 'ask' && <p className="tool-policy-mode" role="status">{mode === 'auto' ? '当前为自动批准：所有已启用工具都无需审批，以下名单将在切回请求审批时生效。' : '当前为只读模式：免审批名单不会放开写入、命令、MCP 或自动化权限。'}</p>}
    {error ? <p role="alert">工具列表载入失败：{error} <button type="button" className="text-button" onClick={() => setRetry(previous => previous + 1)}>重试工具列表</button></p> : !tools ? <p role="status">正在载入工具…</p> : <div className="tool-policy-list">{entries.map(tool => <label className="tool-policy-row" key={tool.name}>
      <input type="checkbox" aria-label={`免审批 ${tool.name}`} checked={value.includes(tool.name)} onChange={event => toggle(tool.name, event.target.checked)} />
      <span><strong>{labels[tool.name] || tool.name}<code>{tool.name}</code></strong><span>{tool.description}</span>{!tool.available && <small>当前未启用；此设置不会自动启用工具。</small>}</span>
    </label>)}</div>}
    {tools && <p className="tool-policy-reads">读取文件、搜索文件、WebFetch、WebSearch、计划和提问等工具原本无需审批。网络工具会把网址或搜索词发送给目标网站。</p>}
  </section>;
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import './extensions.css';

const template = '---\nname: project-review\ndescription: 检查项目代码并提出经过验证的改进建议。\n---\n\n先读取 AGENTS.md 和项目清单。检查相关代码，给出文件路径与依据。\n需要修改时，保持改动范围清晰，运行相关检查，并如实汇报结果。\n';
const initialMcp = { name: '', transport: 'stdio', command: 'npx', args: '[]', url: '', envAllow: '', tokenEnv: '', secrets: '', clearSecrets: false };
const labels = { disabled: '已停用', connecting: '连接中', connected: '已连接', error: '连接失败' };
const encode = encodeURIComponent;

async function base64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(new Error('无法读取文件'));
    reader.readAsDataURL(file);
  });
}

export default function ExtensionsPage({ api, revision, registerGuard, onNavigate, Icon }) {
  const [tab, setTab] = useState('skills');
  const [skills, setSkills] = useState([]);
  const [mcp, setMcp] = useState({ servers: [] });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [editor, setEditor] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const dialog = useRef(null);
  const pending = useRef(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const jsonInput = useRef(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    const results = await Promise.allSettled([api('/skills'), api('/mcp')]);
    if (!mounted.current || current !== sequence.current) return;
    if (results[0].status === 'fulfilled') setSkills(results[0].value);
    if (results[1].status === 'fulfilled') setMcp(results[1].value);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) setNotice({ error: true, text: failure.reason.message });
    setLoading(false);
  }, [api]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => { refresh(); }, [refresh, revision]);
  useEffect(() => {
    Promise.resolve(window.harnessDesktop?.setUnsavedChanges?.(dirty || busy)).catch(() => {});
    const prevent = event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy]);
  useEffect(() => () => { Promise.resolve(window.harnessDesktop?.setUnsavedChanges?.(false)).catch(() => {}); }, []);
  const guard = useCallback(action => {
    if (busyRef.current) { setNotice({ text: '操作正在进行，请稍候。' }); return; }
    if (!dirtyRef.current) { action(); return; }
    pending.current = () => { setEditor(null); setDraft(null); setSaved(null); action(); };
    setConfirmation({ title: '有未保存的更改', detail: '离开编辑会放弃未保存的内容。', label: '放弃更改' });
  }, []);
  useEffect(() => registerGuard(guard), [registerGuard, guard]);
  useEffect(() => { if (confirmation) dialog.current?.showModal(); }, [confirmation]);

  const select = (nextEditor, value) => { setEditor(nextEditor); setDraft(value); setSaved(value); };
  const change = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const work = async (operation, success) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try { await operation(); if (mounted.current) { if (success) setNotice({ text: success }); await refresh(); } }
    catch (error) { if (mounted.current) setNotice({ error: true, text: error.message }); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const openSkill = name => guard(() => work(async () => {
    const result = await api(`/skills/${encode(name)}`);
    select({ type: 'skill', existing: name, files: result.files }, { name, content: result.content });
  }));
  const openMcp = entry => guard(() => {
    const config = entry.configuration;
    select({ type: 'mcp', existing: entry.name }, { ...initialMcp, ...config, name: entry.name, args: JSON.stringify(config.args || [], null, 2), envAllow: (config.envAllow || []).join(', '), secrets: '' });
  });
  const importFiles = files => guard(() => work(async () => {
    if (!files.length) return;
    if (files.length > 256 || files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) throw new Error('每个技能包最多 256 个文件、共 8 MiB');
    let body;
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) body = { zip: await base64(files[0]) };
    else body = { files: await Promise.all(files.map(async file => ({ path: file.webkitRelativePath || file.name, data: await base64(file) }))) };
    const result = await api('/skills', { method: 'POST', body });
    select({ type: 'skill', existing: result.name, files: result.files }, { name: result.name, content: result.content });
  }, '技能已导入，检查内容后可在列表中启用。'));
  const save = event => {
    event.preventDefault();
    work(async () => {
      if (editor.type === 'skill') {
        const result = await api(editor.existing ? `/skills/${encode(editor.existing)}` : '/skills', { method: editor.existing ? 'PATCH' : 'POST', body: { name: draft.name, content: draft.content } });
        select({ type: 'skill', existing: result.name, files: result.files }, { name: result.name, content: result.content });
      } else if (editor.type === 'import') {
        await api('/mcp/import', { method: 'POST', body: JSON.parse(draft.content) });
        select(null, null);
      } else {
        const credentials = draft.secrets.trim() ? JSON.parse(draft.secrets) : {};
        if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || Object.keys(credentials).some(key => !['env', 'headers'].includes(key))) throw new Error('认证 JSON 只接受 env 和 headers 对象');
        const config = { ...credentials, transport: draft.transport, ...(draft.transport === 'stdio' ? { command: draft.command.trim(), args: JSON.parse(draft.args) } : { url: draft.url.trim() }), envAllow: draft.envAllow.split(',').map(key => key.trim()).filter(Boolean), tokenEnv: draft.tokenEnv.trim(), clearSecrets: draft.clearSecrets };
        await api(editor.existing ? `/mcp/${encode(editor.existing)}` : '/mcp', { method: editor.existing ? 'PATCH' : 'POST', body: editor.existing ? config : { name: draft.name.trim(), configuration: { ...config, enabled: false } } });
        const name = editor.existing || draft.name.trim();
        const next = { ...draft, name, secrets: '', clearSecrets: false };
        select({ type: 'mcp', existing: name }, next);
      }
    }, editor.type === 'import' ? 'MCP 已导入，默认停用。检查配置后再启用。' : '已保存。');
  };
  const remove = (kind, name) => guard(() => {
    pending.current = () => work(async () => {
      await api(`/${kind}/${encode(name)}`, { method: 'DELETE' });
      if (editor?.existing === name) select(null, null);
    }, '已移除。');
    setConfirmation({ title: `移除 ${name}？`, detail: kind === 'skills' ? '将删除这个技能及其附带文件。' : '将断开连接并删除这个 MCP 配置。', label: '确认移除' });
  });
  const switchTab = value => guard(() => { setTab(value); select(null, null); setNotice(null); });
  const selectedMcp = mcp.servers.find(entry => entry.name === editor?.existing);

  return <section className="management-page extensions-page" aria-label="技能与 MCP 管理">
    <header className="management-heading"><div><span className="extension-eyebrow">EXTENSIONS / 当前工作区</span><h1>技能与 MCP</h1><p>让代理学会你的工作方式，连接任务需要的工具与资料。</p></div><button className="button button-quiet" onClick={() => onNavigate('workspace')}><Icon name="arrow" size={14} />返回工作台</button></header>
    <div className="extension-tabs" role="tablist" aria-label="扩展类型">{[['skills', 'Skills 技能', skills.length], ['mcp', 'MCP 服务', mcp.servers.length]].map(([key, label, count]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => switchTab(key)}>{label}<span>{count}</span></button>)}</div>
    <div className="management-body">
      {notice && <div className={`management-notice ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button className="text-button" onClick={() => setNotice(null)}>关闭提示</button></div>}
      <div className="extension-intro"><div><h2>{tab === 'skills' ? '把经验写成可复用的技能' : '把外部能力接入会话'}</h2><p>{tab === 'skills' ? '启用后，代理会根据名称和描述匹配任务，再按需读取完整指引与参考文件。' : '支持 stdio、Streamable HTTP 和 SSE。启用会启动本地进程或连接远程服务；工具调用遵循运行策略。'}</p><p>{tab === 'skills' ? '导入 SKILL.md、含参考文件的目录或 ZIP 包；新导入默认停用。' : '配置保存在当前工作区。认证值不回显；本地服务需要自行安装对应的 Node / Python 等依赖。'}</p></div><button className="button button-quiet" disabled={busy} onClick={() => guard(() => work(async () => { if (tab === 'mcp') await api('/mcp/reload', { method: 'POST', body: {} }); }, '列表已刷新。'))}>重新加载</button></div>
      <div className="extension-toolbar">{tab === 'skills' ? <><button className="button button-primary" disabled={busy} onClick={() => guard(() => select({ type: 'skill' }, { name: 'project-review', content: template }))}><Icon name="plus" size={13} />新建技能</button><button className="button button-quiet" disabled={busy} onClick={() => fileInput.current.click()}>导入文件 / ZIP</button><button className="button button-quiet" disabled={busy} onClick={() => folderInput.current.click()}>导入技能目录</button></> : <><button className="button button-primary" disabled={busy} onClick={() => guard(() => select({ type: 'mcp' }, { ...initialMcp }))}><Icon name="plus" size={13} />添加 MCP</button><button className="button button-quiet" disabled={busy} onClick={() => guard(() => select({ type: 'import' }, { content: '{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "your-mcp-package"]\n    }\n  }\n}' }))}>粘贴 JSON 配置</button><button className="button button-quiet" disabled={busy} onClick={() => jsonInput.current.click()}>导入 JSON 文件</button><button className="text-button" onClick={() => onNavigate('settings')}>设置工具免审批</button></>}</div>
      <input ref={fileInput} type="file" accept=".md,.zip" hidden onChange={event => { const files = [...event.target.files]; event.target.value = ''; importFiles(files); }} />
      <input ref={folderInput} type="file" webkitdirectory="" multiple hidden onChange={event => { const files = [...event.target.files]; event.target.value = ''; importFiles(files); }} />
      <input ref={jsonInput} type="file" accept=".json" hidden onChange={event => { const file = event.target.files[0]; event.target.value = ''; if (file) guard(() => work(async () => { if (file.size > 1024 * 1024) throw new Error('JSON 文件不能超过 1 MiB'); select({ type: 'import' }, { content: await file.text() }); })); }} />
      {mcp.error && tab === 'mcp' && <p className="extension-error" role="alert">{mcp.error}</p>}
      <div className={`extension-layout ${editor ? 'with-editor' : ''}`}>
        <div className="extension-list" aria-busy={loading || busy}>{loading ? <p className="extension-empty">正在读取扩展…</p> : (tab === 'skills' ? skills : mcp.servers).length === 0 ? <div className="extension-empty"><Icon name={tab === 'skills' ? 'file' : 'link'} size={30} /><h3>{tab === 'skills' ? '还没有安装技能' : '还没有连接 MCP'}</h3><p>{tab === 'skills' ? '从一个 SKILL.md 开始，把常用流程留给代理。' : '添加一个服务，或导入现有的 mcpServers 配置。'}</p></div> : (tab === 'skills' ? skills : mcp.servers).map(entry => <article className={`extension-card ${editor?.existing === entry.name ? 'selected' : ''}`} key={entry.name} aria-label={entry.name}>
          <div className="extension-card-title"><h3>{entry.name}</h3><span className={`extension-status ${entry.error ? 'error' : tab === 'skills' ? entry.enabled ? 'connected' : 'disabled' : entry.status}`}>{tab === 'skills' ? entry.error ? '读取失败' : entry.enabled ? '已启用' : '已停用' : labels[entry.status]}</span></div>
          <p>{tab === 'skills' ? entry.description || '尚未填写技能描述。' : `${entry.configuration.transport || 'stdio'} · ${entry.configuration.command || entry.configuration.url}`}</p>
          {entry.error && <p className="extension-error">{entry.error}</p>}
          {tab === 'mcp' && <details><summary>{entry.tools.length} 个工具 · {entry.resources?.length || 0} 个资源 · {entry.prompts?.length || 0} 个提示模板</summary><ul>{entry.tools.map(name => <li key={name}><code>{name}</code></li>)}{entry.resources?.map(item => <li key={item.uri}>资源：{item.name} · {item.uri}</li>)}{entry.prompts?.map(item => <li key={item.name}>模板：{item.name}</li>)}</ul></details>}
          <div className="extension-actions"><button className="button button-quiet" disabled={busy || !!entry.error && tab === 'skills'} onClick={() => tab === 'skills' ? openSkill(entry.name) : openMcp(entry)}>编辑</button><button className="button button-quiet" disabled={busy || !!entry.error && tab === 'skills'} onClick={() => guard(() => work(() => api(`/${tab}/${encode(entry.name)}`, { method: 'PATCH', body: { enabled: tab === 'skills' ? !entry.enabled : !entry.configuration.enabled } }), tab === 'skills' ? '技能状态已更新。' : 'MCP 状态已更新。'))}>{(tab === 'skills' ? entry.enabled : entry.configuration.enabled) ? '停用' : '启用'}</button>{tab === 'mcp' && entry.configuration.enabled && <button className="button button-quiet" disabled={busy} onClick={() => guard(() => work(() => api(`/mcp/${encode(entry.name)}/reconnect`, { method: 'POST', body: {} })))}>重连</button>}<button className="text-button danger" disabled={busy} onClick={() => remove(tab, entry.name)}>移除</button></div>
        </article>)}</div>
        {editor && <form className="extension-editor" onSubmit={save}><div className="extension-card-title"><h2>{editor.type === 'skill' ? '技能说明' : editor.type === 'import' ? '导入 MCP 配置' : 'MCP 配置'}</h2><button className="text-button" type="button" onClick={() => guard(() => select(null, null))}>关闭编辑</button></div><fieldset disabled={busy}>
          {editor.type !== 'import' && <label>{editor.type === 'skill' ? '技能名称' : 'MCP 名称'}<input value={draft.name} required maxLength={80} disabled={!!editor.existing} onChange={event => change('name', event.target.value)} /></label>}
          {editor.type === 'skill' ? <><label>SKILL.md 内容<textarea aria-label="SKILL.md 内容" className="extension-code skill-source" value={draft.content} required spellCheck="false" onChange={event => change('content', event.target.value)} /></label><p className="extension-help">description 说明适用场景。正文写操作步骤；参考资料放在 references/，脚本放在 scripts/。脚本执行仍遵循运行策略。</p>{editor.files?.length > 0 && <details><summary>附带文件（{editor.files.length}）</summary><ul>{editor.files.map(file => <li key={file.path}><code>{file.path}</code> · {file.size} B</li>)}</ul></details>}</> : editor.type === 'import' ? <><label>mcpServers JSON<textarea aria-label="mcpServers JSON" className="extension-code skill-source" value={draft.content} required spellCheck="false" onChange={event => change('content', event.target.value)} /></label><p className="extension-help">支持常见的 mcpServers 格式。导入不会覆盖同名服务，所有新服务默认停用。</p></> : <>
            <label>传输协议<select aria-label="传输协议" value={draft.transport} onChange={event => change('transport', event.target.value)}><option value="stdio">stdio · 本地进程</option><option value="http">Streamable HTTP · 远程服务</option><option value="sse">SSE · 兼容旧服务</option></select></label>
            {draft.transport === 'stdio' ? <><label>启动命令<input aria-label="启动命令" value={draft.command} required placeholder="npx、uvx 或可执行文件完整路径" onChange={event => change('command', event.target.value)} /></label><label>命令参数（JSON 数组）<textarea aria-label="命令参数（JSON 数组）" className="extension-code" value={draft.args} required spellCheck="false" onChange={event => change('args', event.target.value)} /></label><label>允许继承的环境变量<input aria-label="允许继承的环境变量" value={draft.envAllow} placeholder="GITHUB_TOKEN, MY_API_KEY" onChange={event => change('envAllow', event.target.value)} /></label></> : <><label>服务 URL<input aria-label="服务 URL" type="url" value={draft.url} required placeholder="https://example.com/mcp" onChange={event => change('url', event.target.value)} /></label><label>Bearer Token 环境变量名称<input aria-label="Bearer Token 环境变量名称" value={draft.tokenEnv} placeholder="MCP_ACCESS_TOKEN" onChange={event => change('tokenEnv', event.target.value)} /></label></>}
            <details><summary>认证与环境变量</summary><p className="extension-help">{selectedMcp ? `已保存环境变量：${selectedMcp.envKeys.join(', ') || '无'}；请求头：${selectedMcp.headerKeys.join(', ') || '无'}。` : ''}密钥不回显。留空保留已有值；将某一项设为 null 可移除。值保存在本机工作区，请勿提交到 Git。</p><label>认证 JSON<textarea aria-label="认证 JSON" className="extension-code" autoComplete="off" value={draft.secrets} spellCheck="false" placeholder={'{"env":{"API_KEY":"..."},"headers":{"Authorization":"Bearer ..."}}'} onChange={event => change('secrets', event.target.value)} /></label><label className="checkbox-field"><input type="checkbox" checked={draft.clearSecrets} onChange={event => change('clearSecrets', event.target.checked)} />保存时清除已有环境变量值与请求头</label></details>
            <p className="extension-help">新服务保存后可在列表启用；修改已启用服务会重新连接。停用将中断该服务尚未完成的调用。</p>
          </>}
          <div className="extension-save"><span>{busy ? '正在处理…' : dirty ? '有未保存的更改' : editor.existing ? '已保存' : '尚未保存'}</span><button className="button button-primary" type="submit">{busy ? '处理中…' : editor.type === 'import' ? '确认导入' : '保存'}</button></div>
        </fieldset></form>}
      </div>
    </div>
    {confirmation && <dialog ref={dialog} className="extension-confirm" onCancel={() => { pending.current = null; setConfirmation(null); }} aria-labelledby="extension-confirm-title"><h2 id="extension-confirm-title">{confirmation.title}</h2><p>{confirmation.detail}</p><div className="extension-actions"><button autoFocus className="button button-quiet" onClick={() => { pending.current = null; setConfirmation(null); }}>取消</button><button className="button button-primary" onClick={() => { const action = pending.current; pending.current = null; setConfirmation(null); action?.(); }}>{confirmation.label}</button></div></dialog>}
  </section>;
}

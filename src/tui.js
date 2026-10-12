import blessed from 'blessed';
import { VERSION } from './version.js';

const runningStates = new Set(['running', 'waiting_approval', 'waiting_input']);
const labels = {
  responses: 'OpenAI Responses',
  openai: 'OpenAI Chat',
  anthropic: 'Anthropic Messages',
};
const statusLabels = { running: '运行中', waiting_approval: '等待审批', waiting_input: '等待回答', completed: '已完成', cancelled: '已取消', failed: '失败' };

function clean(value) {
  return blessed.escape(String(value ?? '').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
}

function pretty(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export async function startTui({ harness, input = process.stdin, output = process.stdout }) {
  if (!input.isTTY || !output.isTTY) {
    output.write('青禾 Studio TUI 需要交互终端。\n请在终端运行 harness tui；管道或自动化请使用 harness run "任务" --json。\nWebUI 可使用 harness web。\n');
    return;
  }
  const screen = blessed.screen({ input, output, terminal: process.env.TERM || 'xterm-256color', smartCSR: true, fullUnicode: true, title: '青禾 Studio · Workbench', dockBorders: true, warnings: false, ignoreLocked: ['C-q', 'C-c', 'C-n', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'] });
  const colors = { bg: '#e8eed2', panel: '#fff8df', fg: '#293526', accent: '#4f7839', muted: '#66715c', border: '#a8b485', selected: '#cfe4a6' };
  const blockBorder = { type: 'bg', ch: ' ' };
  const borderStyle = { fg: colors.border, bg: colors.border };
  const panelStyle = { fg: colors.fg, bg: colors.panel, border: borderStyle, focus: { border: { fg: colors.accent, bg: colors.accent } } };
  const header = blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: 2, tags: true, style: { bg: colors.bg, fg: colors.fg }, padding: { left: 1 } });
  const sidebar = blessed.list({ parent: screen, label: ' ▣ 会话 F3 ', top: 2, left: 0, width: 25, bottom: 2, border: blockBorder, mouse: true, keys: true, vi: true, tags: true, scrollable: true, scrollbar: { ch: '█', style: { fg: colors.muted } }, style: { ...panelStyle, selected: { bg: colors.selected, fg: colors.fg, bold: true }, item: { fg: colors.fg } } });
  const chat = blessed.box({ parent: screen, label: ' ▣ 对话 ', top: 2, left: 25, right: 35, bottom: 9, border: blockBorder, tags: true, mouse: true, keys: true, vi: true, scrollable: true, alwaysScroll: true, scrollbar: { ch: '█', style: { fg: colors.muted } }, padding: { left: 1, right: 1 }, style: panelStyle });
  const composer = blessed.textarea({ parent: screen, label: ' ▣ 任务 · Ctrl+S 发送 · Esc 离开输入 ', left: 25, right: 35, bottom: 2, height: 7, border: blockBorder, mouse: true, keys: true, style: panelStyle, scrollbar: { ch: '█' } });
  composer.on('focus', () => composer.readInput());
  const context = blessed.box({ parent: screen, top: 2, right: 0, width: 35, bottom: 2, border: blockBorder, tags: true, keys: true, mouse: true, scrollable: true, alwaysScroll: true, padding: { left: 1, right: 1 }, style: panelStyle, scrollbar: { ch: '█', style: { fg: colors.muted } } });
  const contextList = blessed.list({ parent: context, top: 0, left: 0, width: '100%-2', height: '100%-2', tags: true, mouse: true, keys: true, vi: true, hidden: true, scrollable: true, scrollbar: { ch: '█' }, style: { fg: colors.fg, bg: colors.panel, selected: { fg: colors.fg, bg: colors.selected } } });
  const footer = blessed.box({ parent: screen, left: 0, bottom: 0, height: 2, width: '100%', tags: true, style: { fg: colors.muted, bg: colors.bg } });
  let sessions = harness.listSessions();
  let selectedId = sessions[0]?.id;
  let activePane = 'activity';
  let streaming = '';
  let notice = 'F1 帮助 · Ctrl+S 发送 · Ctrl+Q 退出';
  let filePath = '.';
  let fileItems = [];
  let closed = false;
  let modal = null;
  let frame;
  let finish;
  const completed = new Promise(resolveDone => { finish = resolveDone; });
  const pendingApprovals = [];
  const seenApprovals = new Set();
  const pendingQuestions = harness.getQuestions();
  const seenQuestions = new Set(pendingQuestions.map(question => question.id));

  function currentSession() {
    if (!selectedId) return null;
    try { return harness.getSession(selectedId); } catch { return null; }
  }

  function sessionDraft(session) {
    const chunks = [];
    for (const event of [...(session?.events ?? [])].reverse()) {
      if ((event.type === 'message' && event.data.message.role === 'assistant') || ['run.started', 'run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) break;
      if (event.type === 'assistant.delta') chunks.unshift(event.data.text);
    }
    return chunks.join('');
  }

  function report(error) {
    notice = `错误：${error.message ?? error}`;
    schedule();
  }

  function safely(action) {
    Promise.resolve().then(action).catch(report);
  }

  function schedule() {
    if (closed || frame) return;
    frame = setTimeout(() => {
      frame = null;
      if (!closed) render();
    }, 35);
  }

  function drawConversation(session) {
    if (!session) {
      const configured = harness.getSettings().configured;
      chat.setContent(`{bold}{#4f7839-fg}■ ■ ■  青禾 Studio / WORKBENCH{/}\n\n你的 AI 编程工作台\n\n${configured ? '按 F2 新建会话，输入任务后按 Ctrl+S 发送。' : '按 F8 设置模型服务、模型名与 API Key。\n在设置中按 Ctrl+T 测试连接，Ctrl+S 保存。'}\n\n{#66715c-fg}CLI / TUI / WebUI 共享会话、工具、审批和检查点。{/}`);
      return;
    }
    const messages = session.messages.map(message => {
      const role = { user: '{#4f7839-fg}■ YOU{/}', assistant: '{#486487-fg}■ 青禾 Studio{/}', tool: '{#8b642d-fg}■ TOOL{/}', system: '{#66715c-fg}SYSTEM{/}' }[message.role] ?? clean(message.role);
      const content = message.role === 'tool' && String(message.content).length > 2000 ? `${String(message.content).slice(0, 2000)}\n…（完整结果见活动面板）` : message.content;
      const calls = message.toolCalls?.length ? `\n{#66715c-fg}${message.toolCalls.map(call => clean(call.name ?? call.function?.name ?? 'tool')).join(' · ')}{/}` : '';
      return `${role}\n${clean(content)}${calls}`;
    });
    if (streaming) messages.push(`{#486487-fg}■ 青禾 Studio · streaming{/}\n${clean(streaming)}{#4f7839-fg} ▌{/}`);
    chat.setContent(messages.join('\n\n') || '输入任务开始。按 F8 配置模型服务。');
    chat.setLabel(` ${clean(session.title)} `);
  }

  function drawContext(session) {
    const paneNames = { activity: '活动 F6', plan: '计划 F5', files: '文件 F4', checkpoints: '检查点 F7' };
    context.setLabel(` ${paneNames[activePane]} `);
    if (activePane === 'files') {
      context.setContent('');
      contextList.show();
      contextList.setItems(fileItems.map(item => `${item.type === 'directory' ? '▸' : '·'} ${clean(item.name)}`));
      context.setLabel(` 文件 ${clean(filePath)} `);
    } else if (activePane === 'checkpoints') {
      context.setContent('');
      contextList.show();
      contextList.setItems((session?.checkpoints ?? []).map(checkpoint => `${checkpoint.restored ? '↶' : '●'} ${clean(checkpoint.path)}\n  ${clean(checkpoint.id.slice(0, 8))}`));
      if (!session?.checkpoints.length) {
        contextList.hide();
        context.setContent('尚无文件修改检查点。\n\n工具写入文件后可查看 diff 并恢复。');
      }
    } else {
      contextList.hide();
      if (activePane === 'plan') {
        const plan = session?.plan ?? [];
        context.setContent(plan.length ? plan.map(item => `${item.status === 'completed' ? '{#4f7839-fg}✓{/}' : item.status === 'in_progress' ? '{#8b642d-fg}▶{/}' : '□'} ${clean(item.step)}`).join('\n\n') : '尚无计划。\n\n代理调用 update_plan 后显示步骤与进度。');
      } else {
        const events = (session?.events ?? []).filter(event => !['assistant.delta', 'message'].includes(event.type)).slice(-60);
        context.setContent(events.length ? events.map(event => {
          const timestamp = new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
          let detail = '';
          if (event.type.startsWith('tool.')) detail = `\n${clean(event.data.name)}${event.data.args ? `\n${clean(pretty(event.data.args)).slice(0, 1800)}` : ''}${event.data.result !== undefined ? `\n${clean(pretty(event.data.result)).slice(0, 1800)}` : ''}${event.data.error ? `\n${clean(event.data.error)}` : ''}`;
          else if (event.type === 'run.failed') detail = `\n${clean(event.data.run?.error)}`;
          else if (event.type.startsWith('approval.')) detail = `\n${clean(event.data.tool)} · ${clean(event.data.status)}`;
          else if (event.type.startsWith('question.')) detail = `\n${clean(event.data.question)} · ${clean(event.data.status)}${event.data.answer ? `\n${clean(event.data.answer)}` : ''}`;
          return `{#66715c-fg}${timestamp}{/} ${clean(event.type)}${detail}`;
        }).join('\n\n') : '工具调用、审批与运行事件将在此显示。');
      }
    }
  }

  function render() {
    const narrow = screen.width < 112;
    const tiny = screen.width < 70;
    sidebar.width = tiny ? 17 : 25;
    chat.left = composer.left = tiny ? 17 : 25;
    chat.right = composer.right = narrow ? 0 : 35;
    if (narrow) context.hide(); else context.show();
    const browsedId = screen.focused === sidebar ? sessions[sidebar.selected]?.id : null;
    sessions = harness.listSessions();
    sidebar.setItems(sessions.map(session => `${runningStates.has(session.run?.status) ? '◉' : '○'} ${clean(session.title.replace(/\s+/g, ' '))}`));
    const selectedIndex = sessions.findIndex(session => session.id === (browsedId ?? selectedId));
    if (selectedIndex !== -1) sidebar.select(selectedIndex);
    const session = currentSession();
    const settings = harness.getSettings();
    header.setContent(`{bold}{#4f7839-fg} ▣ 青禾 Studio ${VERSION} {/}  ${clean(labels[settings.provider] ?? settings.provider)}  {#66715c-fg}${clean(settings.model ?? '')} · ${clean(settings.approval)}{/}\n ${clean(settings.configured === false ? '尚未配置模型服务 · F8 开始设置' : session?.run ? statusLabels[session.run.status] ?? session.run.status : '工作台就绪')} ${session?.run ? `· step ${session.run.steps ?? 0} · tokens ${session.run.usage?.inputTokens ?? 0} / ${session.run.usage?.outputTokens ?? 0}` : ''}`);
    drawConversation(session);
    drawContext(session);
    footer.setContent(` ${clean(notice)}\n F2 新建  F3 会话  F4 文件  F5 计划  F6 活动  F7 检查点  F8 设置  F9 删除  F10 停止`);
    screen.render();
  }

  function closeModal() {
    if (!modal) return;
    const existing = modal;
    modal = null;
    existing.destroy();
    sidebar.focus();
    schedule();
    setTimeout(showInteraction, 0);
  }

  function modalBox(label, { width = '85%', height = '80%' } = {}) {
    if (modal) return null;
    const box = blessed.box({ parent: screen, label: ` ▣ ${label} `, top: 'center', left: 'center', width, height, border: blockBorder, tags: true, mouse: true, keys: true, style: { ...panelStyle, border: { fg: colors.accent, bg: colors.accent } }, shadow: true });
    modal = box;
    box.dismiss = closeModal;
    modalKey(box, ['escape'], () => box.dismiss());
    box.focus();
    return box;
  }

  function modalKey(box, keys, action) {
    box.key(keys, action);
    for (const key of keys) box.on(`element key ${key}`, element => { if (element !== box) action(); });
  }

  function button(parent, content, left, bottom, action, width = 14) {
    const control = blessed.button({ parent, content, left, bottom, width, height: 3, align: 'center', valign: 'middle', border: blockBorder, mouse: true, keys: true, style: { bg: colors.bg, fg: colors.fg, border: borderStyle, focus: { bg: colors.selected, border: { fg: colors.accent, bg: colors.accent } }, hover: { bg: colors.selected } } });
    control.on('press', () => safely(action));
    return control;
  }

  function showText(title, content) {
    const box = modalBox(title);
    if (!box) return;
    const text = blessed.box({ parent: box, left: 1, top: 0, right: 1, bottom: 3, content: clean(content), tags: true, keys: true, mouse: true, vi: true, scrollable: true, alwaysScroll: true, scrollbar: { ch: '│' }, style: { fg: colors.fg, bg: colors.panel } });
    button(box, '关闭 Esc', 'center', 0, closeModal);
    text.focus();
    screen.render();
  }

  function confirm(title, content, action) {
    const box = modalBox(title, { width: '80%', height: 12 });
    if (!box) return;
    blessed.box({ parent: box, left: 2, top: 1, right: 2, height: 5, tags: true, content: clean(content), style: { fg: colors.fg, bg: colors.panel } });
    const cancel = button(box, '取消 [N]', 2, 1, closeModal);
    const accept = async () => { closeModal(); await action(); };
    button(box, '确认 [Y]', 19, 1, accept);
    modalKey(box, ['y'], () => safely(accept));
    modalKey(box, ['n'], closeModal);
    cancel.focus();
    screen.render();
  }

  async function newSession() {
    const session = await harness.createSession({ title: '新会话' });
    selectedId = session.id;
    streaming = '';
    notice = '会话已创建。输入任务后按 Ctrl+S 发送。';
    render();
    composer.focus();
  }

  async function sendPrompt() {
    if (modal) return;
    const prompt = composer.getValue().trim();
    if (!prompt) return;
    if (harness.getSettings().configured === false) {
      notice = '请先按 F8 配置模型服务，测试连接后保存。';
      showSettings();
      schedule();
      return;
    }
    let session = currentSession();
    if (runningStates.has(session?.run?.status)) {
      notice = '当前任务仍在运行，按 F10 停止后可发送新任务。';
      schedule();
      return;
    }
    if (!session) {
      session = await harness.createSession({ title: prompt.slice(0, 60) });
      selectedId = session.id;
    }
    streaming = '';
    await harness.run(session.id, prompt);
    composer.clearValue();
    composer.focus();
    notice = '任务已开始，按 F10 取消。';
    chat.setScrollPerc(100);
    schedule();
  }

  async function loadFiles(path = filePath) {
    const files = await harness.listFiles(path);
    filePath = path;
    const parent = path === '.' ? [] : [{ name: '..', path: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '.' : '.', type: 'directory' }];
    fileItems = [...parent, ...files];
  }

  async function switchPane(pane) {
    activePane = pane;
    if (pane === 'files') await loadFiles();
    render();
    if (screen.width < 112) {
      if (pane === 'files' || pane === 'checkpoints') showNarrowList();
      else showText(pane === 'plan' ? '计划' : '活动', context.getText());
    } else if (pane === 'files' || pane === 'checkpoints') contextList.focus();
    else context.focus();
  }

  function showNarrowList() {
    const pane = activePane;
    const box = modalBox(pane === 'files' ? `文件 ${filePath}` : '检查点');
    if (!box) return;
    const entries = pane === 'files' ? fileItems : currentSession()?.checkpoints ?? [];
    const list = blessed.list({ parent: box, left: 1, right: 1, top: 0, bottom: 3, items: entries.map(entry => clean(pane === 'files' ? entry.name : entry.path)), tags: true, mouse: true, keys: true, vi: true, style: { fg: colors.fg, bg: colors.panel, selected: { bg: colors.selected, fg: colors.fg } } });
    list.on('select', (_, index) => { closeModal(); safely(() => selectContext(index, pane)); });
    list.key(['escape'], closeModal);
    button(box, '关闭 Esc', 'center', 0, closeModal);
    list.focus();
    screen.render();
  }

  async function selectContext(index, pane = activePane) {
    if (pane === 'files') {
      const entry = fileItems[index];
      if (!entry) return;
      if (entry.type === 'directory') {
        await loadFiles(entry.path.replaceAll('\\', '/'));
        render();
        if (screen.width < 112) showNarrowList();
      } else {
        const file = await harness.readFile(entry.path);
        showText(file.path, file.content);
      }
    } else if (pane === 'checkpoints') {
      const session = currentSession();
      const checkpoint = session?.checkpoints[index];
      if (!checkpoint) return;
      const box = modalBox(`Diff · ${clean(checkpoint.path)}`);
      if (!box) return;
      const text = blessed.box({ parent: box, left: 1, right: 1, top: 0, bottom: 3, content: clean(checkpoint.diff || '(无差异)'), tags: true, mouse: true, keys: true, vi: true, scrollable: true, alwaysScroll: true, scrollbar: { ch: '│' }, style: { fg: colors.fg, bg: colors.panel } });
      button(box, '关闭 Esc', 1, 0, closeModal);
      const restore = () => {
        closeModal();
        confirm('恢复检查点', `将 ${checkpoint.path} 恢复到本次工具修改之前的内容。\n若文件之后已变化，核心会拒绝覆盖。`, async () => {
          await harness.restoreCheckpoint(session.id, checkpoint.id);
          notice = `已恢复 ${checkpoint.path}`;
          schedule();
        });
      };
      if (!checkpoint.restored) {
        button(box, '恢复 [R]', 18, 0, restore);
        modalKey(box, ['r'], restore);
      }
      text.focus();
      screen.render();
    }
  }

  function showApproval() {
    if (closed || modal) return;
    const approval = pendingApprovals.shift();
    if (!approval) return;
    let session;
    try { session = harness.getSession(approval.sessionId); } catch { showApproval(); return; }
    if (!runningStates.has(session.run?.status)) { showApproval(); return; }
    const box = modalBox(`工具审批 · ${clean(approval.tool)}`, { width: '85%', height: '75%' });
    if (!box) return;
    const text = blessed.box({ parent: box, left: 1, right: 1, top: 0, bottom: 5, content: `会话：${clean(session.title)}\n工具：${clean(approval.tool)}\n\n${clean(pretty(approval.args))}${approval.target ? `\n目标：${clean(pretty(approval.target))}` : ''}\n\n{#8b642d-fg}批准仅适用于本次调用。Shell 和桌面操作不是沙箱。截图会发送给模型供应商。{/}`, tags: true, keys: true, mouse: true, scrollable: true, style: { fg: colors.fg, bg: colors.panel } });
    const decide = async approved => {
      closeModal();
      await harness.resolveApproval(approval.id, approved);
      notice = `${approved ? '已批准' : '已拒绝'} ${approval.tool}`;
      schedule();
    };
    const deny = button(box, '拒绝 [N]', 1, 1, () => decide(false));
    button(box, '批准 [Y]', 18, 1, () => decide(true));
    box.dismiss = () => safely(() => decide(false));
    box.approvalId = approval.id;
    box.approvalSessionId = approval.sessionId;
    modalKey(box, ['y'], () => safely(() => decide(true)));
    modalKey(box, ['n'], () => safely(() => decide(false)));
    deny.focus();
    screen.render();
  }

  function showInteraction() {
    if (closed || modal) return;
    if (pendingQuestions.length) showQuestion();
    else showApproval();
  }

  function showQuestion() {
    if (closed || modal) return;
    const question = pendingQuestions.shift();
    if (!question) return;
    if (!harness.getQuestions().some(pending => pending.id === question.id)) { showInteraction(); return; }
    const box = modalBox('青禾 Studio 需要补充信息', { width: '85%', height: '75%' });
    if (!box) return;
    const choices = question.options.map((option, index) => `${index + 1}. ${option}`).join('\n\n');
    blessed.box({ parent: box, left: 1, right: 1, top: 0, bottom: 9, content: clean(`${question.question}\n\n${choices}\n\n输入选项编号或自由文本，Ctrl+S 提交。`), tags: true, keys: true, mouse: true, scrollable: true, scrollbar: { ch: '│' }, style: { fg: colors.fg, bg: colors.panel } });
    const answerInput = blessed.textarea({ parent: box, label: ' 回答 · 选项编号或自由文本 ', left: 1, right: 1, bottom: 4, height: 5, border: blockBorder, keys: true, mouse: true, style: panelStyle });
    answerInput.on('focus', () => answerInput.readInput());
    let submitting = false;
    const submit = async () => {
      if (submitting) return;
      const reply = answerInput.getValue().trim();
      const answer = /^[1-8]$/.test(reply) && question.options[Number(reply) - 1] ? question.options[Number(reply) - 1] : reply;
      submitting = true;
      try {
        await harness.answerQuestion(question.id, { answer });
        notice = '回答已发送，任务继续执行。';
        schedule();
      } finally { submitting = false; }
    };
    const cancel = () => harness.cancelRun(question.sessionId);
    button(box, '提交 Ctrl+S', 1, 0, submit, 18);
    button(box, '停止任务 Esc', 22, 0, cancel, 18);
    box.questionId = question.id;
    box.questionSessionId = question.sessionId;
    box.dismiss = () => safely(cancel);
    modalKey(box, ['C-s'], () => safely(submit));
    answerInput.focus();
    screen.render();
  }

  function showSettings() {
    const box = modalBox('模型与运行设置 · Tab 切换字段', { width: '95%', height: '95%' });
    if (!box) return;
    const settings = harness.getSettings();
    const form = blessed.form({ parent: box, left: 1, right: 1, top: 0, bottom: 6, keys: true, mouse: true, scrollable: true, scrollbar: { ch: '█' }, style: { bg: colors.panel } });
    const connectionStatus = blessed.text({ parent: box, left: 1, right: 1, bottom: 3, height: 2, content: `供应商来源：${settings.providerScope === 'global' ? '全局' : '当前工作区'}；运行策略保存在当前工作区。\nCtrl+T 测试会发送一次最小模型请求，可能产生服务商费用。`, style: { fg: colors.muted, bg: colors.panel } });
    let testing = false;
    const definitions = [
      ['provider', '协议：responses / openai / anthropic'],
      ['model', '模型名称'],
      ['baseUrl', 'API Base URL'],
      ['apiKey', 'API Key（留空保留，输入 - 清除）'],
      ['approval', '审批：ask / auto / readonly'],
      ['autoApproveTools', '免审批工具名（逗号分隔；留空清除）'],
      ['maxTokens', '每次最大输出 Token'],
      ['temperature', 'Temperature'],
      ['commandTimeoutMs', '命令超时（毫秒）'],
      ['providerTimeoutMs', '模型请求超时（毫秒）'],
      ['maxContextTokens', '模型上下文窗口（Token）'],
      ['contextCompactionThreshold', '自动压缩阈值（0.5–0.95）'],
      ['systemPrompt', '系统提示词（可多行）'],
    ];
    const controls = new Map();
    definitions.forEach(([key, label], index) => {
      blessed.text({ parent: form, left: 1, top: index * 4, content: label, tags: false, style: { fg: colors.muted, bg: colors.panel } });
      const field = (key === 'systemPrompt' ? blessed.textarea : blessed.textbox)({ parent: form, name: key, left: 1, right: 1, top: index * 4 + 1, height: key === 'systemPrompt' ? 6 : 3, border: blockBorder, keys: true, mouse: true, censor: key === 'apiKey', value: key === 'apiKey' ? '' : String(settings[key] ?? ''), style: { ...panelStyle, focus: { border: { fg: colors.accent, bg: colors.accent } } } });
      field.on('focus', () => field.readInput());
      controls.set(key, field);
    });
    const buildPatch = () => {
      const patch = {};
      for (const [key, field] of controls) {
        const value = field.getValue();
        if (key === 'apiKey') {
          if (value) patch.apiKey = value === '-' ? '' : value;
        } else if (key === 'autoApproveTools') {
          patch[key] = value.split(',').map(name => name.trim()).filter(Boolean);
        } else if (['maxTokens', 'temperature', 'commandTimeoutMs', 'providerTimeoutMs', 'maxContextTokens', 'contextCompactionThreshold'].includes(key)) {
          const numeric = Number(value);
          if (!value.trim() || !Number.isFinite(numeric)) throw new Error(`${key} 必须是数值`);
          patch[key] = numeric;
        } else patch[key] = value;
      }
      return patch;
    };
    const save = async () => {
      await harness.updateSettings(buildPatch());
      closeModal();
      notice = '设置已保存。responses = Responses，openai = Chat，anthropic = Messages。';
      schedule();
    };
    const testConnection = async () => {
      if (testing) return;
      testing = true;
      connectionStatus.setContent('正在连接模型服务…');
      screen.render();
      try {
        const result = await harness.testConnection(buildPatch());
        if (!box.destroyed) connectionStatus.setContent(`连接成功 · ${result.provider} / ${result.model} · ${result.latencyMs} ms`);
      } catch (error) {
        if (!box.destroyed) connectionStatus.setContent(`连接失败：${error.message}`);
      } finally {
        testing = false;
        if (!closed) screen.render();
      }
    };
    button(box, '保存 Ctrl+S', 1, 0, save, 18);
    button(box, '取消 Esc', 22, 0, closeModal);
    button(box, '测试 Ctrl+T', 39, 0, testConnection, 18);
    modalKey(box, ['C-s'], () => safely(save));
    modalKey(box, ['C-t'], () => safely(testConnection));
    form.focusFirst();
    screen.render();
  }

  function showHelp() {
    showText('青禾 Studio 快捷键', 'Ctrl+S    发送输入框任务 / 保存设置\nCtrl+T    在设置中测试模型连接\nCtrl+Q    退出（运行中的任务会取消）\nCtrl+C    取消当前任务；无任务时退出\nF2 / Ctrl+N   新建会话\nF3        聚焦会话列表（方向键、Enter 选择）\nF4        工作区文件（Enter 浏览）\nF5        代理计划\nF6        工具活动与执行结果\nF7        检查点（Enter 查看 diff，R 恢复）\nF8        模型、协议、密钥和审批设置\nF9        删除当前会话（需确认）\nF10       取消任务\nTab       切换焦点\ni         聚焦任务输入（非输入状态）\nEsc       离开输入 / 关闭窗口 / 拒绝审批\n\n协议：responses = OpenAI Responses；openai = OpenAI Chat；\nanthropic = Anthropic Messages。首次使用需设置模型名与 API Key。\n\nask 对写入和命令审批；auto 自动批准；readonly 拒绝写入和命令。\nShell 命令不是操作系统沙箱，仅在可信工作区运行。');
  }

  async function stopRun() {
    if (!selectedId) return;
    await harness.cancelRun(selectedId);
    notice = '已请求取消当前任务。';
    schedule();
  }

  async function quit() {
    if (closed) return;
    closed = true;
    clearTimeout(frame);
    harness.off('event', onEvent);
    process.off('SIGINT', onTerminate);
    process.off('SIGTERM', onTerminate);
    try {
      await Promise.all(harness.listSessions().filter(session => runningStates.has(session.run?.status)).map(session => harness.cancelRun(session.id)));
    } finally {
      screen.destroy();
      finish();
    }
  }

  function onTerminate() { safely(quit); }

  function onEvent(event) {
    if (event.type === 'question.resolved') {
      const index = pendingQuestions.findIndex(question => question.id === event.data.id);
      if (index !== -1) pendingQuestions.splice(index, 1);
    }
    if ((event.type === 'question.resolved' && modal?.questionId === event.data.id) || (['run.cancelled', 'run.failed', 'run.completed'].includes(event.type) && modal?.questionSessionId === event.sessionId)) closeModal();
    if (event.type === 'question.required' && !seenQuestions.has(event.data.id)) {
      seenQuestions.add(event.data.id);
      pendingQuestions.push(event.data);
      notice = '青禾 Studio 需要补充信息；输入回答后按 Ctrl+S。';
      showInteraction();
    }
    if (event.type === 'approval.resolved') {
      const index = pendingApprovals.findIndex(approval => approval.id === event.data.id);
      if (index !== -1) pendingApprovals.splice(index, 1);
    }
    if ((event.type === 'approval.resolved' && modal?.approvalId === event.data.id) || (['run.cancelled', 'run.failed', 'run.completed'].includes(event.type) && modal?.approvalSessionId === event.sessionId)) closeModal();
    if (event.type === 'approval.required' && !seenApprovals.has(event.data.id)) {
      seenApprovals.add(event.data.id);
      pendingApprovals.push(event.data);
      showInteraction();
    }
    if (event.sessionId === selectedId) {
      if (event.type === 'assistant.delta') streaming += event.data.text;
      if (event.type === 'message' && event.data.message.role === 'assistant') streaming = '';
      if (event.type.startsWith('run.')) notice = event.type === 'run.failed' ? `运行失败：${event.data.run?.error ?? ''}` : `会话 ${selectedId.slice(0, 8)} · ${event.type}`;
      if (event.type === 'message' || event.type === 'assistant.delta') chat.setScrollPerc(100);
    }
    schedule();
  }

  sidebar.on('select', (_, index) => {
    selectedId = sessions[index]?.id;
    streaming = sessionDraft(currentSession());
    schedule();
  });
  contextList.on('select', (_, index) => safely(() => selectContext(index)));
  screen.key(['f1'], showHelp);
  screen.key(['f2', 'C-n'], () => { if (!modal) safely(newSession); });
  screen.key(['f3'], () => { if (!modal) sidebar.focus(); });
  screen.key(['f4'], () => { if (!modal) safely(() => switchPane('files')); });
  screen.key(['f5'], () => { if (!modal) safely(() => switchPane('plan')); });
  screen.key(['f6'], () => { if (!modal) safely(() => switchPane('activity')); });
  screen.key(['f7'], () => { if (!modal) safely(() => switchPane('checkpoints')); });
  screen.key(['f8'], showSettings);
  screen.key(['f9'], () => {
    const session = currentSession();
    if (!session) return;
    confirm('删除会话', `删除“${session.title}”及其消息和事件记录？\n工作区文件不受影响。`, async () => {
      await harness.deleteSession(session.id);
      selectedId = harness.listSessions()[0]?.id;
      streaming = '';
      notice = '会话已删除。';
      schedule();
    });
  });
  screen.key(['f10'], () => safely(stopRun));
  screen.key(['C-q'], () => safely(quit));
  screen.key(['C-c'], () => safely(() => runningStates.has(currentSession()?.run?.status) ? stopRun() : quit()));
  screen.key(['tab', 'S-tab'], (_, key) => {
    if (screen.focused === composer) return;
    if (modal) {
      const candidates = screen.keyable.filter(element => {
        if (!element.visible || element === modal) return false;
        for (let parent = element.parent; parent; parent = parent.parent) if (parent === modal) return true;
        return false;
      });
      const index = candidates.indexOf(screen.focused);
      candidates[(index + (key.shift ? candidates.length - 1 : 1)) % candidates.length]?.focus();
    } else if (key.shift) screen.focusPrevious();
    else screen.focusNext();
  });
  screen.key(['i'], () => {
    if (!modal && screen.focused !== composer) composer.focus();
  });
  composer.key(['C-s'], () => safely(sendPrompt));
  composer.key(['escape'], () => sidebar.focus());
  screen.on('resize', schedule);
  harness.on('event', onEvent);
  process.on('SIGINT', onTerminate);
  process.on('SIGTERM', onTerminate);
  for (const session of sessions) {
    const unresolved = new Map();
    for (const event of session.events ?? []) {
      if (event.type === 'approval.required' && event.data.runId === session.run?.id) unresolved.set(event.data.id, event.data);
      if (event.type === 'approval.resolved') unresolved.delete(event.data.id);
    }
    for (const approval of unresolved.values()) {
      if (session.run?.status !== 'waiting_approval') continue;
      seenApprovals.add(approval.id);
      pendingApprovals.push(approval);
    }
  }
  streaming = sessionDraft(currentSession());
  render();
  composer.focus();
  showInteraction();
  return completed;
}

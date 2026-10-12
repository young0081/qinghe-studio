import { markdownSample, markdownStreaming, markdownUnsafe, markdownWide } from './markdown.js';
import { mathSample, mathStreaming, mathUnsafe, mathWide } from './math.js';

export async function testCompletion(settings, { messages, onDelta, signal }) {
  signal.throwIfAborted();
  const latestUser = messages.findLastIndex(message => message.role === 'user' && !message.content?.startsWith('以下为工具返回的截图'));
  const prompt = messages[latestUser]?.content || '';
  const math = prompt.includes('[test:math-unsafe]') ? mathUnsafe : prompt.includes('[test:math-streaming]') ? mathStreaming : prompt.includes('[test:math-wide]') ? mathWide : prompt.includes('[test:math]') ? mathSample : null;
  const markdown = math || (prompt.includes('[test:markdown-unsafe]') ? markdownUnsafe : prompt.includes('[test:markdown-streaming]') ? markdownStreaming : prompt.includes('[test:markdown-wide]') ? markdownWide : prompt.includes('[test:markdown]') ? markdownSample : null);
  if (markdown) {
    for (const chunk of markdown.match(/.{1,30}/gs)) { signal.throwIfAborted(); onDelta(chunk); }
    return { content: markdown, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
  }
  const recent = messages.slice(latestUser + 1);
  const toolMessages = recent.filter(message => message.role === 'tool');
  if (prompt.includes('[test:extensions]')) {
    const calls = [{ name: 'read_skill', args: { name: 'project-review' } }, { name: 'read_skill_file', args: { name: 'project-review', path: 'references/guide.md' } }, { name: 'mcp_browser_echo', args: { message: 'MCP 与 Skill 会话验证成功' } }];
    const call = calls[toolMessages.length];
    const content = call ? '' : toolMessages.map(message => message.content).join('\n');
    if (content) onDelta(content);
    return { content, toolCalls: call ? [{ id: `extensions-${toolMessages.length}`, ...call }] : [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: call ? 'tool_calls' : 'stop' };
  }
  if (prompt.includes('[test:question]')) {
    const content = toolMessages.length ? `已收到补充：${JSON.parse(toolMessages.at(-1).content).answer || '已取消'}。任务已完成。` : '';
    if (content) onDelta(content);
    return { content, toolCalls: toolMessages.length ? [] : [{ id: `question-${latestUser}`, name: 'ask_user', args: { question: '你希望使用哪个方案？', options: ['保留现有布局', '调整为紧凑布局'] } }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: toolMessages.length ? 'stop' : 'tool_calls' };
  }
  if (prompt.includes('[test:browser-live]')) {
    const step = toolMessages.length;
    const last = JSON.parse(toolMessages.at(-1)?.content || '{}');
    if (last.error) return { content: `直播测试失败：${last.error}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    const call = step === 0 ? { name: 'browser', args: { action: 'navigate', url: prompt.match(/https?:\/\/\S+/)[0] } }
      : step === 1 ? { name: 'ask_user', args: { question: '请确认直播画面，然后继续网页操作。', options: ['继续操作网页'] } }
        : step === 2 ? { name: 'browser', args: { action: 'snapshot' } }
          : step === 3 ? { name: 'browser', args: { action: 'fill', ref: last.elements.find(element => element.name === 'Name').ref, text: '实时操作已完成' } }
            : step === 4 ? { name: 'browser', args: { action: 'click', ref: last.elements.find(element => element.name === 'Save').ref } }
              : step === 5 ? { name: 'ask_user', args: { question: '页面已填写并保存，是否结束观察？', options: ['完成观察'] } } : null;
    const content = call ? '' : '浏览器实时观察已完成。';
    if (content) onDelta(content);
    return { content, toolCalls: call ? [{ id: `live-${latestUser}-${step}`, ...call }] : [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: call ? 'tool_calls' : 'stop' };
  }
  if (prompt.includes('[test:computer-deny]')) return { content: toolMessages.length ? '桌面审批测试已完成' : '', toolCalls: toolMessages.length ? [] : [{ id: 'computer-deny', name: 'computer', args: { action: 'screenshot' } }], usage: { inputTokens: 1, outputTokens: 1 } };
  if (prompt.includes('[test:browser]')) {
    const step = toolMessages.length;
    const last = JSON.parse(toolMessages.at(-1)?.content || '{}');
    if (last.error) return { content: `浏览器测试失败：${last.error}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    const args = step === 0 ? { action: 'navigate', url: prompt.match(/https?:\/\/\S+/)[0] }
      : step === 1 ? { action: 'fill', ref: last.elements.find(element => element.name === 'Name').ref, text: '像素 Browser 验证' }
        : step === 2 ? { action: 'click', ref: last.elements.find(element => element.name === 'Save').ref }
          : step === 3 ? { action: 'screenshot' } : null;
    const content = args ? '' : '浏览器测试已完成：真实页面填写、点击和截图成功。';
    if (content) onDelta(content);
    return { content, toolCalls: args ? [{ id: `browser-${latestUser}-${step}`, name: 'browser', args }] : [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: args ? 'tool_calls' : 'stop' };
  }
  let content = '';
  let toolCalls = [];
  if (!toolMessages.length) {
    content = '我会先查看当前工作区，并记录一个简短计划。';
    toolCalls = [
      { id: `test-plan-${latestUser}`, name: 'update_plan', args: { plan: [{ step: '查看工作区文件', status: 'in_progress' }, { step: '汇报发现与执行结果', status: 'pending' }] } },
      { id: `test-list-${latestUser}`, name: 'list_files', args: { path: '.' } },
    ];
  } else if (!recent.some(message => message.toolCalls?.some(call => call.name === 'read_file' || call.name === 'write_file' || call.name === 'run_command')) && !recent.some(message => message.content?.includes('完成测试检查'))) {
    const listing = toolMessages.find(message => message.toolCallId?.startsWith('test-list-'));
    let files = [];
    try { files = JSON.parse(listing?.content || '[]'); } catch {}
    const readable = Array.isArray(files) ? files.find(file => file.type === 'file' && file.size < 64000 && /\.(md|txt|json|js|ts|py|css|html|yaml|yml)$/i.test(file.name)) : null;
    if (readable) toolCalls.push({ id: `test-read-${latestUser}`, name: 'read_file', args: { path: readable.path } });
    if (prompt.includes('[test:write]')) toolCalls.push({ id: `test-write-${latestUser}`, name: 'write_file', args: { path: 'harness-test.txt', content: 'Hello from Harness test.\n这是审批与检查点的确定性测试文件。\n' } });
    if (prompt.includes('[test:command]')) toolCalls.push({ id: `test-command-${latestUser}`, name: 'run_command', args: { command: 'node --version' } });
    if (toolCalls.length) content = '继续测试真实工具调用；写入或命令将遵循当前审批策略。';
  }
  if (!toolCalls.length) {
    if (!recent.some(message => message.toolCalls?.some(call => call.id === `test-done-${latestUser}`))) {
      content = '完成测试检查，更新计划状态。';
      toolCalls = [{ id: `test-done-${latestUser}`, name: 'update_plan', args: { plan: [{ step: '查看工作区文件', status: 'completed' }, { step: '汇报发现与执行结果', status: 'completed' }] } }];
    } else {
      const failures = toolMessages.filter(message => { try { return Boolean(JSON.parse(message.content).error); } catch { return false; } });
      content = `测试任务已完成：执行了 ${toolMessages.length} 次工具调用${failures.length ? `，其中 ${failures.length} 次被拒绝或失败` : ''}。`;
    }
  }
  for (const chunk of content.match(/.{1,30}/gs) || []) { signal.throwIfAborted(); onDelta(chunk); }
  return { content, toolCalls, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: toolCalls.length ? 'tool_calls' : 'stop' };
}

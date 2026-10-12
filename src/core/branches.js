const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

export function branchHistory(source, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['messageId', 'mode', 'title'].includes(key))) fail('分支参数必须包含 messageId，可选 mode 和 title');
  const { messageId, mode = 'continue', title } = options;
  if (typeof messageId !== 'string' || !messageId || messageId.length > 512) fail('请选择有效的消息 ID');
  if (!['continue', 'retry'].includes(mode)) fail('分支模式必须为 continue 或 retry');
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200)) fail('分支标题必须是不超过 200 字符的非空文本');
  const target = source.messages.findIndex(message => message.id === messageId);
  if (target < 0) fail('消息不属于此会话或已不存在', 404);
  if (!['user', 'assistant'].includes(source.messages[target].role)) fail('请选择用户消息或助手回复创建分支');
  let end = target + 1;
  if (mode === 'retry') {
    const user = source.messages.slice(0, target + 1).findLastIndex(message => message.role === 'user');
    if (user < 0) fail('这条回复没有对应的用户消息，无法重新生成', 409);
    end = user;
  }
  const messages = structuredClone(source.messages.slice(0, end));
  const pending = new Set();
  const accept = message => {
    if (message.role === 'user' && pending.size) fail('历史工具调用尚未闭合，请选择完整的一轮对话', 409);
    for (const call of message.toolCalls || []) {
      if (typeof call.id !== 'string' || !call.id || pending.has(call.id)) fail('历史工具调用标识无效，无法创建分支', 409);
      pending.add(call.id);
    }
    if (message.role === 'tool' && !pending.delete(message.toolCallId)) fail('历史工具结果缺少对应调用，无法创建分支', 409);
  };
  messages.forEach(accept);
  while (mode === 'continue' && pending.size && source.messages[end]?.role === 'tool') {
    const message = structuredClone(source.messages[end++]);
    accept(message);
    messages.push(message);
  }
  if (pending.size) fail('所选消息的工具结果尚不完整，请选择其他消息或完整回复', 409);
  return { messages, mode, title: title?.trim(), messageId };
}

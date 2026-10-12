export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL = 40 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const attachmentExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'log', 'docx', 'xlsx', 'pptx', 'wav', 'mp3', 'mp4', 'webm'];
export const attachmentAccept = attachmentExtensions.map(extension => `.${extension}`).join(',');

export function attachmentIssue(attachments, provider) {
  if (attachments.some(file => file.kind === 'audio') && provider !== 'openai') return '音频附件需要支持音频输入的 OpenAI Chat 模型；Responses / Messages 当前不接收音频。请切换模型或移除音频。';
  return '';
}

export function attachmentSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

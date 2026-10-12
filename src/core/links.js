export function externalHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || !/^https?:\/\//i.test(value) || /[\\\u0000-\u0020\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

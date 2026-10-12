import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync } from 'fflate';

const fail = message => { throw new Error(message); };

function entities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, code) => {
    if (!code.startsWith('#')) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code] || match;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  });
}

function checkXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('文档包含不支持的 XML 实体声明');
  return xml;
}

function xmlText(xml) {
  return entities(checkXml(xml).replace(/<(?:w:tab|a:br)\b[^<>]*\/>/g, '\t').replace(/<\/(?:w:p|a:p|row)>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<[^<>]*>/g, '')).trim();
}

function* elements(xml, tag) {
  const pattern = new RegExp(`<(/?)${tag}\\b([^<>]*)>`, 'g');
  let current = null;
  for (const match of xml.matchAll(pattern)) {
    if (match[1]) {
      if (!current) fail('Office XML 包含不完整的标签');
      yield { attributes: current.attributes, text: xml.slice(current.start, match.index) };
      current = null;
    } else {
      if (current) fail('Office XML 包含不完整或嵌套的标签');
      if (match[2].endsWith('/')) yield { attributes: match[2], text: '' };
      else current = { attributes: match[2], start: match.index + match[0].length };
    }
  }
  if (current) fail('Office XML 包含未闭合的标签');
}

function attribute(attributes, name) {
  return attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2] || '';
}

function officeText(bytes, extension) {
  let expanded = 0;
  let entries = 0;
  const archive = unzipSync(bytes, { filter: entry => {
    if (++entries > 2000 || entry.originalSize > 12 * 1024 * 1024 || (expanded += entry.originalSize) > 24 * 1024 * 1024) fail('Office 文档解压后超过安全限制');
    return /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml))$/.test(entry.name);
  } });
  const parts = Object.entries(archive).sort(([first], [second]) => first.localeCompare(second, undefined, { numeric: true }));
  if (!parts.length) fail('文档没有可提取的正文，或不是有效的 Office Open XML 文件');
  const expected = extension === 'docx' ? 'word/' : extension === 'pptx' ? 'ppt/' : 'xl/';
  if (!parts.some(([name]) => name.startsWith(expected))) fail('Office 文档类型与扩展名不匹配');
  if (extension !== 'xlsx') return parts.filter(([name]) => name.startsWith(expected)).map(([name, data]) => `[${name}]\n${xmlText(Buffer.from(data).toString('utf8'))}`).join('\n\n');
  const strings = checkXml(Buffer.from(archive['xl/sharedStrings.xml'] || []).toString('utf8'));
  const shared = [...elements(strings, 'si')].map(entry => xmlText(entry.text));
  return parts.filter(([name]) => name.startsWith('xl/worksheets/')).map(([name, data]) => {
    const xml = checkXml(Buffer.from(data).toString('utf8'));
    const rows = [...elements(xml, 'row')].map(row => [...elements(row.text, 'c')].map(cell => {
      const location = attribute(cell.attributes, 'r');
      const value = elements(cell.text, 'v').next().value?.text || '';
      const type = attribute(cell.attributes, 't');
      return `${location}: ${type === 's' ? shared[Number(value)] || '' : type === 'inlineStr' ? xmlText(cell.text) : entities(value)}`;
    }).join('\t'));
    return `[${name}]\n${rows.join('\n')}`;
  }).join('\n\n');
}

try { parentPort.postMessage({ text: officeText(workerData.bytes, workerData.extension).slice(0, workerData.limit) }); }
catch (error) { parentPort.postMessage({ error: error.message }); }

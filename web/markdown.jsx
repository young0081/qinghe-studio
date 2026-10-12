import React, { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import { common } from 'lowlight';
import powershell from 'highlight.js/lib/languages/powershell';
import { externalHttpUrl } from '../src/core/links.js';
import { embeddedImageUrl, markdownSchema, markdownUrl, scopeMarkdownIds } from './markdown-policy.js';
import { katexOptions, limitMathLength, remarkLatexDelimiters } from './math.js';
import 'katex/dist/katex.min.css';
import './markdown.css';

const remarkPlugins = [remarkGfm, remarkMath, remarkLatexDelimiters];
const languages = { ...common, powershell };
const remarkRehypeOptions = { footnoteLabel: '脚注', footnoteBackLabel: '返回正文' };

function nodeText(node) {
  return node.type === 'text' ? node.value : (node.children || []).map(nodeText).join('');
}

function CodeBlock({ node, children, id }) {
  const content = nodeText(node);
  const language = node.children.find(child => child.tagName === 'code')?.properties?.className?.find(value => value.startsWith('language-'))?.slice(9) || 'text';
  const [status, setStatus] = useState('idle');
  const timer = useRef();
  useEffect(() => { setStatus('idle'); return () => clearTimeout(timer.current); }, [content]);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(content);
      setStatus('copied');
      timer.current = setTimeout(() => setStatus('idle'), 1800);
    } catch { setStatus('error'); }
  };
  return <div className="code-block" id={id}><div className="code-title"><span>{language}</span><button type="button" onClick={copy} aria-label="复制代码" data-copied={status === 'copied'}>{status === 'copied' ? '已复制' : '复制'}</button></div><pre tabIndex={0} aria-label={`${language} 代码`}>{children}</pre>{status === 'error' && <p className="markdown-error" role="status">复制失败，请手动选择代码。</p>}</div>;
}

export function MarkdownLink({ href, children, title, id, ...properties }) {
  const [error, setError] = useState('');
  const safeHref = href?.startsWith('#') ? href : externalHttpUrl(href);
  if (!safeHref) return <span>{children}</span>;
  const open = async event => {
    if (safeHref.startsWith('#')) {
      event.preventDefault();
      const target = document.getElementById(safeHref.slice(1));
      if (target?.closest('.markdown') === event.currentTarget.closest('.markdown')) {
        target.scrollIntoView({ block: 'nearest' });
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    } else if (window.harnessDesktop) {
      event.preventDefault();
      setError('');
      try {
        if (!window.harnessDesktop.openExternal) throw new Error('请更新并重启桌面版');
        await window.harnessDesktop.openExternal(safeHref);
      } catch { setError('无法打开外部链接，请更新桌面版或手动复制链接。'); }
    }
  };
  return <><a href={safeHref} id={id} title={title} target={safeHref.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer" onClick={open} onAuxClick={event => { if (event.button === 1 && window.harnessDesktop) void open(event); }} aria-label={properties['aria-label']} aria-describedby={properties['aria-describedby']} aria-labelledby={properties['aria-labelledby']}>{children}</a>{error && <span className="markdown-error" role="status">{error}</span>}</>;
}

function MarkdownImage({ src, alt, title }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const embedded = embeddedImageUrl(src);
  if (embedded && !failed) return <img className="markdown-image" src={embedded} alt={alt || ''} title={title} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  const external = externalHttpUrl(src);
  return <span className="markdown-image-placeholder">{alt || '图片'} · {external ? <MarkdownLink href={external}>在浏览器打开图片</MarkdownLink> : failed ? '图片加载失败' : '不支持此图片地址'}{external && <small>为保护隐私，不自动加载外部图片</small>}</span>;
}

const components = {
  pre: CodeBlock,
  a: MarkdownLink,
  img: MarkdownImage,
  table: ({ children, id }) => <div className="markdown-table" role="region" aria-label="Markdown 表格" tabIndex={0}><table id={id}>{children}</table></div>,
  input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled readOnly aria-label={checked ? '已完成任务' : '未完成任务'} />,
  span: ({ node, className, children, ...properties }) => <span {...properties} className={className} {...(className?.split(' ').includes('katex-display') ? { tabIndex: 0, role: 'group', 'aria-label': '独立数学公式' } : {})}>{children}</span>,
};

export default memo(function Markdown({ text = '' }) {
  const identifier = useId();
  const rehypePlugins = useMemo(() => [rehypeRaw, [rehypeSanitize, markdownSchema], [scopeMarkdownIds, { prefix: `markdown-${identifier.replace(/[^\w-]/g, '')}-` }], limitMathLength, [rehypeKatex, katexOptions], [rehypeHighlight, { languages, detect: false, ignoreMissing: true }]], [identifier]);
  return <div className="markdown"><ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} remarkRehypeOptions={remarkRehypeOptions} components={components} urlTransform={markdownUrl}>{text}</ReactMarkdown></div>;
});

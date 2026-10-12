import { defaultSchema } from 'rehype-sanitize';
import { externalHttpUrl } from '../src/core/links.js';

export const markdownSchema = {
  ...defaultSchema,
  tagNames: ['a', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
  strip: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'video', 'audio'],
  attributes: {
    ...defaultSchema.attributes,
    '*': ['id', 'title', 'lang', 'dir'],
    details: ['open'],
    img: ['src', 'alt', 'title'],
    input: [...defaultSchema.attributes.input, 'checked'],
    ol: [...defaultSchema.attributes.ol, 'start', 'reversed'],
    th: ['align', 'colSpan', 'rowSpan', 'scope'],
    td: ['align', 'colSpan', 'rowSpan'],
    code: [['className', /^language-[\w+.#-]+$/, 'math-inline', 'math-display']],
  },
  protocols: { ...defaultSchema.protocols, href: ['http', 'https'], src: ['http', 'https', 'data'] },
};

export function embeddedImageUrl(value) {
  return typeof value === 'string' && value.length <= 2 * 1024 * 1024 && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : '';
}

export function markdownUrl(value, key) {
  if (key === 'src') return embeddedImageUrl(value) || externalHttpUrl(value);
  if (key === 'href' && value.startsWith('#')) return value;
  return externalHttpUrl(value);
}

export function scopeMarkdownIds({ prefix }) {
  return tree => {
    const elements = [];
    const collect = node => {
      if (node.type === 'element') elements.push(node);
      for (const child of node.children || []) collect(child);
    };
    collect(tree);
    const identifiers = new Map();
    for (const node of elements) {
      for (const key of ['id', 'name']) {
        const value = node.properties?.[key];
        if (typeof value !== 'string') continue;
        const scoped = `${prefix}${value}`;
        identifiers.set(value.slice(defaultSchema.clobberPrefix.length), scoped);
        node.properties[key] = scoped;
      }
    }
    for (const node of elements) {
      const properties = node.properties || {};
      if (typeof properties.href === 'string' && properties.href.startsWith('#')) {
        let target = properties.href.slice(1);
        try { target = decodeURIComponent(target); } catch {}
        properties.href = identifiers.has(target) ? `#${identifiers.get(target)}` : '';
      }
      for (const key of ['ariaDescribedBy', 'ariaLabelledBy']) {
        if (Array.isArray(properties[key])) properties[key] = properties[key].map(value => identifiers.get(value.slice(defaultSchema.clobberPrefix.length))).filter(Boolean);
      }
    }
  };
}

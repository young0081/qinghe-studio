import test from 'node:test';
import assert from 'node:assert/strict';
import { externalHttpUrl } from '../src/core/links.js';
import { embeddedImageUrl, markdownUrl, scopeMarkdownIds } from '../web/markdown-policy.js';

test('external links accept only explicit HTTP(S) URLs without credentials or control characters', () => {
  assert.equal(externalHttpUrl('https://example.com/docs?query=one#two'), 'https://example.com/docs?query=one#two');
  assert.equal(externalHttpUrl('HTTP://localhost:8080/docs'), 'http://localhost:8080/docs');
  for (const value of [null, {}, '', '/api/settings', '//example.com', 'javascript:alert(1)', 'data:text/html,attack', 'file:///C:/file', 'mailto:user@example.com', 'https://user:pass@example.com', 'https://example.com/\nattack', 'https://example.com\\@evil.com', `https://example.com/${'a'.repeat(8192)}`]) assert.equal(externalHttpUrl(value), '', String(value));
});

test('Markdown image and link transforms block active data, relative requests and unknown protocols', () => {
  const raster = 'data:image/png;base64,aGVsbG8=';
  assert.equal(embeddedImageUrl(raster), raster);
  assert.equal(markdownUrl(raster, 'src'), raster);
  assert.equal(markdownUrl(raster, 'href'), '');
  assert.equal(markdownUrl('#footnote', 'href'), '#footnote');
  assert.equal(markdownUrl('https://example.com/image.png', 'src'), 'https://example.com/image.png');
  for (const value of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,aGVsbG8=', 'data:image/png;base64,!!!', `data:image/png;base64,${'a'.repeat(2 * 1024 * 1024)}`, '/api/settings', 'javascript:alert(1)']) assert.equal(markdownUrl(value, 'src'), '');
});

test('sanitized anchors, footnotes and ARIA references remain local to one Markdown message', () => {
  const tree = { type: 'root', children: [
    { type: 'element', properties: { id: 'user-content-user-content-fn-1' }, children: [] },
    { type: 'element', properties: { id: 'user-content-footnote-label' }, children: [] },
    { type: 'element', properties: { href: '#user-content-fn-1', ariaDescribedBy: ['user-content-footnote-label'] }, children: [] },
    { type: 'element', properties: { href: '#unrelated-ui' }, children: [] },
  ] };
  scopeMarkdownIds({ prefix: 'message-1-' })(tree);
  assert.equal(tree.children[0].properties.id, 'message-1-user-content-user-content-fn-1');
  assert.equal(tree.children[2].properties.href, '#message-1-user-content-user-content-fn-1');
  assert.deepEqual(tree.children[2].properties.ariaDescribedBy, ['message-1-user-content-footnote-label']);
  assert.equal(tree.children[3].properties.href, '');
});

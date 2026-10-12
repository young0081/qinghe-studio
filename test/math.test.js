import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { markdownSchema, markdownUrl } from '../web/markdown-policy.js';
import { katexOptions, limitMathLength, maximumMathLength, remarkLatexDelimiters } from '../web/math.js';
import { mathSample, mathStreaming } from './fixtures/math.js';

function render(text) {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkMath, remarkLatexDelimiters], rehypePlugins: [rehypeRaw, [rehypeSanitize, markdownSchema], limitMathLength, [rehypeKatex, katexOptions]], urlTransform: markdownUrl }, text));
}

test('LaTeX inline and display delimiters produce accessible KaTeX without changing code or escaped dollars', () => {
  for (const source of [String.raw`$E=mc^2$`, String.raw`\(\frac{1}{2}\)`]) {
    const html = render(source);
    assert.match(html, /class="katex"/);
    assert.match(html, /<math xmlns=/);
    assert.doesNotMatch(html, /katex-display|katex-error/);
  }
  for (const source of [String.raw`$$\sum_{n=1}^{\infty}\frac{1}{n^2}$$`, '$$\n\\sqrt{x^2+y^2}\n$$', String.raw`\[\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}\]`, '\\[\n\\int_0^1 x^2\\,dx\n\\]']) {
    assert.match(render(source), /class="katex-display"/);
    assert.doesNotMatch(render(source), /katex-error/);
  }
  assert.doesNotMatch(render('`$x$ \\(x\\)`\n\n```latex\n$$x$$\n\\[x\\]\n```\n\n    $x$\n\n价格 \\$5 和 \\$10；\\\\(不是公式\\\\)'), /class="katex/);
  assert.match(render('```math\n\\frac{a}{b}\n```'), /class="katex-display"/);
});

test('LaTeX survives Markdown containers and incomplete expressions recover on completion', () => {
  assert.match(render('> \\[\n> \\frac{a}{b}\n> \\]\n\n- 行内 \\(x^2\\)\n\n| 公式 |\n| --- |\n| $x^2$ |'), /katex-display/);
  for (const source of ['\\(\\frac{1}', '\\[x^2', '$x^2']) assert.doesNotMatch(render(source), /class="katex"/);
  assert.match(render(String.raw`\(\frac{1}{2}\)`), /class="katex"/);
  assert.match(render('$\\frac{$'), /katex-error/);
  assert.match(render('$$\n\\unknowncommand{value}\n$$\n\n后续正文'), /后续正文/);
});

test('untrusted LaTeX cannot create links, remote images, HTML attributes or shared macros', () => {
  for (const command of [String.raw`\href{javascript:alert(1)}{click}`, String.raw`\href{https://example.invalid}{click}`, String.raw`\includegraphics{https://example.invalid/image}`, String.raw`\htmlClass{attack}{x}`, String.raw`\htmlStyle{position:fixed}{x}`, String.raw`\htmlId{settings}{x}`, String.raw`\htmlData{action=attack}{x}`]) {
    const html = render(`$${command}$`);
    assert.doesNotMatch(html, /<a\b|<img\b|class="attack"|id="settings"|style="position:fixed|data-action=/);
  }
  assert.doesNotMatch(render('<svg onload="alert(1)"></svg><math><mtext>raw-math</mtext></math>'), /<svg|<math|onload|raw-math/);
  assert.match(render(String.raw`$\def\loop{\loop}\loop$`), /katex-error/);
  assert.match(render(String.raw`$\gdef\custommacro{42}\custommacro$ $\custommacro$`), /katex-error|color:#9e6148/);
});

test('oversized math stays readable without invoking an unbounded render', () => {
  const source = 'x+'.repeat(maximumMathLength / 2 + 1);
  const html = render(`$$\n${source}\n$$`);
  assert.doesNotMatch(html, /class="katex/);
  assert.match(html, /公式超过 20000 字符/);
  assert.ok(html.includes(source));
});

test('multiline stream prefixes, Windows line endings and escaped closing sequences remain parseable', () => {
  for (let length = 0; length <= mathStreaming.length; length++) assert.doesNotThrow(() => render(mathStreaming.slice(0, length)), `prefix ${length}`);
  for (const source of [mathSample, mathSample.replace(/\n/g, '\r\n'), '前文 \\(\\text{value}\\) 后文', '\\[\\begin{matrix}a \\\\] b\\end{matrix}\\]', '- \\[\n  x^2\n  \\]']) {
    const html = render(source);
    assert.match(html, /class="katex/);
    assert.doesNotMatch(html, /katex-error/);
  }
});

export const katexOptions = { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml', errorColor: '#9e6148' };
export const maximumMathLength = 20000;

function tokenizeLatex(effects, success, failure) {
  let closing;
  let length = 0;
  return start;
  function start(code) {
    effects.enter('latexMath');
    effects.enter('latexMathSequence');
    effects.consume(code);
    return opening;
  }
  function opening(code) {
    if (code !== 40 && code !== 91) return failure(code);
    closing = code === 40 ? 41 : 93;
    effects.consume(code);
    effects.exit('latexMathSequence');
    return inside;
  }
  function inside(code) {
    if (code === null || length++ > maximumMathLength) return failure(code);
    if (code >= -5 && code <= -3) {
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return inside;
    }
    if (code === 92) {
      effects.enter('latexMathSequence');
      effects.consume(code);
      return afterBackslash;
    }
    effects.enter('latexMathData');
    return content(code);
  }
  function content(code) {
    if (code === null || code === 92 || code >= -5 && code <= -3 || length++ > maximumMathLength) {
      effects.exit('latexMathData');
      return inside(code);
    }
    effects.consume(code);
    return content;
  }
  function afterBackslash(code) {
    if (code === closing) {
      effects.consume(code);
      effects.exit('latexMathSequence');
      effects.exit('latexMath');
      return success;
    }
    if (code === 92) { effects.consume(code); effects.exit('latexMathSequence'); return inside; }
    effects.exit('latexMathSequence');
    return inside(code);
  }
}

export function remarkLatexDelimiters() {
  const data = this.data();
  (data.micromarkExtensions ||= []).push({ text: { 92: { name: 'latexMath', tokenize: tokenizeLatex } } });
  (data.fromMarkdownExtensions ||= []).push({
    enter: { latexMath(token) { this.enter({ type: 'inlineMath', value: '' }, token); this.buffer(); } },
    exit: { latexMath(token) {
      this.resume();
      const raw = this.sliceSerialize(token);
      const node = this.stack[this.stack.length - 1];
      node.value = raw.slice(2, -2).trim();
      node.data = { hName: 'code', hProperties: { className: ['language-math', raw[1] === '[' ? 'math-display' : 'math-inline'] }, hChildren: [{ type: 'text', value: node.value }] };
      this.exit(token);
    } },
  });
  return (tree, file) => {
    const source = String(file);
    const visit = node => {
      if (node.type === 'inlineMath' && source.slice(node.position?.start.offset, node.position?.start.offset + 2) === '$$') node.data.hProperties.className = ['language-math', 'math-display'];
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}

export function limitMathLength() {
  return tree => {
    const textContent = node => node.type === 'text' ? node.value : (node.children || []).map(textContent).join('');
    const visit = node => {
      const classes = node.properties?.className;
      if (Array.isArray(classes) && classes.some(value => ['language-math', 'math-inline', 'math-display'].includes(value)) && textContent(node).length > maximumMathLength) {
        node.properties.className = ['no-highlight'];
        node.properties.title = `公式超过 ${maximumMathLength} 字符，保留源码`;
      }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}

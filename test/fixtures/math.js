export const mathSample = String.raw`# 数学公式

行内公式 $E=mc^2$，以及括号语法 \(\frac{a}{b}\)，与正文自然排列。

## 独立公式

$$a^2+b^2=c^2$$

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

\[
\begin{aligned}
f(x)&=x^2+2x+1 \\
&=(x+1)^2
\end{aligned}
\]

$$
\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}
\begin{bmatrix}x \\ y\end{bmatrix}
=\begin{bmatrix}x+2y \\ 3x+4y\end{bmatrix}
$$

| 场景 | 数学表达式 |
| --- | --- |
| 条件概率 | $P(A\mid B)=\frac{P(A\cap B)}{P(B)}$ |

> \[\sqrt{x^2+y^2}\]

` + '```math\n\\lim_{n\\to\\infty}\\left(1+\\frac{1}{n}\\right)^n=e\n```\n\n```latex\n$这是示例源码$\n\\[x^2\\]\n```\n\n公式检查完成。';

export const mathUnsafe = String.raw`# 公式安全检查

语法错误：$\frac{$

未知命令：$\notASupportedCommand{x}$

禁止链接：$\href{javascript:alert(1)}{危险链接}$

禁止外部图片：$\includegraphics{https://example.invalid/math-image}$

禁止 HTML 样式：$\htmlStyle{position:fixed}{x}$

禁止 HTML ID：$\htmlId{settings}{x}$

递归宏限制：$\def\loop{\loop}\loop$

<math><mtext>不可信原始 MathML</mtext></math><svg onload="alert(1)"></svg>

安全检查后的正文仍然可读。`;

export const mathStreaming = '行内正在生成：\\(\\frac{1}{2}+\\sqrt{3}\\)。\n\n\\[\n\\begin{aligned}\n' + Array.from({ length: 10 }, (_, index) => `f_${index}(x)&=x^${index}+\\frac{1}{${index + 1}}`).join(String.raw` \\` + '\n') + '\n\\end{aligned}\n\\]\n\n数学流式输出完成。';

export const mathWide = '## 长公式\n\n\\[\n' + Array.from({ length: 45 }, (_, index) => `a_{${index + 1}}x^{${index + 1}}`).join('+') + '=0\n\\]\n\n行内长公式 $' + Array.from({ length: 35 }, (_, index) => `b_{${index + 1}}`).join('+') + '$ 结束。';

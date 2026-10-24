const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function('module', 'exports', 'require', js)(module, module.exports, name => {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    return require(name);
  });
  return module.exports;
}
const { normalizeMathDelimiters: fix } = load(path.join(root, 'lib/chat/mathDelimiters.ts'));
const raw = String.raw;

test('inline \\( \\) becomes $ $', () => {
  assert.equal(fix(raw`设 \(L\)，每组有 \(r\) 行`), '设 $L$，每组有 $r$ 行');
  assert.equal(fix(raw`\( a < b \)`), '$a < b$');
});

test('a \\[ \\] on its own line becomes a $$ block, keeping indentation', () => {
  assert.equal(fix(raw`前

\[ \text{组数}=\frac{L}{r} \]

后`), raw`前

$$
\text{组数}=\frac{L}{r}
$$

后`);
  assert.equal(fix('- 项\n  ' + raw`\[ x^2 \]`), '- 项\n  $$\n  x^2\n  $$');
  assert.equal(fix(raw`\[
 a+b
\]`), '$$\na+b\n$$');
});

test('\\[ \\] inside a sentence stays inline', () => {
  assert.equal(fix(raw`结果是 \[ x+1 \] 这样`), '结果是 $x+1$ 这样');
});

test('code is left alone', () => {
  const fenced = '```latex\n' + raw`\(a\) and \[b\]` + '\n```';
  assert.equal(fix(fenced), fenced);
  assert.equal(fix(raw`行内 ` + '`' + raw`\(x\)` + '`' + raw` 保持，\(y\) 转换`), raw`行内 ` + '`' + raw`\(x\)` + '`' + ' 保持，$y$ 转换');
  assert.equal(fix('``a ` ' + raw`\(x\)` + ' ``' + raw`\(z\)`), '``a ` ' + raw`\(x\)` + ' ``$z$');
  const open = '说明\n```python\nprint("' + raw`\(x\)` + '")';
  assert.equal(fix(open), open); // 流式输出时围栏还没闭合
  assert.equal(fix('~~~\n' + raw`\(a\)` + '\n~~~\n' + raw`\(b\)`), '~~~\n' + raw`\(a\)` + '\n~~~\n$b$');
});

test('escaped backslashes, empty bodies and plain text are untouched', () => {
  assert.equal(fix(raw`字面量 \\(x\\)`), raw`字面量 \\(x\\)`);
  assert.equal(fix(raw`空的 \(  \) 保持`), raw`空的 \(  \) 保持`);
  assert.equal(fix('没有公式，只有 $a+b$ 和 **加粗**'), '没有公式，只有 $a+b$ 和 **加粗**');
  assert.equal(fix(''), '');
});

test('end to end: CJK bold and both math notations render', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { default: ReactMarkdown } = await import('react-markdown');
  const { default: remarkGfm } = await import('remark-gfm');
  const { default: remarkMath } = await import('remark-math');
  const { default: rehypeKatex } = await import('rehype-katex');
  const { default: remarkCjkFriendly } = await import('remark-cjk-friendly');
  const render = (text, cjk = true) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, ...(cjk ? [remarkCjkFriendly] : []), remarkMath],
    rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: false }]],
  }, fix(text)));

  const bold = '细节是：**取模用的是行数还是组数。**你可以先概括一下，**注意（此处）**易错。';
  assert.match(render(bold, false), /\*\*取模/, '没有插件时星号会原样显示（复现问题）');
  const html = render(bold);
  assert.ok(!html.includes('**'), html);
  assert.match(html, /<strong>取模用的是行数还是组数。<\/strong>你可以/);
  assert.match(html, /<strong>注意（此处）<\/strong>易错/);

  const math = render(raw`设 \(L\) 行：

\[ \text{组数}=\frac{L}{r} \]

同样 $r=1$。`);
  assert.equal((math.match(/class="katex"/g) || []).length, 3, '两个行内公式 + 公式块里的一个');
  assert.equal((math.match(/katex-display/g) || []).length, 1, '一个公式块');
  assert.ok(!/\\\(|\\\[/.test(math.replace(/<annotation[\s\S]*?<\/annotation>/g, '')), '不应残留未转换的 \\( \\[');
});

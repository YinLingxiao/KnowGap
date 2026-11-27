// 引用预览交互测试：正文角标渲染（label 命中/未命中、代码与链接保护、跨消息隔离）、
// 点击回调参数（documentId/page/excerpt）、非法页码回退，以及预览面板 PDF/Excel 定位纯函数。
// 只读源码，不修改功能实现；加载方式与 material-preview.test.cjs 等项目惯例一致。
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { resolveI18n } = require('./i18n-support.cjs');

// CSS Modules 打桩：类名原样返回键名，便于断言 class="citationMark" 等输出。
const cssProxy = new Proxy({}, { get: (_target, key) => (key === '__esModule' ? true : key) });

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}

// react-markdown / remark-gfm / rehype-highlight 是纯 ESM，CJS 里只能动态 import。
const deps = {};
before(async () => {
  deps.ReactMarkdown = (await import('react-markdown')).default;
  deps.remarkGfm = (await import('remark-gfm')).default;
  deps.rehypeHighlight = (await import('rehype-highlight')).default;
});

/** 每次调用都重新执行模块代码，因此可在同一文件内用不同 ReactMarkdown 实现加载多份 Markdown。 */
function loadMarkdown(reactMarkdown) {
  const file = path.join(__dirname, '../src/components/chat/Markdown.tsx');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', transpile(file))(mod, mod.exports, (name) => {
    if (resolveI18n(name)) return resolveI18n(name);
    if (name.endsWith('.css')) return { __esModule: true, default: cssProxy };
    if (name === 'react-markdown') return { __esModule: true, default: reactMarkdown ?? deps.ReactMarkdown };
    if (name === 'remark-gfm') return { __esModule: true, default: deps.remarkGfm };
    if (name === 'rehype-highlight') return { __esModule: true, default: deps.rehypeHighlight };
    // transpileModule 未开 esModuleInterop，CJS 语言包的 default import 需要手动包一层 default。
    if (name.startsWith('highlight.js/lib/languages/')) {
      const language = require(name);
      return { __esModule: true, default: language.default ?? language };
    }
    if (name === 'lucide-react') return { Check: () => null, Copy: () => null };
    if (name === './LearningWidget') return { LearningWidget: () => null, WidgetLiveContext: React.createContext(false) };
    if (name === './widgets/VisualCard') return { VisualCard: () => null };
    if (name === './math') return { mathRemarkPlugins: [], mathRehypePlugins: [] };
    if (name === '@/lib/chat/mathDelimiters') return { normalizeMathDelimiters: (text) => text };
    return require(name);
  });
  return mod.exports;
}

function loadPanel() {
  const file = path.join(__dirname, '../src/components/MaterialPreviewPanel.tsx');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', transpile(file))(mod, mod.exports, (name) => {
    if (resolveI18n(name)) return resolveI18n(name);
    if (name.endsWith('.css')) return { __esModule: true, default: cssProxy };
    if (name === '@/lib/api/material-client') return { createMaterialClient: () => ({}) };
    if (name === '@/lib/api/errors') return { toApiError: (error) => ({ message: String(error) }) };
    if (name === '@/lib/cx') return { cx: (...parts) => parts.filter(Boolean).join(' ') };
    if (name === '@/lib/materials/pptx') return {
      renderPptxDocument: async () => ({ html: '', slideCount: 0, width: 960, height: 720 }),
      clampPptxScale: () => 1,
      pptxFrameDocument: () => '',
    };
    if (name === './chat/Markdown') return { Markdown: () => null };
    return require(name);
  });
  return mod.exports;
}

const SOURCES = [
  { id: 's1', documentId: 'doc-1', title: '线性代数讲义', label: '资料1', page: 3, excerpt: '矩阵的秩等于非零行个数。', source: 'space' },
  { id: 's2', documentId: 'doc-2', title: '概率论课件', label: '空间资料2', page: null, excerpt: '贝叶斯公式摘录。', source: 'space' },
  { id: 's3', documentId: 'doc-3', title: '通用参考手册', label: '通用资料3', page: 0, excerpt: '通用资料摘录。', source: 'general' },
];

const noop = () => {};
const render = (md, props) => renderToStaticMarkup(React.createElement(md.Markdown, props));
const marks = (html) => [...html.matchAll(/data-citation-label="([^"]+)"/g)].map((match) => match[1]);

// ---------------------------------------------------------------- 角标渲染（真实 react-markdown）

test('有效 label：资料/空间资料/通用资料都渲染为带 data-citation-label 的角标按钮', () => {
  const md = loadMarkdown();
  const html = render(md, {
    text: '依据[资料1]与[空间资料2]，另见[通用资料3]。',
    sources: SOURCES,
    onOpenCitation: noop,
  });
  assert.deepEqual(marks(html), ['资料1', '空间资料2', '通用资料3']);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.ok(html.includes('class="citationMark"'), '角标应使用 citationMark 样式');
  assert.ok(html.includes('[资料1]'), '角标文本保留原始 label 写法');
});

test('无效 label：sources 中不存在的 label 保持原文，不产生按钮', () => {
  const md = loadMarkdown();
  const html = render(md, {
    text: '[资料9] 不存在，[资料1] 存在；[资料0] 与 [资料] 本就不是合法标注。',
    sources: SOURCES,
    onOpenCitation: noop,
  });
  assert.deepEqual(marks(html), ['资料1']);
  assert.ok(html.includes('[资料9]'), '未命中 label 应原样保留');
  assert.ok(html.includes('[资料0]') && html.includes('[资料]'));
});

test('缺少 sources 或 onOpenCitation 时不启用角标转换', () => {
  const md = loadMarkdown();
  const noSources = render(md, { text: '见[资料1]', onOpenCitation: noop });
  const noCallback = render(md, { text: '见[资料1]', sources: SOURCES });
  assert.deepEqual(marks(noSources), []);
  assert.deepEqual(marks(noCallback), []);
  assert.ok(noSources.includes('[资料1]') && noCallback.includes('[资料1]'));
});

test('代码保护：行内代码与围栏代码块中的 [资料N] 不转换，正文仍转换', () => {
  const md = loadMarkdown();
  const html = render(md, {
    text: '正文[资料1]，行内 `[资料1]`，围栏：\n\n```js\n// [资料1]\nconst a = 1;\n```',
    sources: SOURCES,
    onOpenCitation: noop,
  });
  assert.deepEqual(marks(html), ['资料1'], '只有正文那一处被转换');
  assert.equal((html.match(/\[资料1\]/g) ?? []).length, 3, '代码内两处保持原始文本');
});

test('链接保护：链接文字里的 [资料N] 不渲染为按钮', () => {
  const md = loadMarkdown();
  const html = render(md, {
    text: '[[资料1]](https://example.com) 与正文[资料1]',
    sources: SOURCES,
    onOpenCitation: noop,
  });
  assert.deepEqual(marks(html), ['资料1']);
  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(!/<a[^>]*>[^<]*<button/.test(html), '链接内部不应嵌套角标按钮');
});

test('跨消息隔离：各消息只认自己 sources 里的 label', () => {
  const md = loadMarkdown();
  const otherMessageSources = [
    { id: 's9', documentId: 'doc-9', title: '另一消息的资料', label: '资料9', page: 7, excerpt: '另一消息摘录。' },
  ];
  const text = '[资料1] 与 [资料9]';
  const first = render(md, { text, sources: SOURCES, onOpenCitation: noop });
  const second = render(md, { text, sources: otherMessageSources, onOpenCitation: noop });
  assert.deepEqual(marks(first), ['资料1'], '本条消息不应把别的消息的资料9变成角标');
  assert.deepEqual(marks(second), ['资料9'], '另一条消息只认资料9');
  assert.ok(first.includes('[资料9]') && second.includes('[资料1]'));
});

// ---------------------------------------------------------------- 点击回调（捕获真实 button renderer）

/** 捕获 Markdown 传给 ReactMarkdown 的 components，取其 button renderer 直接验证 onClick 行为。 */
function captureButtonRenderer(props) {
  const captured = {};
  const FakeMarkdown = (received) => { captured.props = received; return null; };
  const md = loadMarkdown(FakeMarkdown);
  render(md, props);
  return captured.props;
}

test('点击角标：回调收到该 label 对应的 documentId、page、excerpt', () => {
  const calls = [];
  const captured = captureButtonRenderer({ text: '[资料1]', sources: SOURCES, onOpenCitation: (req) => calls.push(req) });
  const button = captured.components.button;
  assert.equal(typeof button, 'function', 'sources + onOpenCitation 齐全时应提供 button renderer');

  const element = button({ type: 'button', className: ['citationMark'], 'data-citation-label': '资料1', children: '[资料1]' });
  assert.equal(element.props['aria-label'], '打开 资料1 的原文');
  assert.equal(element.props.title, '矩阵的秩等于非零行个数。');
  element.props.onClick();
  assert.deepEqual(calls, [
    { documentId: 'doc-1', title: '线性代数讲义', page: 3, excerpt: '矩阵的秩等于非零行个数。' },
  ]);
});

test('点击角标：sources 中不存在的 label 不绑定 onClick', () => {
  const captured = captureButtonRenderer({ text: '[资料9]', sources: SOURCES, onOpenCitation: noop });
  const element = captured.components.button({ type: 'button', 'data-citation-label': '资料9', children: '[资料9]' });
  assert.equal(element.props.onClick, undefined);
  assert.equal(element.props['aria-label'], undefined);
});

test('无 onOpenCitation 时 Markdown 不注册引用 button renderer', () => {
  const captured = captureButtonRenderer({ text: '[资料1]', sources: SOURCES });
  assert.equal(captured.components.button, undefined);
});

// ---------------------------------------------------------------- 页码回退与请求构造

test('toCitationOpenRequest：透传 documentId/title/excerpt，非法页码一律回退第 1 页', () => {
  const md = loadMarkdown();
  for (const page of [undefined, null, 0, -2, 1.5, Number.NaN, '3']) {
    const request = md.toCitationOpenRequest({ ...SOURCES[0], page });
    assert.deepEqual(request, {
      documentId: 'doc-1', title: '线性代数讲义', page: 1, excerpt: '矩阵的秩等于非零行个数。',
    }, `page=${String(page)} 应回退为 1`);
  }
  assert.equal(md.toCitationOpenRequest({ ...SOURCES[0], page: 12 }).page, 12);
});

test('normalizeInitialPage：非正整数页码回退第 1 页', () => {
  const panel = loadPanel();
  for (const page of [undefined, null, 0, -1, 2.5, Number.NaN, '4']) {
    assert.equal(panel.normalizeInitialPage(page), 1);
  }
  assert.equal(panel.normalizeInitialPage(4), 4);
});

// ---------------------------------------------------------------- PDF / Excel 定位纯函数

test('pdfPagesToRender：目标页在范围内时不重复追加', () => {
  const panel = loadPanel();
  assert.deepEqual(panel.pdfPagesToRender(5, 3), [1, 2, 3, 4, 5]);
  assert.deepEqual(panel.pdfPagesToRender(1, 1), [1]);
});

test('pdfPagesToRender：超过 100 页时只渲染前 100 页并额外带上引用页', () => {
  const panel = loadPanel();
  const pages = panel.pdfPagesToRender(150, 120);
  assert.equal(pages.length, 101);
  assert.deepEqual(pages.slice(0, 3), [1, 2, 3]);
  assert.equal(pages[99], 100);
  assert.equal(pages[100], 120, '引用页即使超出前 100 页也要渲染');

  const clamped = panel.pdfPagesToRender(150, 180);
  assert.equal(clamped[clamped.length - 1], 150, '超出总页数时定位到最后一页');
  assert.equal(panel.pdfPagesToRender(150, 50).length, 100, '引用页已在前 100 页内则不追加');
});

test('pdfPagesToRender：非法总页数返回空数组', () => {
  const panel = loadPanel();
  for (const count of [0, -3, 2.5, Number.NaN]) {
    assert.deepEqual(panel.pdfPagesToRender(count, 1), []);
  }
});

test('worksheetIndex：initialPage 映射为 0 基工作表下标并夹取到范围内', () => {
  const panel = loadPanel();
  assert.equal(panel.worksheetIndex(2, 5), 1);
  assert.equal(panel.worksheetIndex(undefined, 4), 0, '缺省定位第一个工作表');
  assert.equal(panel.worksheetIndex(99, 3), 2, '超出工作表数量时定位最后一个');
  assert.equal(panel.worksheetIndex(0, 3), 0, '非法页码回退第一个');
});

test('worksheetIndex：工作表数量非法时返回 null', () => {
  const panel = loadPanel();
  for (const count of [0, -1, 2.5, Number.NaN]) {
    assert.equal(panel.worksheetIndex(1, count), null);
  }
});
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Exercise the actual message branch without a browser or backend.
const source = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/MessageList.tsx'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', js)(loaded, loaded.exports, (name) => {
  if (name === 'react') return {
    ...React,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (current) => ({ current }),
    useCallback: (callback) => callback,
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
  if (name === 'react/jsx-runtime' || name === 'lucide-react') return require(name);
  if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => key }) };
  if (name === '@/lib/cx') return { cx: (...values) => values.filter(Boolean).join(' ') };
  if (name === './SelectionToolbar') return { SelectionToolbar: () => null };
  return {};
});

function fixture(title = 'KMP算法与next数组') {
  return {
    id: 'merged-message', role: 'assistant', content: '隐藏的合并消息正文', status: 'complete',
    threadSummary: { threadId: 'thread-kmp', title, summary: '隐藏的详细总结',
      takeaways: ['隐藏的要点'], memoryIds: ['memory-kmp'] },
  };
}

function render(message, onOpenSummary) {
  return loaded.exports.MessageList({
    conversationId: 'main', messages: [message], problems: {},
    memoriesById: { 'memory-kmp': { summary: '隐藏的关联记忆' } },
    conversationSubjectId: 'subject-one', subjectNames: {}, phase: null, followNonce: 0,
    onRegenerate() {}, onStartExercise() {}, onOpenMemories() {}, onOpenSummary,
  });
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!React.isValidElement(node)) return undefined;
  return predicate(node) ? node : find(node.props.children, predicate);
}

test('merged messages show only the completed Thread name, not summary, takeaways, memories or raw content', () => {
  const html = renderToStaticMarkup(render(fixture()));
  assert.match(html, /KMP算法与next数组/);
  assert.match(html, /lucide-circle-check/);
  assert.doesNotMatch(html, /隐藏的|<ul|已解决<\/span>/);
});

test('the compact entry opens the original Thread and preserves history-scroll anchors', () => {
  let opened = null;
  const tree = render(fixture(), (id) => { opened = id; });
  const entry = find(tree, (node) => node.type === 'button' && node.props.className === 'resolvedThread');
  assert.equal(entry.props.type, 'button');
  assert.equal(entry.props['aria-label'], '查看已解决的支线：KMP算法与next数组');
  entry.props.onClick();
  assert.equal(opened, 'thread-kmp');
  const anchor = find(tree, (node) => node.props['data-thread-summary'] === 'thread-kmp');
  assert.equal(anchor.props['data-msg-id'], 'merged-message');
});

test('long names retain a full tooltip; empty summaries and missing navigation callbacks are safe', () => {
  const title = '顺序表：存储、随机访问与插入删除代价'.repeat(8);
  const message = fixture(title);
  message.threadSummary.summary = '';
  message.threadSummary.takeaways = [];
  message.threadSummary.memoryIds = [];
  const entry = find(render(message), (node) => node.props.className === 'resolvedThread');
  assert.equal(entry.props.title, title);
  assert.doesNotThrow(() => entry.props.onClick());
  const css = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/MessageList.module.css'), 'utf8');
  assert.match(css, /\.resolvedThread\s*\{[^}]*max-width: 100%/);
  assert.match(css, /\.resolvedThreadTitle\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/);
  assert.match(css, /\.resolvedThread:focus-visible/);
});

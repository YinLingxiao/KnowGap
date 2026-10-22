const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function loadComponent(name) {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/onboarding', name + '.tsx'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (id.endsWith('.css')) return new Proxy({}, { get: (_, key) => key });
    if (id === 'next/image') return { __esModule: true, default: (props) => React.createElement('img', props) };
    if (id === '@/lib/chat/api') return { chatApi: {} };
    if (id === '@/lib/cx') return { cx: (...values) => values.filter(Boolean).join(' ') };
    if (id === './coach') return {};
    return require(id);
  };
  new Function('require', 'module', 'exports', js)(localRequire, module, module.exports);
  return module.exports;
}

const { ModelGate, Welcome } = loadComponent('Welcome');
const { GettingStarted } = loadComponent('GettingStarted');
const noop = () => {};
const gateProps = { busy: false, error: '', configured: false, onConfigure: noop, onRetry: noop, onLogout: noop };

test('unconfigured model gate has one primary setup action and no bypass', () => {
  const html = renderToStaticMarkup(React.createElement(ModelGate, gateProps));
  assert.match(html, /先连上 AI 模型/);
  assert.match(html, /去填写/);
  assert.match(html, /退出登录/);
  assert.doesNotMatch(html, /跳过|演示空间|开始学/);
  assert.equal((html.match(/<button/g) || []).length, 2);
});

test('status failure is readable and retryable, not an endless spinner', () => {
  const html = renderToStaticMarkup(React.createElement(ModelGate, {
    ...gateProps, configured: null, error: '无法确认模型连接，请检查后端是否启动，然后重试。',
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, />重试<\/button>/);
  assert.doesNotMatch(html, /正在确认|去填写|跳过/);
});

test('verified first-time user retains the original learning-topic flow', () => {
  const html = renderToStaticMarkup(React.createElement(Welcome, {
    busy: false, error: '', onAnswer: noop, onDemo: noop, onSkip: noop,
  }));
  assert.match(html, /你最近在学什么？/);
  assert.doesNotMatch(html, /先连上 AI 模型/);
});

test('checklist has six tasks with space creation first and existing space checked', () => {
  const render = (hasSpace) => renderToStaticMarkup(React.createElement(GettingStarted, {
    userId: 'test', hasSpace, onCreateSpace: noop, onExplain: noop, onQuiz: noop,
    onSchedule: noop, onFocus: noop, onSheet: noop,
  }));
  const empty = render(false);
  assert.equal((empty.match(/<li>/g) || []).length, 6);
  assert.ok(empty.indexOf('建一个学习空间') < empty.indexOf('讲懂一个概念'));
  assert.match(empty, /打开考前一页纸/);
  assert.doesNotMatch(empty, /disabled/);
  const existing = render(true);
  assert.equal((existing.match(/disabled/g) || []).length, 1);
  assert.match(existing, /lucide-check/);
});

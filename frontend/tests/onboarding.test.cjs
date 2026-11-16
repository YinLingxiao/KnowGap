const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { resolveI18n } = require('./i18n-support.cjs');

function loadComponent(name) {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/onboarding', name + '.tsx'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (resolveI18n(id)) return resolveI18n(id);
    if (id.endsWith('.css')) return new Proxy({}, { get: (_, key) => key });
    if (id === 'next/image') return { __esModule: true, default: (props) => React.createElement('img', props) };
    if (id === '@/components/Brand') return { BrandMark: () => React.createElement('svg', { 'aria-hidden': true }), BrandWordmark: () => React.createElement('span', { role: 'img', 'aria-label': 'KnowGap' }), BrandLockup: () => React.createElement('span', { role: 'img', 'aria-label': 'KnowGap' }) };
    if (id === '@/lib/chat/api') return { chatApi: {} };
    if (id === '@/lib/chat/attachments') return { DOCUMENT_EXTENSIONS: ['.pdf', '.docx'], MAX_UPLOAD_BYTES: 20 * 1024 * 1024 };
    if (id === '@/lib/cx') return { cx: (...values) => values.filter(Boolean).join(' ') };
    if (id === './coach') return {};
    return require(id);
  };
  new Function('require', 'module', 'exports', js)(localRequire, module, module.exports);
  return module.exports;
}

const { ModelGuide, StartupStatus, Welcome, topicFromFileName } = loadComponent('Welcome');
const { GettingStarted } = loadComponent('GettingStarted');
const noop = () => {};

test('startup shows progress without asking for a model', () => {
  const html = renderToStaticMarkup(React.createElement(StartupStatus, { error: '', onRetry: noop, onLogout: noop }));
  assert.match(html, /role="status"/);
  assert.match(html, /正在读取学习进度/);
  assert.doesNotMatch(html, /<button|模型/);
});

test('startup failure is readable and retryable, not an endless spinner', () => {
  const html = renderToStaticMarkup(React.createElement(StartupStatus, {
    error: '无法读取学习进度，请检查后端是否启动，然后重试。', onRetry: noop, onLogout: noop,
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, />重试<\/button>/);
  assert.match(html, />退出登录<\/button>/);
  assert.doesNotMatch(html, /正在读取/);
});

test('first-time user goes straight to the topic question, with demo, skip and an optional file', () => {
  const html = renderToStaticMarkup(React.createElement(Welcome, {
    busy: false, error: '', onAnswer: noop, onDemo: noop, onSkip: noop,
  }));
  assert.match(html, /你最近在学什么？/);
  assert.match(html, /先逛逛演示空间/);
  assert.match(html, /跳过，直接开始/);
  assert.match(html, /附一份课件或讲义（可选）/);
  assert.match(html, /type="file"[^>]*accept="\.pdf,\.docx"|accept="\.pdf,\.docx"[^>]*type="file"/);
  assert.doesNotMatch(html, /连上 AI 模型/);
});

test('a file name becomes an editable topic', () => {
  assert.equal(topicFromFileName('第3章_栈和队列.pdf'), '第3章 栈和队列');
  assert.equal(topicFromFileName('lecture-03--final.pptx'), 'lecture 03 final');
  assert.equal(topicFromFileName('a'.repeat(300) + '.txt').length, 200);
});

test('a failed model call explains itself and leads to connecting a model', () => {
  const detail = '模型未配置，请在「设置 → 模型接入」填写 API 地址、模型名称和 API Key。';
  const html = renderToStaticMarkup(React.createElement(ModelGuide, {
    detail, onConnect: noop, onRetry: noop, onDismiss: noop,
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /还差一步：连上 AI 模型/);
  assert.ok(html.includes(detail));
  assert.match(html, />去连接模型<\/button>/);
  assert.match(html, />重试<\/button>/);
  assert.ok(html.indexOf('去连接模型') < html.indexOf('>重试<'));
});

test('checklist has five tasks with space creation first and existing space checked', () => {
  const render = (hasSpace) => renderToStaticMarkup(React.createElement(GettingStarted, {
    userId: 'test', hasSpace, onCreateSpace: noop, onExplain: noop, onQuiz: noop,
    onSchedule: noop, onSheet: noop,
  }));
  const empty = render(false);
  assert.equal((empty.match(/<li>/g) || []).length, 5);
  assert.doesNotMatch(empty, /专注/);
  assert.ok(empty.indexOf('建一个学习空间') < empty.indexOf('讲懂一个概念'));
  assert.match(empty, /打开考前一页纸/);
  assert.doesNotMatch(empty, /disabled/);
  const existing = render(true);
  assert.equal((existing.match(/disabled/g) || []).length, 1);
  assert.match(existing, /lucide-check/);
});

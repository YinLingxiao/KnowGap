const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToString } = require('react-dom/server');

function load(file, imports) {
  const box = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('module', 'exports', 'require', code)(box, box.exports, (name) => imports[name] ?? require(name));
  return box.exports;
}

const json = load('../src/lib/chat/widgetJson.ts', {});
const math = load('../src/components/chat/math.tsx', {
  '@/lib/chat/mathDelimiters': load('../src/lib/chat/mathDelimiters.ts', {}),
  './Markdown.module.css': { default: {} },
});
const translate = (phrase, values = {}) => phrase.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? key));
const widgets = load('../src/components/chat/LearningWidget.tsx', {
  'next/dynamic': { default: () => () => null },
  '@/lib/cx': { cx: (...values) => values.filter(Boolean).join(' ') },
  '@/lib/chat/quizAttempts': { cachedQuizAttempt: () => null, subscribeQuizAttempts: () => () => {} },
  '@/lib/chat/plan': {},
  '@/lib/chat/widgetJson': json,
  '@/components/LanguageProvider': { useI18n: () => ({ tx: translate, lang: 'zh' }) },
  './LearningWidget.module.css': { default: {} },
  './math': math,
  './widgets/CircuitNetlistWidget': {}, './widgets/GapCard': {}, './widgets/ImageAnnotatorWidget': {},
  './widgets/memoryContext': {},
  './widgets/widgetEvents': { useWidgetScope: () => ({}) },
  './widgets/ProblemSourceBadge': {},
  './widgets/WidgetSkeleton': { WidgetSkeleton: () => React.createElement('div', null, '生成中') },
});

function render(rawCode, live = true) {
  return renderToString(React.createElement(widgets.WidgetLiveContext.Provider, { value: live },
    React.createElement(widgets.LearningWidget, { rawCode })));
}

test('comparison card renders every streamed JSON prefix without crashing', () => {
  const card = JSON.stringify({ type: 'comparison_matrix', title: '栈与队列', columns: ['栈', '队列'],
    rows: [{ dimension: '取出顺序', values: ['后进先出', '先进先出'], takeaway: '看从哪一头取' }] });
  for (let length = 1; length <= card.length; length++) {
    assert.doesNotThrow(() => render(card.slice(0, length)), `stream prefix ${length}: ${card.slice(0, length)}`);
  }
  assert.match(render(card, false), /后进先出/);
});

test('step simulator renders every streamed JSON prefix without crashing', () => {
  const card = JSON.stringify({ type: 'step_simulator', title: '放入 A',
    steps: [{ label: '第一步', detail: 'A 到栈顶', state: [{ key: '栈', value: 'A', highlight: true }] }] });
  for (let length = 1; length <= card.length; length++) {
    assert.doesNotThrow(() => render(card.slice(0, length)), `stream prefix ${length}`);
  }
});

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
// 样式表按类名原样返回：断言里就能看出某个状态类有没有被挂上（高亮、压暗、动效）
const classNames = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) });
function loadWidgets(extra = {}) {
  return load('../src/components/chat/LearningWidget.tsx', {
    'next/dynamic': { default: () => () => null },
    '@/lib/cx': { cx: (...values) => values.filter(Boolean).join(' ') },
    '@/lib/chat/quizAttempts': { cachedQuizAttempt: () => null, subscribeQuizAttempts: () => () => {} },
    '@/lib/chat/plan': {},
    '@/lib/chat/widgetJson': json,
    '@/components/LanguageProvider': { useI18n: () => ({ tx: translate, lang: 'zh' }) },
    './LearningWidget.module.css': { default: classNames },
    './math': math,
    './widgets/CircuitNetlistWidget': {}, './widgets/GapCard': {}, './widgets/ImageAnnotatorWidget': {},
    './widgets/memoryContext': {},
    './widgets/widgetEvents': { useWidgetScope: () => ({}) },
    './widgets/ProblemSourceBadge': {},
    './widgets/WidgetSkeleton': { WidgetSkeleton: () => React.createElement('div', null, '生成中') },
    ...extra,
  });
}
const widgets = loadWidgets();

function renderWith(module, rawCode, live) {
  return renderToString(React.createElement(module.WidgetLiveContext.Provider, { value: live },
    React.createElement(module.LearningWidget, { rawCode })));
}

function render(rawCode, live = true) {
  return renderWith(widgets, rawCode, live);
}

// renderToString 对 useSyncExternalStore 只取服务端快照，读不到「挂载后」的环境。
// 这个版本让它直接读客户端快照，并在渲染期间临时补上 window/document，
// 用来检查自动播放键在不同的动效偏好下显不显示、历史作答恢复后动不动。
const clientLike = (attempts) => loadWidgets({
  react: { ...React, useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() },
  '@/lib/chat/quizAttempts': { cachedQuizAttempt: () => attempts, subscribeQuizAttempts: () => () => {} },
});

function withEnvironment({ reducedQuery = false, motion } = {}, run) {
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { matchMedia: () => ({ matches: reducedQuery }) };
  globalThis.document = { documentElement: { dataset: motion ? { motion } : {} } };
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

test('comparison card renders every streamed JSON prefix without crashing', () => {
  const card = JSON.stringify({ type: 'comparison_matrix', title: '栈与队列', columns: ['栈', '队列'],
    rows: [{ dimension: '取出顺序', values: ['后进先出', '先进先出'], takeaway: '看从哪一头取' }] });
  for (let length = 1; length <= card.length; length++) {
    assert.doesNotThrow(() => render(card.slice(0, length)), `stream prefix ${length}: ${card.slice(0, length)}`);
  }
  assert.match(render(card, false), /后进先出/);
});

test('code playground shows its task and code while the JSON is still streaming', () => {
  const card = JSON.stringify({ type: 'code_playground', title: '补全：求平方', language: 'python', mode: 'scaffold',
    instructions: '读入一个整数，输出它的平方。', starter_code: 'n = int(input())\n# TODO\nprint(result)',
    test_cases: [{ name: '用例1', input: '3', expected: '9' }] });
  for (let length = 1; length <= card.length; length++) {
    assert.doesNotThrow(() => render(card.slice(0, length)), `stream prefix ${length}`);
  }
  const partial = render(card.slice(0, card.indexOf('# TODO') + 6));
  assert.match(partial, /补全：求平方/);
  assert.match(partial, /读入一个整数/);
  assert.match(partial, /n = int\(input\(\)\)/);
});

test('cards show the richer optional fields and mark what changed between steps', () => {
  const steps = render(JSON.stringify({ type: 'step_simulator', title: '入栈', subtitle: '看 top 怎么动',
    steps: [{ label: '空栈', detail: '还没有元素', state: [{ key: 'top', value: '-1' }] },
      { label: '压入 A', detail: 'top 加 1', state: [{ key: 'top', value: '0' }] }] }), false);
  assert.match(steps, /看 top 怎么动/);
  assert.match(steps, /分步推演/);
  const compare = render(JSON.stringify({ type: 'comparison_matrix', title: '栈与队列', columns: ['栈', '队列'],
    rows: [{ dimension: '取出顺序', values: ['后进先出', '先进先出'] }], summary: '回退用栈，排队用队列' }), false);
  assert.match(compare, /结论/);
  assert.match(compare, /回退用栈，排队用队列/);
  const quiz = render(JSON.stringify({ type: 'micro_quiz', topic: '栈', difficulty: '基础', question: '栈顶是谁？',
    options: ['A', 'B'], answerIndex: 1, hint: '想想谁最后进去', explanation: '最后进去的在栈顶' }), false);
  assert.match(quiz, /看提示/);
  assert.match(quiz, /基础/);
  assert.doesNotMatch(quiz, /想想谁最后进去/, 'the hint stays folded until asked for');
  assert.doesNotMatch(quiz, /最后进去的在栈顶/, 'the explanation is not shown before answering');
});

test('step simulator renders every streamed JSON prefix without crashing', () => {
  const card = JSON.stringify({ type: 'step_simulator', title: '放入 A',
    steps: [{ label: '第一步', detail: 'A 到栈顶', state: [{ key: '栈', value: 'A', highlight: true }] }] });
  for (let length = 1; length <= card.length; length++) {
    assert.doesNotThrow(() => render(card.slice(0, length)), `stream prefix ${length}`);
  }
});

const stepCard = { type: 'step_simulator', title: '入栈', subtitle: '看 top 怎么动', steps: [
  { label: '空栈', detail: '还没有元素', state: [{ key: 'top', value: '-1' }] },
  { label: '压入 A', detail: 'top 加 1', state: [{ key: 'top', value: '0' }] },
  { label: '压入 B', detail: 'top 再加 1', state: [{ key: 'top', value: '1', highlight: true }] }] };

test('multi-step simulator renders every streamed JSON prefix and starts on the first step', () => {
  const card = JSON.stringify(stepCard);
  for (let length = 1; length <= card.length; length++) {
    assert.doesNotThrow(() => render(card.slice(0, length)), `stream prefix ${length}`);
  }
  const html = render(card, false);
  assert.match(html, /步骤 1 \/ 3/);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, 'exactly one rail segment is current');
  // 服务端渲染读不到动效偏好，首帧一律不出现自动播放键（挂载后才决定）
  assert.doesNotMatch(html, /自动播放|暂停|重新播放/);
});

test('autoplay control follows the motion preference and is absent from live previews and one-step cards', () => {
  const client = clientLike(null);
  const card = JSON.stringify(stepCard);
  const show = (environment, raw = card, live = false) => withEnvironment(environment, () => renderWith(client, raw, live));

  const calm = show({});
  assert.match(calm, /自动播放/);
  assert.doesNotMatch(calm, /暂停|重新播放/, 'it starts paused, on the first step');
  assert.match(show({}, card, true), /自动播放/, 'a finished card inside a message that is still streaming is not a preview');

  assert.doesNotMatch(show({ reducedQuery: true }), /自动播放/, 'OS-level reduced motion hides the control');
  assert.doesNotMatch(show({ motion: 'reduced' }), /自动播放/, 'the app-level motion switch hides the control');

  const preview = show({}, card.slice(0, card.lastIndexOf(']')), true);
  assert.match(preview, /inert=""/, 'this really is the inert streaming preview');
  assert.match(preview, /压入 B/);
  assert.doesNotMatch(preview, /自动播放/);

  const single = JSON.stringify({ ...stepCard, steps: stepCard.steps.slice(0, 1) });
  assert.doesNotMatch(show({}, single), /自动播放/, 'nothing to play with a single step');
});

test('comparison columns render as unpressed toggles and keep plain header text for screen readers', () => {
  const card = JSON.stringify({ type: 'comparison_matrix', title: '栈与队列', columns: ['栈', '`队列`'],
    rows: [{ dimension: '取出顺序', values: ['后进先出', '先进先出'] }, { dimension: '典型用途', values: ['回退', '排队'] }] });
  for (let length = 1; length <= card.length; length++) {
    assert.doesNotThrow(() => render(card.slice(0, length)), `stream prefix ${length}`);
  }
  const html = render(card, false);
  const columnButtons = [...html.matchAll(/<th[^>]*><button([^>]*)>/g)];
  assert.equal(columnButtons.length, 2, 'one toggle per value column');
  for (const [, attributes] of columnButtons) assert.match(attributes, /aria-pressed="false"/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1, 'only the "all dimensions" pill is on');
  assert.doesNotMatch(html, /\bcolOn\b|\bcolDim\b|\bcolHeadOn\b/, 'nothing is highlighted or dimmed by default');
  // 窄堆叠时按钮会被 CSS 整个去掉，这份纯文本列名才是读屏读到的表头
  assert.match(html, /<span class="colName">栈<\/span>/);
  assert.match(html, /<span class="colName">队列<\/span>/);
  assert.match(html, /data-label="栈"/);
});

test('quiz shows no feedback and no reveal motion before an answer', () => {
  const quiz = { type: 'micro_quiz', question: '栈顶是谁？', options: ['甲', '乙', '丙'], answerIndex: 1,
    explanation: '最后进去的在栈顶' };
  const card = JSON.stringify(quiz);
  for (let length = 1; length <= card.length; length++) {
    assert.doesNotThrow(() => render(card.slice(0, length)), `stream prefix ${length}`);
  }
  const untouched = /quizFeedback|iconRight|iconWrong|iconPop|quizOptionShake|quizOptionRight|quizOptionWrong/;
  const html = render(card, false);
  assert.match(html, /请选择一个答案/);
  assert.doesNotMatch(html, untouched);
  assert.doesNotMatch(html, /最后进去的在栈顶/);
  const sealed = render(JSON.stringify({ type: 'micro_quiz', quizId: 'q1', question: '栈顶是谁？', options: ['甲', '乙', '丙'] }), false);
  assert.match(sealed, /请选择一个答案/);
  assert.doesNotMatch(sealed, untouched);
});

test('a quiz answer restored from history is shown statically, without the reveal motion', () => {
  const sealed = JSON.stringify({ type: 'micro_quiz', quizId: 'q1', question: '栈顶是谁？', options: ['甲', '乙', '丙'] });
  const motion = /iconPop|quizOptionShake/;
  const wrong = renderWith(clientLike({ optionIndex: 0, answerIndex: 1, explanation: '最后进去的在栈顶', memoryChanges: [], planStep: null }), sealed, false);
  assert.match(wrong, /quizOptionWrong/);
  assert.match(wrong, /这道题选 B/);
  assert.match(wrong, /最后进去的在栈顶/);
  assert.doesNotMatch(wrong, motion);
  const right = renderWith(clientLike({ optionIndex: 1, answerIndex: 1, explanation: '最后进去的在栈顶', memoryChanges: [], planStep: null }), sealed, false);
  assert.match(right, /回答正确！/);
  assert.match(right, /iconRight/);
  assert.doesNotMatch(right, motion);
});

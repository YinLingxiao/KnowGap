const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
function load(file, resolve = require) {
  const module = { exports: {} };
  const code = ts.transpileModule(source(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('module', 'exports', 'require', code)(module, module.exports, resolve);
  return module.exports;
}
const { FOCUS_PRESETS } = load('lib/focus/types.ts');

test('focus offers only 15 / 25 / 45 minute presets in three equal columns', () => {
  assert.deepEqual(FOCUS_PRESETS.map(preset => preset.seconds), [900, 1500, 2700]);
  assert.deepEqual(FOCUS_PRESETS.map(preset => preset.label), ['15', '25', '45']);
  assert.match(source('components/focus/FocusCapsule.module.css'), /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test('removed persisted presets reset only while idle, preserving active sessions', () => {
  for (const [phase, presetSeconds, expected] of [
    ['idle', 10, [1500]], ['idle', 900, []], ['idle', 1500, []], ['idle', 2700, []],
    ['running', 10, []], ['paused', 10, []], ['wrapup', 10, []],
  ]) {
    const effects = [];
    const selected = [];
    const state = { phase, presetSeconds, plannedSeconds: presetSeconds, wrapupUntil: null };
    const { FocusCapsule } = load('components/focus/FocusCapsule.tsx', id => {
      if (id === 'react') return {
        useEffect: fn => effects.push(fn), useRef: () => ({ current: null }),
        useState: () => [false, () => {}], useSyncExternalStore: () => state,
      };
      if (id === '@/lib/focus/types') return { FOCUS_PRESETS };
      if (id === '@/lib/focus/store') return {
        hydrateFocus() {}, remainingMs: () => 0, selectPreset: seconds => selected.push(seconds),
      };
      if (id === '@/lib/cx') return { cx: (...values) => values.filter(Boolean).join(' ') };
      if (id.endsWith('.css')) return { default: {} };
      if (id === '@/lib/agenda/types') return {};
      return require(id);
    });
    FocusCapsule({ zen: false, onZenChange() {}, contextSubjectId: null });
    // Hydration and preset migration are independent of browser event subscriptions.
    effects[0]();
    effects[1]();
    assert.deepEqual(selected, expected, `${phase} / ${presetSeconds}`);
  }
});

test('the shared agenda header opens the existing composer with the current space', () => {
  const page = source('components/agenda/AgendaPage.tsx');
  const header = page.slice(page.indexOf('<header'), page.indexOf('</header>'));
  assert.match(header, /className=\{styles.addTask\}/);
  assert.match(header, /aria-keyshortcuts="Q"/);
  assert.match(header, /dispatchCompose\(\{ subjectId: spaceId \}\)/);
  assert.match(header, /<Plus[^>]*aria-hidden[^>]*\/>添加任务/);
  assert.match(header, /快捷键 <\/span><kbd>Q<\/kbd>/);
  assert.match(page, /<QuickAdd/);
});

test('composer transitions retain the native close lifecycle and reduced motion paths', () => {
  const css = source('components/agenda/TaskComposer.module.css');
  assert.match(css, /@starting-style/);
  assert.match(css, /transform: translateY\(8px\) scale\(\.98\)/);
  assert.match(css, /opacity 180ms var\(--ease-out\)/);
  assert.match(css, /display 180ms allow-discrete/);
  assert.match(css, /overlay 180ms allow-discrete/);
  assert.match(css, /\.dialog\[open\]::backdrop \{ opacity: 1; \}/);
  assert.match(css, /:root\[data-motion="reduced"\] \.dialog::backdrop \{ transition: none; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.dialog, \.dialog::backdrop \{ transition: none; \}/);
  assert.match(source('components/agenda/TaskComposer.tsx'), /dialog\.current\?\.close\(\)/);
});

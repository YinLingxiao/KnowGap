const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/components/ThemeToggle.tsx'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fixture({ desktop = true, theme = 'light', reduced = false, supported = true, startFails = false, animateFails = false } = {}) {
  const native = [];
  const transitions = [];
  const animations = [];
  const classes = new Set();
  const props = new Map();
  const stored = new Map();
  const timers = new Map();
  let timerId = 0;
  const root = {
    dataset: { theme },
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    style: { setProperty: (key, value) => props.set(key, value), removeProperty: key => props.delete(key) },
    animate: (keyframes, options) => {
      if (animateFails) throw new Error('animation unavailable');
      const animation = { keyframes, options, canceled: false, cancel() { this.canceled = true; } };
      animations.push(animation);
      return animation;
    },
  };
  const document = {
    documentElement: root,
    querySelectorAll: () => [],
    ...(supported ? { startViewTransition(callback) {
      if (startFails) throw new Error('snapshot unavailable');
      let ready;
      let finished;
      const transition = {
        ready: new Promise(resolve => { ready = resolve; }),
        finished: new Promise(resolve => { finished = resolve; }),
        skipTransition() { this.skipped = true; },
        commit() { callback(); ready(); },
        finish() { finished(); },
      };
      transitions.push(transition);
      return transition;
    } } : {}),
  };
  const window = {
    innerWidth: 1280, innerHeight: 820,
    knowgap: desktop ? { windowChrome: { platform: 'win32' }, setTheme: choice => { native.push(choice); return Promise.resolve(choice); } } : undefined,
    matchMedia: query => ({ matches: query.includes('reduced-motion') ? reduced : false }),
    dispatchEvent() {},
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  const localStorage = { setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const module = { exports: {} };
  const CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
  new Function('module', 'exports', 'require', 'window', 'document', 'localStorage', 'CustomEvent', `${compiled}\nmodule.exports.applyChoice = applyChoice;`)(
    module, module.exports, () => ({}), window, document, localStorage, CustomEvent,
  );
  return { apply: module.exports.applyChoice, root, native, transitions, animations, props, classes, timers, stored };
}

test('desktop theme switching uses a short fade, without a circular mask or delayed native buttons', async () => {
  for (const [from, to] of [['light', 'dark'], ['dark', 'light']]) {
    const f = fixture({ theme: from });
    f.apply(to, { x: 220, y: 797 });
    assert.equal(f.root.dataset.vtDir, 'fade');
    assert.equal(f.props.has('--vt-clip-from'), false);
    f.transitions[0].commit();
    assert.equal(f.root.dataset.theme, to);
    assert.deepEqual(f.native, [to], 'native buttons switch with the DOM, not after the animation');
    await flush();
    assert.deepEqual(f.animations[0].keyframes, { opacity: [0, 1] });
    assert.equal(f.animations[0].options.duration, 160);
    assert.equal(f.animations[0].options.pseudoElement, '::view-transition-new(root)');
    f.transitions[0].finish();
    await flush();
    assert.equal(f.root.dataset.vtDir, undefined);
    assert.equal(f.animations[0].canceled, true);
    assert.deepEqual(f.native, [to], 'finishing does not send an older theme again');
  }
});

test('browser theme switching retains its existing circular reveal and contraction', async () => {
  for (const [from, to, direction] of [['light', 'dark', 'contract'], ['dark', 'light', 'expand']]) {
    const f = fixture({ desktop: false, theme: from });
    f.apply(to);
    assert.equal(f.root.dataset.vtDir, direction);
    assert.ok(f.props.has('--vt-clip-from'));
    f.transitions[0].commit();
    await flush();
    assert.ok(f.animations[0].keyframes.clipPath);
    assert.equal(f.animations[0].options.duration, 400);
    f.transitions[0].finish();
    await flush();
    assert.equal(f.props.size, 0);
  }
});

test('rapid choices cancel previous snapshots and old completions cannot clear a newer transition', async () => {
  const f = fixture();
  f.apply('dark');
  f.transitions[0].commit();
  await flush();
  f.apply('light');
  assert.equal(f.transitions[0].skipped, true);
  assert.equal(f.animations[0].canceled, true);
  f.transitions[1].commit();
  await flush();
  f.transitions[0].finish();
  await flush();
  assert.equal(f.root.dataset.vtDir, 'fade');
  assert.equal(f.root.dataset.theme, 'light');
  assert.deepEqual(f.native, ['dark', 'light']);
  f.transitions[1].finish();
  await flush();
  assert.equal(f.root.dataset.vtDir, undefined);
  assert.deepEqual(f.native, ['dark', 'light']);
});

test('a skipped snapshot callback cannot overwrite a newer instant choice', async () => {
  const f = fixture();
  f.apply('dark');
  f.apply('light');
  f.transitions[0].commit();
  f.transitions[0].finish();
  await flush();
  assert.equal(f.root.dataset.theme, 'light');
  assert.deepEqual(f.native, ['light']);
  assert.equal(f.root.dataset.vtDir, undefined);
});

test('reduced motion, missing View Transitions and snapshot failures switch immediately and cleanly', () => {
  for (const config of [{ reduced: true }, { supported: false }, { startFails: true }, { theme: 'dark' }]) {
    const f = fixture(config);
    f.apply('dark');
    assert.equal(f.root.dataset.theme, 'dark');
    assert.deepEqual(f.native, ['dark']);
    assert.equal(f.root.dataset.vtDir, undefined);
    assert.equal(f.animations.length, 0);
    assert.equal(f.classes.has('theme-switching'), true);
    for (const callback of f.timers.values()) callback();
    assert.equal(f.classes.has('theme-switching'), false);
  }
});

test('an unavailable pseudo-element animation skips the snapshot instead of leaving an overlay', async () => {
  const f = fixture({ animateFails: true });
  f.apply('dark');
  f.transitions[0].commit();
  await flush();
  assert.equal(f.transitions[0].skipped, true);
  f.transitions[0].finish();
  await flush();
  assert.equal(f.root.dataset.vtDir, undefined);
  assert.deepEqual(f.native, ['dark']);
});

test('the desktop fade CSS never inherits the browser circular clipping rule', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/app/globals.css'), 'utf8');
  assert.match(css, /html\[data-vt-dir="fade"\]::view-transition-new\(root\)\s*\{\s*opacity: 0;/);
  const shared = css.match(/html\[data-vt-dir\]::view-transition-new\(root\)\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(shared, /clip-path|opacity/);
  assert.match(css, /html\[data-vt-dir="expand"\]::view-transition-new\(root\),\s*html\[data-vt-dir="contract"\]::view-transition-new\(root\)\s*\{[^}]*clip-path:/);
});

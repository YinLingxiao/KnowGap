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

test('desktop theme switching uses circular masks and syncs native buttons at the reveal timing', async () => {
  for (const [from, to, direction] of [['light', 'dark', 'contract'], ['dark', 'light', 'expand']]) {
    const f = fixture({ theme: from });
    f.apply(to, { x: 220, y: 797 });
    assert.equal(f.root.dataset.vtDir, direction);
    assert.ok(f.props.has('--vt-clip-from'));
    assert.deepEqual(f.native, [], 'native buttons wait for the snapshot callback');
    f.transitions[0].commit();
    assert.equal(f.root.dataset.theme, to);
    assert.deepEqual(f.native, [], 'DOM commit alone does not sync native buttons');
    await flush();
    assert.ok(f.animations[0].keyframes.clipPath);
    assert.match(
      f.animations[0].keyframes.clipPath[0],
      direction === 'contract' ? /^path\(evenodd,/ : /^circle\(0px/,
    );
    assert.equal(f.animations[0].options.duration, 400);
    assert.equal(f.animations[0].options.pseudoElement, '::view-transition-new(root)');
    assert.deepEqual(
      f.native,
      direction === 'contract' ? [to] : [],
      direction === 'contract'
        ? 'contract syncs native buttons when the animation starts'
        : 'expand keeps native buttons unchanged until the reveal finishes',
    );
    f.transitions[0].finish();
    await flush();
    assert.equal(f.root.dataset.vtDir, undefined);
    assert.equal(f.animations[0].canceled, true);
    assert.deepEqual(f.native, [to], 'finishing syncs expand once without repeating contract');
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
  assert.equal(f.root.dataset.vtDir, 'expand');
  assert.equal(f.root.dataset.theme, 'light');
  assert.deepEqual(f.native, ['dark'], 'an old completion cannot sync a pending expand');
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

test('the transition CSS removes fade and shares circular clipping for expand and contract', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/app/globals.css'), 'utf8');
  assert.doesNotMatch(css, /html\[data-vt-dir="fade"\]/);
  const shared = css.match(/html\[data-vt-dir\]::view-transition-new\(root\)\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(shared, /clip-path|opacity/);
  assert.match(css, /html\[data-vt-dir="expand"\]::view-transition-new\(root\),\s*html\[data-vt-dir="contract"\]::view-transition-new\(root\)\s*\{[^}]*clip-path:/);
});
test('the sidebar keeps one theme toggle with account menu and overflow structure intact', () => {
  const sidebar = fs.readFileSync(path.join(__dirname, '../src/components/chat/ConversationSidebar.tsx'), 'utf8');
  const sidebarCss = fs.readFileSync(path.join(__dirname, '../src/components/chat/ConversationSidebar.module.css'), 'utf8');
  const toggleCss = fs.readFileSync(path.join(__dirname, '../src/components/ThemeToggle.module.css'), 'utf8');

  assert.match(sidebar, /import\s*\{\s*ThemeToggle\s*\}\s*from\s*["']\.\.\/ThemeToggle["'];/);
  assert.equal((sidebar.match(/<ThemeToggle\s*\/>/g) ?? []).length, 1);
  // Windows checkouts use CRLF, so match any whitespace after the tag name.
  const avatarIndex = sidebar.search(/<AvatarMenu\s/);
  const themeToggleIndex = sidebar.indexOf('<ThemeToggle />');
  const updateIndex = sidebar.indexOf('<UpdateIndicator ');
  assert.ok(avatarIndex >= 0, 'AvatarMenu remains in the sidebar footer');
  assert.ok(themeToggleIndex > avatarIndex, 'ThemeToggle renders after AvatarMenu');
  assert.ok(updateIndex > themeToggleIndex, 'UpdateIndicator renders after ThemeToggle');

  const avatarMenuStart = sidebar.indexOf('function AvatarMenu(');
  const avatarMenuEnd = sidebar.indexOf('export function ConversationSidebar(', avatarMenuStart);
  assert.ok(avatarMenuStart >= 0 && avatarMenuEnd > avatarMenuStart, 'AvatarMenu source can be isolated');
  const avatarMenu = sidebar.slice(avatarMenuStart, avatarMenuEnd);
  assert.doesNotMatch(avatarMenu, /\b(?:toggleTheme|themeChoice|systemDark|ThemeIcon|nextTheme|THEME_ICON|THEME_KEY|useThemeChoice)\b|sidebar\.theme/);
  assert.equal(
    (avatarMenu.match(/<button\b[^>]*role="menuitem"/g) ?? []).length,
    3,
    'AvatarMenu has exactly its own three menuitems, excluding ConversationItem',
  );
  for (const label of ['account', 'help', 'settings']) {
    assert.match(avatarMenu, new RegExp(`t\\("sidebar\\.${label}"\\)`));
  }

  assert.match(source, /data-theme-toggle-btn="true"/);
  assert.doesNotMatch(sidebar, /\b(?:toggleTheme|themeChoice|setThemeChoice|nextTheme|effectiveDark|systemDark|useThemeChoice|THEME_ICON|THEME_KEY)\b/);

  const profileTrigger = sidebarCss.match(/\.profileTrigger\s*\{([^}]+)\}/);
  assert.ok(profileTrigger, 'profileTrigger styles remain present');
  assert.match(profileTrigger[1], /min-width:\s*0;/);
  const userName = sidebarCss.match(/\.userName\s*\{([^}]+)\}/);
  assert.ok(userName, 'userName styles remain present');
  assert.match(userName[1], /overflow:\s*hidden;/);
  assert.match(userName[1], /text-overflow:\s*ellipsis;/);
  assert.match(userName[1], /white-space:\s*nowrap;/);
  const toggle = toggleCss.match(/\.toggle\s*\{([^}]+)\}/);
  assert.ok(toggle, 'theme toggle styles remain present');
  assert.match(toggle[1], /width:\s*28px;/);
  assert.match(toggle[1], /height:\s*28px;/);
});

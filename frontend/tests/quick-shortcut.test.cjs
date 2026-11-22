const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { resolveI18n } = require('./i18n-support.cjs');

function load(file, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (id in overrides) return overrides[id];
    if (resolveI18n(id)) return resolveI18n(id);
    if (id.endsWith('.css')) return new Proxy({}, { get: (_, key) => key });
    if (id === './coach') return load('components/onboarding/coach.ts');
    return require(id);
  };
  new Function('require', 'module', 'exports', js)(localRequire, module, module.exports);
  return module.exports;
}

const { formatQuickShortcut, readQuickShortcut } = load('hooks/useQuickShortcut.ts');

test('shortcut labels preserve the registered default and format Windows/Mac fallback keys', () => {
  assert.equal(formatQuickShortcut('Alt+Space', 'win32'), 'Alt+Space');
  assert.equal(formatQuickShortcut('CommandOrControl+Shift+K', 'win32'), 'Ctrl+Shift+K');
  assert.equal(formatQuickShortcut('CommandOrControl+Shift+K', 'darwin'), 'Cmd+Shift+K');
  assert.equal(formatQuickShortcut(null, 'win32'), null);
});

test('reading the shell uses its actual result and never invents a key on failure or in browsers', async () => {
  assert.equal(await readQuickShortcut({ shortcut: async () => 'CommandOrControl+Shift+K' }, 'win32'), 'Ctrl+Shift+K');
  assert.equal(await readQuickShortcut({ shortcut: async () => null }, 'win32'), null);
  assert.equal(await readQuickShortcut({ shortcut: async () => { throw new Error('closed'); } }, 'win32'), null);
  assert.equal(await readQuickShortcut(undefined, 'win32'), null);
});

function helpMarkup(shortcut, desktop) {
  const { HelpCenter } = load('components/onboarding/HelpCenter.tsx', {
    '@/hooks/useQuickShortcut': { useQuickShortcut: () => shortcut },
    'react-dom': { createPortal: (children) => children },
  });
  return renderToStaticMarkup(React.createElement(HelpCenter, {
    desktop, userId: 'test', onTry() {}, onClose() {},
  }));
}

test('help instructions and shortcut table use the fallback, omit unavailable keys, and hide desktop shortcuts on web', t => {
  const previous = global.document;
  global.document = { body: {} };
  t.after(() => { global.document = previous; });
  const fallback = helpMarkup('Ctrl+Shift+K', true);
  assert.match(fallback, /按 Ctrl\+Shift\+K/);
  assert.match(fallback, /<kbd>Ctrl\+Shift\+K<\/kbd>/);
  assert.doesNotMatch(fallback, /Alt\+Space/);
  const unavailable = helpMarkup(null, true);
  assert.match(unavailable, /从托盘打开快问/);
  assert.doesNotMatch(unavailable, /Alt\+Space|<kbd>Ctrl\+Shift\+K/);
  assert.doesNotMatch(helpMarkup('Ctrl+Shift+K', false), /Ctrl\+Shift\+K|Alt\+Space|从托盘打开快问/);
});

test('first-run coachmark text and accessible name agree with the registered shortcut', () => {
  for (const shortcut of ['Ctrl+Shift+K', 'Alt+Space', null]) {
    const states = ['spotlight', { top: 100, left: 10 }, false];
    const { CoachmarkHost } = load('components/onboarding/Coachmark.tsx', {
      '@/hooks/useQuickShortcut': { useQuickShortcut: () => shortcut },
      react: { ...React, useState: () => [states.shift(), () => {}] },
    });
    const html = renderToStaticMarkup(React.createElement(CoachmarkHost, { userId: 'test', enabled: true }));
    const expected = shortcut ? `${shortcut} 随时快问` : '从托盘打开快问';
    assert.ok(html.includes(`aria-label="${expected}"`) && html.includes(`<p>${expected}</p>`));
    if (shortcut !== 'Alt+Space') assert.doesNotMatch(html, /Alt\+Space/);
  }
});

test('dynamic shortcut hints translate without losing the actual key', () => {
  const { translatePhrase } = resolveI18n('@/lib/i18n');
  assert.equal(translatePhrase('en', '按 {shortcut}', { shortcut: 'Ctrl+Shift+K' }), 'Press Ctrl+Shift+K');
  assert.equal(translatePhrase('en', '{shortcut} 随时快问', { shortcut: 'Cmd+Shift+K' }), 'Cmd+Shift+K to ask anytime');
  assert.equal(translatePhrase('en', '从托盘打开快问'), 'Open Quick Ask from the tray');
});

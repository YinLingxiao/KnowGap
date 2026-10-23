const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '../src/components', file), 'utf8');
function rule(file, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = read(file).match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `${file}: missing ${selector}`);
  return match[1];
}

test('all learning-space inspector modes inherit the same titlebar-safe overlay', () => {
  const overlay = rule('chat/SubjectPage.module.css', '.overlay');
  assert.match(overlay, /position: fixed/);
  assert.match(overlay, /inset: var\(--desktop-titlebar-height\) 0 0/);
  assert.doesNotMatch(overlay, /(?:^|\n)\s*(?:top:\s*0|height:\s*100(?:d?vh|%))/);
  const source = read('chat/SubjectPage.tsx');
  assert.match(source, /<aside className=\{cx\(styles\.panel, narrow && styles\.overlay\)\}>/);
  for (const mode of ['list', 'thread', 'tasks', 'graph', 'pages', 'info']) {
    assert.match(source, new RegExp(`mode: "${mode}"`));
  }
  // Keep close/expand actions fixed while the tab strip yields to narrow widths.
  assert.match(rule('chat/SubjectPage.module.css', '.panelTabs'), /min-width: 0/);
  assert.match(rule('chat/SubjectPage.module.css', '.panelTabs'), /overflow-x: auto/);
  assert.match(rule('chat/SubjectPage.module.css', '.panelActions'), /flex-shrink: 0/);
});

test('docked inspectors stay in normal content flow, without applying the desktop inset twice', () => {
  const panel = rule('chat/SubjectPage.module.css', '.panel');
  assert.doesNotMatch(panel, /position: fixed|--desktop-titlebar-height/);
  assert.match(read('chat/ChatApp.module.css'), /height: calc\(100dvh - var\(--desktop-titlebar-height\)\)/);
  const stage = rule('chat/ConceptGraph.module.css', '.stage');
  const nodeDrawer = rule('chat/ConceptGraph.module.css', '.drawer');
  assert.match(stage, /position: relative/);
  assert.match(nodeDrawer, /position: absolute/);
  assert.match(nodeDrawer, /width: min\(260px, calc\(100% - 16px\)\)/);
  assert.doesNotMatch(nodeDrawer, /--desktop-titlebar-height/);
});

test('agenda task details are bounded by the content body, not the native-window viewport', () => {
  const agenda = read('agenda/AgendaPage.module.css');
  assert.match(agenda, /\.body\s*\{\s*position: relative;/);
  const inspector = rule('agenda/AgendaPage.module.css', '.withInspector .inspector');
  assert.match(inspector, /position: absolute/);
  assert.match(inspector, /width: min\(380px, 100%\)/);
  assert.doesNotMatch(inspector, /position: fixed|--desktop-titlebar-height/);
  assert.match(rule('agenda/TaskInspector.module.css', '.body'), /overflow-y: auto/);
});

test('the legacy workbench right panel and backdrop also clear caption controls', () => {
  assert.match(rule('Workbench.module.css', '.panel'), /top: calc\(var\(--desktop-titlebar-height\) \+ 8px\)/);
  assert.match(rule('Workbench.module.css', '.backdrop'), /inset: var\(--desktop-titlebar-height\) 0 0/);
  const source = read('Workbench.module.css');
  assert.equal((source.match(/height: calc\(100vh - var\(--desktop-titlebar-height\)\)/g) || []).length, 2,
    'both desktop and narrow workbench heights account for body titlebar padding');
  assert.match(rule('Workbench.module.css', '.sidebarOpen'), /top: var\(--desktop-titlebar-height\)/);
});

test('the study-sheet preview clears the titlebar, while its print layout remains static', () => {
  const source = read('chat/CheatSheet.module.css');
  assert.match(rule('chat/CheatSheet.module.css', '.backdrop'), /inset: var\(--desktop-titlebar-height\) 0 0/);
  assert.match(source.slice(source.indexOf('@media print')), /\.backdrop\s*\{[^}]*position: static/);
  assert.match(rule('chat/CheatSheet.module.css', '.scroller'), /overflow: auto/);
});

test('ordinary browsers and quick ask still have a zero inset; no per-mode hardcoded offsets', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/app/globals.css'), 'utf8');
  assert.match(css.match(/:root \{([^}]+)\}/)[1], /--desktop-titlebar-height: 0px/);
  assert.match(css.match(/:root\[data-desktop-platform\] \{([^}]+)\}/)[1], /--desktop-titlebar-height: 36px/);
  for (const [file, selector] of [['chat/SubjectPage.module.css', '.overlay'], ['chat/CheatSheet.module.css', '.backdrop'], ['Workbench.module.css', '.panel']]) {
    assert.doesNotMatch(rule(file, selector), /(?:top|inset):\s*36px/);
  }
});

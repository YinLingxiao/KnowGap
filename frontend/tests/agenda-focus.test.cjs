const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');

test('adding a task stays on the rail shortcut and the inline composer', () => {
  const page = source('components/agenda/AgendaPage.tsx');
  const rail = source('components/agenda/AgendaRail.tsx');
  assert.match(rail, /aria-keyshortcuts="Q"/);
  assert.match(page, /dispatchCompose\(\{ subjectId: spaceId \}\)/);
  assert.match(page, /<QuickAdd/);
  assert.match(page, /onCancel=\{\(\) => setComposer\(null\)\}/);
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

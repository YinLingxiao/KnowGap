const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');

test('the shared agenda header opens the existing composer with the current space', () => {
  const page = source('components/agenda/AgendaPage.tsx');
  const header = page.slice(page.indexOf('<header'), page.indexOf('</header>'));
  assert.match(header, /className=\{styles.addTask\}/);
  assert.match(header, /aria-keyshortcuts="Q"/);
  assert.match(header, /dispatchCompose\(\{ subjectId: spaceId \}\)/);
  assert.match(header, /<Plus[^>]*aria-hidden[^>]*\/>添加任务/);
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

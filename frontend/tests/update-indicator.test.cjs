// The ready-to-install update shows as a visible button on the main screen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');

test('the update button appears only for a downloaded update and installs on click', () => {
  const source = read('components/desktop/UpdateIndicator.tsx');
  assert.match(source, /state\.status !== "downloaded"\) return null/);
  assert.match(source, /install\(\{ quick: !busy \}\)/, 'skips the confirm dialog unless a reply is generating');
  assert.doesNotMatch(source, /onOpenSettings/);
});

test('the button sits in the sidebar header and on every page when the sidebar is collapsed', () => {
  const sidebar = read('components/chat/ConversationSidebar.tsx');
  const brand = sidebar.slice(sidebar.indexOf('className={styles.brand}'), sidebar.indexOf('</header>', sidebar.indexOf('className={styles.brand}')));
  // 侧栏 244px 放不下字标 + 文字胶囊，这里用只有图标的圆形按钮，免得盖住 KnowGap 字标
  assert.match(brand, /<UpdateIndicator compact busy=/);
  assert.equal((read('components/chat/ChatApp.tsx').match(/!sidebarOpen && <UpdateIndicator/g) || []).length, 2);
  assert.match(read('components/chat/SubjectPage.tsx'), /!sidebarOpen && <UpdateIndicator/);
});

test('the compact button keeps its label for tooltips and screen readers', () => {
  const source = read('components/desktop/UpdateIndicator.tsx');
  assert.match(source, /\{!compact && <span>\{tx\("更新"\)\}<\/span>\}/);
  assert.match(source, /aria-label=\{label\}/);
  assert.match(source, /title=\{label\}/);
  assert.match(read('components/desktop/UpdateIndicator.module.css'), /\.compact \{[^}]*width: 26px/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../src');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
function load(file) {
  const module = { exports: {} };
  const js = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  new Function('module', 'exports', 'localStorage', 'document', js)(module, module.exports, store, { documentElement: { dataset: {} } });
  return module.exports;
}
const values = new Map();
const store = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };

test('the conversation width setting offers four widths and keeps old choices valid', () => {
  const { readAppearance, writeAppearance } = load('lib/appearance.ts');
  assert.equal(readAppearance('u').width, 'medium');
  for (const width of ['narrow', 'medium', 'wide', 'full']) {
    writeAppearance('u', { textSize: 'medium', width, motion: 'system' });
    assert.equal(readAppearance('u').width, width);
  }
  values.set('u:knowgap.appearance.v1', JSON.stringify({ width: 'huge' }));
  assert.equal(readAppearance('u').width, 'medium');
  const dialog = read('components/settings/SettingsDialog.tsx');
  assert.match(dialog, /id: "full", label: "全宽"/);
});

test('every width rewrites the column, the bubble and (only for compact) the text measure', () => {
  const css = read('app/globals.css');
  for (const width of ['narrow', 'wide', 'full']) assert.match(css, new RegExp(`data-chat-width="${width}"\]`));
  assert.match(css, /data-chat-width="full"\]\s*\{[^}]*--chat-w: 100%/);
  const list = read('components/chat/MessageList.module.css');
  assert.match(list, /--chat-text-w: none/);
  assert.match(list, /data-chat-width="narrow"\]\) \.list\s*\{\s*--chat-text-w: 68ch/);
  assert.match(read('components/chat/Markdown.module.css'), /max-width: var\(--chat-text-w, 68ch\)/);
});

test('reasoning flows from the stream into the message and is shown before the answer', () => {
  const api = read('lib/chat/api.ts');
  assert.match(api, /case "reasoning":\s*return \{ type, text: String\(data\.text \?\? ""\) \}/);
  assert.match(api, /reasoning: String\(data\.reasoning \?\? ""\)/);
  assert.match(read('hooks/useChat.ts'), /case "reasoning":[\s\S]*reasoning: \(m\.reasoning \?\? ""\) \+ event\.text/);
  const list = read('components/chat/MessageList.tsx');
  assert.ok(list.indexOf('<ReasoningBlock') < list.indexOf('<SmoothMarkdown'));
  assert.match(list, /streaming && !message\.reasoning/);
});

test('the thinking block opens while thinking, folds once the answer starts, and respects a manual choice', () => {
  const block = read('components/chat/ReasoningBlock.tsx');
  assert.match(block, /const thinking = streaming && !answering/);
  assert.match(block, /const open = chosen \?\? thinking/);
  assert.match(block, /aria-expanded=\{open\}/);
});

test('smooth text never waits on animation frames and snaps when the text is not a continuation', () => {
  const hook = read('hooks/useSmoothText.ts');
  assert.doesNotMatch(hook, /requestAnimationFrame\(/);
  assert.match(hook, /target\.startsWith\(shown\)/);
  assert.match(hook, /motionReduced\(\)/);
});

test('the space panel tabs share one sliding thumb and new views fade in', () => {
  const page = read('components/chat/SubjectPage.tsx');
  assert.match(page, /useSlidingThumb\(tabsRef, \[/);
  assert.match(page, /styles\.panelThumb, tabThumb\.animate && styles\.panelThumbSlide/);
  const css = read('components/chat/SubjectPage.module.css');
  assert.match(css, /\.panelThumbSlide\s*\{\s*transition:\s*transform[^}]*width/);
  assert.match(css, /\.panelTabActive,\s*\.panelTabActive:hover\s*\{\s*background: transparent;\s*color: var\(--text\);\s*\}/);
  assert.match(css, /\.panel > :not\(\.panelBar\)\s*\{\s*animation: panel-view-in/);
  const hook = read('hooks/useSlidingThumb.ts');
  assert.match(hook, /new ResizeObserver\(measure\)/);
  assert.match(hook, /animate: placed\.current/);
});

test('the space panel tab bar is icon-only except the active tab, has a Library and no Pages tab', () => {
  const page = read('components/chat/SubjectPage.tsx');
  assert.match(page, /\{tab\.active && <span className=\{styles\.tabLabel\}>\{tab\.label\}<\/span>\}/);
  assert.match(page, /aria-label=\{tab\.label\}/);
  const labels = [...page.matchAll(/key: "(\w+)", icon: \w+, label: "([^"]+)"/g)].map((m) => m[2]);
  assert.deepEqual(labels, ['支线', '资料库', '图谱', '任务', '记忆', '概览']);
  assert.doesNotMatch(page, /label: "Pages"/);
  assert.match(page, /const libraryOpen = panel\.mode === "pages"/);
  assert.match(page, /<Library\s[^>]*onOpenNotes=\{\(\) => setPanel\(\{ mode: "pages" \}\)\}/);
});

test('the library lists materials with sortable columns, a type filter, two views and drag-and-drop upload', () => {
  const library = read('components/chat/Library.tsx');
  for (const label of ['名称', '修改日期', '规模', '类型']) assert.ok(library.includes(`header(`) && library.includes(`"${label}"`));
  assert.match(library, /FILTERS: Array<\{ id: Category \| "all"/);
  assert.match(library, /aria-pressed=\{view === "grid"\}/);
  assert.match(library, /onDrop=\{onDrop\}/);
  assert.match(library, /确认删除/);
  assert.match(library, /DOCUMENT_EXTENSIONS\.join/);
});

test('the pomodoro timer is gone: no entry points, events, tray command or API remain', () => {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(!fs.existsSync(path.join(root, 'components/focus')));
  assert.ok(!fs.existsSync(path.join(root, 'lib/focus')));
  assert.doesNotMatch(read('lib/agenda/types.ts'), /FOCUS_START_EVENT/);
  assert.doesNotMatch(read('components/chat/ConversationSidebar.tsx'), /focusSlot/);
  assert.doesNotMatch(read('components/agenda/AgendaList.tsx'), /专注/);
  assert.doesNotMatch(read('components/home/TodayPanel.tsx'), /专注/);
  assert.doesNotMatch(read('components/onboarding/HelpCenter.tsx'), /开始专注/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../../desktop/preload.js'), 'utf8'), /start-focus/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../../desktop/main.js'), 'utf8'), /start-focus/);
});

test('the waiting state is the blue twinkling cluster with an elapsed timer, in the placeholder and the thinking header', () => {
  const css = read('components/chat/WorkingIndicator.module.css');
  assert.match(css, /\.glyph\s*\{[^}]*color: var\(--accent\)/);
  assert.match(css, /@keyframes working-twinkle/);
  assert.match(css, /@keyframes working-orbit/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  const list = read('components/chat/MessageList.tsx');
  assert.match(list, /<WorkingIndicator label=/);
  assert.doesNotMatch(list, /styles\.thinking/);
  assert.match(read('components/chat/ReasoningBlock.tsx'), /<WorkingGlyph size=\{14\} \/>/);
  const { formatElapsed } = (() => {
    const module = { exports: {} };
    const js = ts.transpileModule(read('components/chat/WorkingIndicator.tsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function('module', 'exports', 'require', js)(module, module.exports, (name) => (name === 'react' || name === 'react/jsx-runtime' ? require(name) : {}));
    return module.exports;
  })();
  assert.equal(formatElapsed(4), '4秒');
  assert.equal(formatElapsed(64), '1分4秒');
  assert.equal(formatElapsed(120), '2分0秒');
});

test('generated files stream into the message and download with the login token', () => {
  const api = read('lib/chat/api.ts');
  assert.match(api, /case "file":\s*return \{ type, file: mapFile\(data\) \}/);
  assert.match(api, /\/api\/files\/\$\{encodeURIComponent\(file\.id\)\}\/download/);
  assert.match(api, /headers: authHeader\(\)/);
  assert.match(read('hooks/useChat.ts'), /case "file":[\s\S]*files: \[\.\.\.\(m\.files \?\? \[\]\), event\.file\]/);
  const list = read('components/chat/MessageList.tsx');
  assert.match(list, /<GeneratedFiles files=\{message\.files\} \/>/);
  assert.match(list, /create_document: "生成文件"/);
});

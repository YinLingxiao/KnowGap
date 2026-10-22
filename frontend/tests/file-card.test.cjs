const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const file = path.join(__dirname, '../src/components/chat/FileCard.tsx');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, name => {
  if (name.endsWith('.css')) return { default: {} };
  if (name === '@/lib/api/auth') return { USER_KEY: 'test-user' };
  if (name === '@/lib/config') return { API_BASE_URL: 'http://api.test' };
  if (name === '@/lib/cx') return { cx: (...parts) => parts.filter(Boolean).join(' ') };
  return require(name);
});
const card = mod.exports;
const attachment = { id: 'doc-one', name: '调度.pptx', kind: 'pptx', units: 24, unitLabel: '张幻灯片', chars: 123, outline: [], subjectId: null };

test('file cards distinguish document kinds, show real units and provide accessible removal', () => {
  for (const [extension, kind] of [['PDF', 'pdf'], ['docx', 'docx'], ['pptx', 'pptx'], ['xlsx', 'xlsx'], ['csv', 'text']]) {
    assert.equal(card.kindFromName(`文件.${extension}`), kind);
  }
  assert.equal(card.scaleOf(attachment), '24 张幻灯片');
  assert.equal(card.scaleOf({ units: 0, unitLabel: '页' }), '');
  const html = renderToStaticMarkup(React.createElement(card.FileCard, {
    name: attachment.name, scale: card.scaleOf(attachment), onRemove: () => {},
  }));
  assert.ok(html.includes('24 张幻灯片'));
  assert.ok(html.includes('lucide-presentation'));
  assert.ok(html.includes('aria-label="移除 调度.pptx"'));
});

test('uploading, backend error and read-only cards render without marker text', () => {
  const loading = renderToStaticMarkup(React.createElement(card.FileCard, { name: '报告.docx', state: 'uploading' }));
  assert.ok(loading.includes('正在上传并解析'));
  const failed = renderToStaticMarkup(React.createElement(card.FileCard, { name: '旧课件.ppt', state: 'error', error: '请另存为 .pptx', onRemove: () => {} }));
  assert.ok(failed.includes('role="alert"'));
  assert.ok(failed.includes('请另存为 .pptx'));
  const readonly = renderToStaticMarkup(React.createElement(card.FileCard, { name: attachment.name, onOpen: () => {} }));
  assert.ok(readonly.includes('在资料库中打开'));
  assert.ok(!readonly.includes('移除'));
  assert.ok(!readonly.includes('[[file:'));
});

test('metadata is viewer-scoped and navigation reuses saved app view and space panel', () => {
  const previous = { localStorage: global.localStorage, sessionStorage: global.sessionStorage, window: global.window };
  const storage = () => {
    const map = new Map();
    return { setItem: (key, value) => map.set(key, value), getItem: key => map.get(key) ?? null };
  };
  global.localStorage = storage(); global.sessionStorage = storage();
  let destination;
  global.window = { location: { assign: value => { destination = value; } } };
  try {
    global.localStorage.setItem('test-user', 'student-one');
    card.rememberFile(attachment);
    assert.equal(card.recalledFile(attachment.id).units, 24);
    global.localStorage.setItem('test-user', 'student-two');
    assert.equal(card.recalledFile(attachment.id), undefined);
    card.openFileLibrary('space-one');
    assert.equal(destination, '/');
    assert.deepEqual(JSON.parse(global.localStorage.getItem('student-two:knowgap.chat.view.v1:http://api.test')),
      { type: 'subject', id: 'space-one' });
    assert.deepEqual(JSON.parse(global.localStorage.getItem('knowgap.space.panel.v1:http://api.test:space-one')),
      { mode: 'info', section: 'files' });
    card.openFileLibrary(null);
    assert.deepEqual(JSON.parse(global.localStorage.getItem('student-two:knowgap.chat.view.v1:http://api.test')), { type: 'materials' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});

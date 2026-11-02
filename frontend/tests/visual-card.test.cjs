// 可视化卡片 srcdoc：离线 CSP、外壳剥离、主题变量与宿主通信。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/chat/visualSandbox.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const { VISUAL_MSG, THEME_VARS, readThemeVars, extractVisualBody, buildVisualSrcdoc } = mod.exports;

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;

test('srcdoc carries the offline CSP', () => {
  const html = buildVisualSrcdoc('<p>x</p>', {});
  assert.ok(html.includes(CSP));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'));
});

test('extractVisualBody strips the document shell', () => {
  assert.equal(extractVisualBody('<html><head></head><body>X</body></html>'), 'X');
  assert.equal(extractVisualBody('<!DOCTYPE html><html><head></head><body class="a">X</body></html>'), 'X');
  assert.equal(extractVisualBody('<!DOCTYPE html><HTML><HEAD></HEAD><BODY class="a">X</BODY></HTML>'), 'X');
  assert.equal(
    extractVisualBody('<html><head><style>p{color:red}</style><script>var a=1</script></head><body><p>Z</p></body></html>'),
    '<style>p{color:red}</style><script>var a=1</script><p>Z</p>',
  );
  assert.equal(extractVisualBody('  <div>卡片</div>  '), '<div>卡片</div>');
});

test('extractVisualBody collapses empty input', () => {
  assert.equal(extractVisualBody(''), '');
  assert.equal(extractVisualBody('   '), '');
  assert.equal(extractVisualBody('<html><body>   </body></html>'), '');
});

test('theme vars are written into :root and unsafe values are dropped', () => {
  const html = buildVisualSrcdoc('<b>A&B</b>', {
    '--bg': '#123456',
    '--text': '#fff</style><script>alert(1)</script>',
  });
  assert.match(html, /<style>:root\{[^}]*--bg:#123456[^}]*\}<\/style>/);
  assert.equal(html.includes('--text:'), false);
  assert.equal(html.includes('#fff</style>'), false);
  assert.ok(html.includes('<b>A&B</b>'));
});

test('model content follows the bridge and message types come from VISUAL_MSG', () => {
  const html = buildVisualSrcdoc('<p id="card">卡片</p>', { '--bg': '#123456' });
  assert.ok(html.includes('window.knowgap'));
  assert.ok(html.includes('ResizeObserver'));
  assert.ok(html.includes('requestAnimationFrame'));
  assert.ok(html.includes('DOMContentLoaded'));
  assert.ok(html.includes('unhandledrejection'));
  assert.ok(html.includes('window.onerror'));
  assert.ok(html.includes('.slice(0, 500)'));
  for (const type of Object.values(VISUAL_MSG)) assert.ok(html.includes(type), type);
  const scriptAt = html.indexOf('window.knowgap');
  const contentAt = html.indexOf('<p id="card">卡片</p>');
  assert.ok(scriptAt >= 0 && contentAt > scriptAt);
  assert.ok(html.indexOf('</head><body>') < contentAt);
  assert.ok(html.endsWith('</body></html>'));
});

test('THEME_VARS includes the host tokens', () => {
  for (const name of [
    '--bg', '--bg-elevated', '--bg-subtle', '--text', '--text-secondary', '--text-tertiary',
    '--border', '--border-strong', '--accent', '--accent-soft', '--accent-text',
    '--green', '--green-soft', '--orange', '--orange-soft', '--font-sans', '--font-mono',
    '--radius', '--radius-lg',
  ]) {
    assert.ok(THEME_VARS.includes(name), name);
  }
});

test('readThemeVars without document returns empty', () => {
  assert.equal(typeof document, 'undefined');
  assert.deepEqual(readThemeVars(), {});
});

function bridgeContext(hasObserver) {
  const messages = [];
  const props = {};
  const raf = [];
  const listeners = {};
  let onResize = null;
  const element = {
    scrollHeight: 90,
    style: { setProperty: (key, value) => { props[key] = value; } },
  };
  const sandbox = {
    parent: { postMessage: (data) => messages.push(data) },
    document: {
      documentElement: element,
      addEventListener: (type, fn) => { listeners['doc:' + type] = fn; },
    },
    requestAnimationFrame: (fn) => { raf.push(fn); return raf.length; },
    Object,
    String,
    addEventListener: (type, fn) => { listeners['win:' + type] = fn; },
  };
  sandbox.window = sandbox;
  if (hasObserver) {
    sandbox.ResizeObserver = function ResizeObserver(cb) {
      onResize = cb;
      this.observe = () => {};
    };
  }
  return { sandbox, messages, props, raf, listeners, fireResize: () => onResize && onResize() };
}

function runBridge(hasObserver) {
  const html = buildVisualSrcdoc('<p>ok</p>', {});
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>'));
  const ctx = bridgeContext(hasObserver);
  vm.runInContext(script, vm.createContext(ctx.sandbox));
  return ctx;
}

test('bridge reports height once per frame, ask, error, and theme', () => {
  const ctx = runBridge(true);
  assert.equal(ctx.messages.length, 0);
  ctx.fireResize();
  ctx.fireResize();
  assert.equal(ctx.raf.length, 1);
  ctx.raf[0]();
  assert.equal(ctx.messages[0].type, 'knowgap-visual:height');
  assert.equal(ctx.messages[0].height, 90);
  ctx.listeners['doc:DOMContentLoaded']();
  ctx.listeners['win:load']();
  assert.equal(ctx.messages.length, 3);
  ctx.sandbox.knowgap.ask('x'.repeat(800));
  const asked = ctx.messages[ctx.messages.length - 1];
  assert.equal(asked.type, 'knowgap-visual:ask');
  assert.equal(asked.text.length, 500);
  ctx.sandbox.onerror('boom');
  const errored = ctx.messages[ctx.messages.length - 1];
  assert.equal(errored.type, 'knowgap-visual:error');
  assert.equal(errored.message, 'boom');
  ctx.listeners['win:unhandledrejection']({ reason: 'nope' });
  const rejected = ctx.messages[ctx.messages.length - 1];
  assert.equal(rejected.type, 'knowgap-visual:error');
  assert.equal(rejected.message, 'nope');
  ctx.listeners['win:message']({ data: { type: 'knowgap-visual:theme', vars: { '--bg': '#123', color: 'red', '--text': 1 } } });
  assert.equal(ctx.props['--bg'], '#123');
  assert.equal(ctx.props['--text'], '1');
  assert.equal(ctx.props.color, undefined);
});

test('bridge falls back to load and resize without ResizeObserver', () => {
  const ctx = runBridge(false);
  ctx.listeners['win:load']();
  ctx.listeners['win:resize']();
  assert.deepEqual(ctx.messages.map((message) => message.type), ['knowgap-visual:height', 'knowgap-visual:height']);
  assert.equal(ctx.listeners['doc:DOMContentLoaded'] !== undefined, true);
});

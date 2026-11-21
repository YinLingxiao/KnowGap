// 可视化卡片 srcdoc：离线 CSP、外壳剥离、主题变量与宿主通信。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/lib/chat/visualSandbox.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const js = ts.transpileModule(source, {
  fileName: sourcePath,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    inlineSourceMap: true,
    inlineSources: true,
  },
}).outputText;
const visualModule = new Module(sourcePath, module);
visualModule.filename = sourcePath;
visualModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
visualModule._compile(js, sourcePath);
const { VISUAL_MSG, THEME_VARS, KIT_CLASSES, readThemeVars, extractVisualBody, buildVisualSrcdoc } = visualModule.exports;

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
    '--green', '--green-soft', '--orange', '--orange-soft', '--font-sans', '--font-read', '--font-mono',
    '--text-read', '--radius', '--radius-lg',
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
    dataset: {},
    getBoundingClientRect: () => ({ height: 89.4 }),
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
  ctx.listeners['doc:DOMContentLoaded']();
  assert.equal(ctx.messages.length, 1);
  assert.equal(ctx.messages[0].type, 'knowgap-visual:height');
  assert.equal(ctx.messages[0].height, 90);
  ctx.fireResize();
  ctx.fireResize();
  assert.equal(ctx.raf.length, 1);
  ctx.raf[0]();
  assert.equal(ctx.messages[1].type, 'knowgap-visual:height');
  assert.equal(ctx.messages[1].height, 90);
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
  ctx.listeners['win:message']({ source: {}, data: { type: 'knowgap-visual:theme', vars: { '--bg': '#000' } } });
  assert.equal(ctx.props['--bg'], undefined);
  ctx.listeners['win:message']({ source: ctx.sandbox.parent, data: { type: 'knowgap-visual:theme', vars: { '--bg': '#123', color: 'red', '--text': 1 } } });
  assert.equal(ctx.props['--bg'], '#123');
  assert.equal(ctx.props['--text'], '1');
  assert.equal(ctx.props.color, undefined);
});

test('bridge falls back to load and resize without ResizeObserver', () => {
  const ctx = runBridge(false);
  ctx.listeners['doc:DOMContentLoaded']();
  ctx.listeners['win:load']();
  ctx.listeners['win:resize']();
  assert.deepEqual(ctx.messages.map((message) => message.type), Array(3).fill('knowgap-visual:height'));
});

test('bridge sends no height before DOMContentLoaded', () => {
  // 文档只有 <head> 时 ResizeObserver 就会触发，此刻的高度只有几像素，上报会让卡片先缩成一小条
  const ctx = runBridge(true);
  ctx.fireResize();
  ctx.raf.splice(0).forEach((frame) => frame());
  ctx.listeners['win:load']();
  assert.deepEqual(ctx.messages, []);
  ctx.listeners['doc:DOMContentLoaded']();
  assert.equal(ctx.messages.length, 1);
  assert.equal(ctx.messages[0].height, 90);
  // 之后照常：每帧合并一次
  ctx.fireResize();
  ctx.fireResize();
  assert.equal(ctx.raf.length, 1);
  ctx.raf.splice(0).forEach((frame) => frame());
  assert.equal(ctx.messages.length, 2);

  const fallback = runBridge(false);
  fallback.listeners['win:resize']();
  fallback.listeners['win:load']();
  assert.deepEqual(fallback.messages, []);
  fallback.listeners['doc:DOMContentLoaded']();
  assert.equal(fallback.messages.length, 1);
});

test('every kit class the prompt tells the model to use exists in the sandbox stylesheet', () => {
  const guide = fs.readFileSync(path.join(__dirname, '../../backend/app/chat/prompts/zh/widgets.yaml'), 'utf8');
  const named = [...new Set(guide.match(/\bkg-[a-z]+/g) || [])];
  assert.ok(named.length >= 10, 'the visual guide should document the kit');
  const shipped = new Set(KIT_CLASSES.map((name) => name.slice(1)));
  assert.deepEqual(named.filter((name) => !shipped.has(name)), []);
  const html = buildVisualSrcdoc('<p>x</p>', {});
  for (const name of named) assert.ok(html.includes('.' + name), `${name} missing from srcdoc`);
});

test('the kit ships timeline, flow, array-cell and chart components', () => {
  for (const name of [
    '.kg-timeline', '.kg-event', '.kg-flow', '.kg-box', '.kg-cells', '.kg-cell',
    '.kg-axis', '.kg-gridline', '.kg-plot', '.kg-point',
  ]) {
    assert.ok(KIT_CLASSES.includes(name), name);
  }
  const html = buildVisualSrcdoc('', {});
  // 箭头、圆点、下标都靠 CSS 画，不需要额外标记
  assert.ok(html.includes('.kg-flow>.kg-box+.kg-box::before'));
  assert.ok(html.includes('.kg-flow>.kg-box+.kg-box::after'));
  assert.ok(html.includes('.kg-event:last-child::after'));
  assert.ok(html.includes('content:attr(data-i)'));
  // 伪元素不在 * 的范围内，减弱动效的规则要单独写上它们
  assert.ok(html.includes('*::before,*::after{transition:none!important'));
});

test('kit stylesheet stays flat and uses host colours, scalable sizes and the three type weights', () => {
  const html = buildVisualSrcdoc('', {});
  const css = (html.match(/<style>(html,body[\s\S]*?)<\/style>/) || [])[1] || '';
  assert.ok(css.includes('.kg-timeline'));
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|gradient\(|shadow|blur\(/i.test(css), false);
  const kitCss = css.slice(css.indexOf('h3,.kg-title'));
  const sizes = [...kitCss.matchAll(/font(?:-size)?:[^;}]*?(\d+(?:\.\d+)?)rem/g)].map((match) => Number(match[1]));
  assert.ok(sizes.length >= 20);
  assert.deepEqual(sizes.filter((size) => size < 0.8), []);
  assert.deepEqual([...kitCss.matchAll(/font(?:-size)?:[^;}]*?\d+(?:\.\d+)?px/g)].map((match) => match[0]), []);
  const weights = [...css.matchAll(/font-weight:(\d+)|font:(\d{3}) /g)].map((match) => Number(match[1] || match[2]));
  assert.ok(weights.length > 10);
  assert.deepEqual(weights.filter((weight) => ![400, 500, 600].includes(weight)), []);
});
test('srcdoc carries the host font stacks and base font size', () => {
  const theme = {
    '--font-sans': '"Geist Variable", "PingFang SC", sans-serif',
    '--font-read': '"Source Serif 4 Variable", "Songti SC", serif',
    '--font-mono': '"JetBrains Mono", Consolas, monospace',
    '--text-read': '16.5px',
  };
  const html = buildVisualSrcdoc('<p>中英 typography</p>', theme);
  for (const [name, value] of Object.entries(theme)) {
    assert.ok(html.includes(`${name}:${value}`), `${name} should be copied into srcdoc`);
  }
  assert.ok(html.includes('font-family:var(--font-sans)'));
  assert.ok(html.includes('font-size:var(--text-read,15px)'));
  assert.ok(html.includes('body{font-size:0.933333rem}'));
  assert.ok(html.includes("font-src data:"));
  assert.doesNotMatch(html, /@font-face|https?:\/\/[^'"\s]*\.(?:woff2?|ttf|otf)/i);
});

test('readThemeVars reads the host root and rejects invalid base sizes', () => {
  const root = {};
  const values = {
    '--font-sans': '"Geist Variable", sans-serif',
    '--font-read': '"Source Serif 4 Variable", serif',
    '--text-read': '16.5px',
  };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  const restore = (name, descriptor) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
  try {
    globalThis.document = { documentElement: root };
    delete globalThis.getComputedStyle;
    assert.deepEqual(readThemeVars(root), {});

    let baseSize = values['--text-read'];
    globalThis.getComputedStyle = (element) => {
      assert.equal(element, root);
      return {
        colorScheme: 'dark',
        getPropertyValue: (name) => name === '--text-read' ? baseSize : (values[name] || ''),
      };
    };
    const vars = readThemeVars();
    assert.equal(vars['--font-sans'], values['--font-sans']);
    assert.equal(vars['--font-read'], values['--font-read']);
    assert.equal(vars['--text-read'], '16.5px');
    assert.equal(vars['color-scheme'], 'dark');

    for (const invalid of ['1rem', '0px', '-1px', 'NaNpx', '16px</style>']) {
      baseSize = invalid;
      assert.equal(readThemeVars(root)['--text-read'], undefined, invalid);
      const html = buildVisualSrcdoc('', { '--text-read': invalid });
      assert.equal(html.includes(`--text-read:${invalid}`), false, invalid);
    }
  } finally {
    restore('document', documentDescriptor);
    restore('getComputedStyle', styleDescriptor);
  }
});

test('reduced motion is applied initially and kept in sync through the bridge', () => {
  const html = buildVisualSrcdoc('', {}, true);
  assert.ok(html.startsWith('<!doctype html><html data-motion="reduced">'));
  assert.ok(html.includes(':root[data-motion=reduced] *'));
  assert.ok(html.includes('@media (prefers-reduced-motion:reduce)'));

  const ctx = runBridge(true);
  const message = (motionReduced) => ctx.listeners['win:message']({
    source: ctx.sandbox.parent,
    data: { type: VISUAL_MSG.theme, vars: {}, motionReduced },
  });
  message(true);
  assert.equal(ctx.sandbox.document.documentElement.dataset.motion, 'reduced');
  message(false);
  assert.equal(ctx.sandbox.document.documentElement.dataset.motion, 'normal');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const desktop = path.resolve(__dirname, '../../desktop');
const logoPath = path.resolve(__dirname, '../public/brand/knowgap-logo.svg');
const source = fs.readFileSync(path.join(desktop, 'startup.js'), 'utf8');
const { buildStartupDocument } = require('../../desktop/startup');

test('startup reuses all five facets of the actual logo and is completely offline', () => {
  const logoSvg = fs.readFileSync(logoPath, 'utf8');
  for (const dark of [false, true]) {
    const html = buildStartupDocument({ logoSvg, dark, platform: 'win32' });
    assert.ok(html.includes(`data-theme="${dark ? 'dark' : 'light'}"`));
    assert.match(html, /data-platform="win32"/);
    for (let i = 0; i < 5; i++) assert.ok(html.includes(`class="piece piece-${i}"`));
    assert.equal((html.match(/<path\b/g) || []).length, 5);
    assert.doesNotMatch(html, /__THEME__|__PLATFORM__|__STARTUP_LOGO__/);
    assert.match(html, /default-src 'none'/);
    assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=/);
    assert.match(html, /role="status" aria-live="polite"/);
    assert.match(html, /prefers-reduced-motion: reduce/);
    assert.match(html, /data-paused/);
    assert.match(html, /visibilitychange/);
    assert.doesNotMatch(html, /setTimeout|setInterval|requestAnimationFrame|progressbar/);
  }
});

function fixture(visible = true) {
  let view;
  class FakeView {
    constructor() {
      view = this;
      this.calls = [];
      this.webContents = {
        destroyed: false,
        loadURL: async url => { this.url = url; },
        executeJavaScript: async script => { this.calls.push(script); },
        isDestroyed: () => this.webContents.destroyed,
        close: () => { this.webContents.destroyed = true; this.closed = (this.closed || 0) + 1; },
      };
    }
    setBackgroundColor(color) { this.background = color; }
    setBounds(bounds) { this.bounds = bounds; }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, __dirname: desktop, Buffer,
    require: name => name === 'electron' ? { WebContentsView: FakeView } : require(name),
  });
  const win = new EventEmitter();
  win.size = [1280, 820];
  win.destroyed = false;
  win.visible = visible;
  win.isDestroyed = () => win.destroyed;
  win.isVisible = () => win.visible;
  win.isFocused = () => win.visible;
  win.focusedApp = false;
  win.webContents = { focus: () => { win.focusedApp = true; } };
  win.getContentSize = () => win.size;
  win.children = [];
  win.contentView = {
    addChildView: child => win.children.push(child),
    removeChildView: child => { win.children = win.children.filter(item => item !== child); },
  };
  const controller = module.exports.createStartup(win, { logoPath, dark: true, platform: 'win32' });
  return { win, view, controller };
}

test('the startup view follows native window bounds, theme, status and visibility', async () => {
  const { win, view, controller } = fixture();
  await controller.ready;
  assert.equal(win.children.length, 1);
  assert.equal(view.background, '#00000000');
  assert.equal(JSON.stringify(view.bounds), JSON.stringify({ x: 0, y: 0, width: 1280, height: 820 }));
  win.size = [900, 600];
  win.emit('resize');
  assert.equal(view.bounds.width, 900);
  controller.setStatus('正在打开学习空间');
  controller.setTheme(false);
  win.visible = false;
  win.emit('hide');
  await Promise.resolve();
  assert.ok(view.calls.includes('window.knowgapStartup.setTheme(false)'));
  assert.ok(view.calls.includes('window.knowgapStartup.setStatus("正在打开学习空间")'));
  assert.ok(view.calls.includes('window.knowgapStartup.setPaused(true)'));
  win.visible = true;
  win.emit('show');
  await Promise.resolve();
  assert.ok(view.calls.includes('window.knowgapStartup.setPaused(false)'));
  controller.dispose();
});

test('handoff crossfades only once, then removes the view, renderer and every event listener', async () => {
  const { win, view, controller } = fixture();
  const first = controller.finish();
  assert.equal(controller.finish(), first);
  await first;
  assert.equal(view.calls.filter(call => call === 'window.knowgapStartup.finish()').length, 1);
  assert.equal(win.children.length, 0);
  assert.equal(view.closed, 1);
  assert.equal(win.focusedApp, true);
  for (const event of ['resize', 'show', 'hide', 'closed']) assert.equal(win.listenerCount(event), 0);
  controller.dispose();
  controller.setStatus('ignored after teardown');
  await Promise.resolve();
  assert.equal(view.closed, 1);
  assert.ok(!view.calls.some(call => call.includes('ignored after teardown')));
});

test('background startup and interrupted startup do not wait for animation or leak a renderer', async () => {
  const { win, view, controller } = fixture(false);
  await controller.finish();
  assert.ok(!view.calls.includes('window.knowgapStartup.finish()'));
  assert.equal(win.children.length, 0);
  const interrupted = fixture();
  interrupted.win.destroyed = true;
  interrupted.win.emit('closed');
  await interrupted.controller.finish();
  assert.equal(interrupted.view.closed, 1);
  assert.equal(interrupted.win.listenerCount('resize'), 0);
});

test('a failed exit animation still releases the startup renderer', async () => {
  const { win, view, controller } = fixture();
  await controller.ready;
  view.webContents.executeJavaScript = async script => {
    if (script === 'window.knowgapStartup.finish()') throw new Error('renderer unavailable');
  };
  await assert.rejects(controller.finish(), /renderer unavailable/);
  assert.equal(win.children.length, 0);
  assert.equal(view.closed, 1);
});

test('the real bootstrap displays startup before waiting for the backend, and tray restore never replays it', () => {
  const main = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8');
  const open = main.slice(main.indexOf('async function open()'), main.indexOf('if (!app.requestSingleInstanceLock())'));
  assert.ok(open.indexOf('createStartup(') < open.indexOf('await waitHealth(port)'));
  assert.ok(open.indexOf('showMain()') < open.indexOf('await waitHealth(port)'));
  assert.ok(open.indexOf('await mainWindow.loadURL') < open.indexOf('await startup?.finish()'));
  assert.match(open, /revealOnReady \|\| !process\.argv\.includes\("--hidden"\)/);
  assert.equal((open.match(/showMain\(\)/g) || []).length, 1, 'do not reopen a splash dismissed to tray');
  const show = main.match(/function showMain\(\) \{([\s\S]*?)\n\}/)[1];
  assert.doesNotMatch(show, /createStartup|loadURL/);
  assert.match(main, /nativeTheme\.themeSource = settings\.theme/);
  const files = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).build.files;
  for (const file of ['startup.js', 'startup.html']) assert.ok(files.includes(file));
});

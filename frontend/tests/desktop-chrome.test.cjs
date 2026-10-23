const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TITLE_BAR_HEIGHT, windowChromeOptions, applyWindowTheme } = require('../../desktop/window-chrome');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Windows and Linux keep native caption buttons with a theme-matched overlay', () => {
  for (const platform of ['win32', 'linux']) {
    for (const dark of [false, true]) {
      const options = windowChromeOptions(platform, dark);
      assert.equal(options.titleBarStyle, 'hidden');
      assert.equal(options.frame, undefined, 'do not disable the native resize/Snap frame');
      assert.equal(options.titleBarOverlay.height, TITLE_BAR_HEIGHT);
      assert.equal(options.titleBarOverlay.color, dark ? '#08080a' : '#ffffff');
      assert.equal(options.titleBarOverlay.symbolColor, dark ? '#989ea8' : '#525866');
    }
  }
  assert.deepEqual(windowChromeOptions('darwin', true), { titleBarStyle: 'hidden' });
});

test('native theme changes repaint the caption buttons, but macOS never calls the overlay API', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const calls = [];
    const win = {
      setBackgroundColor: color => calls.push(['background', color]),
      setTitleBarOverlay: overlay => calls.push(['overlay', overlay]),
    };
    for (const dark of [false, true]) {
      calls.length = 0;
      applyWindowTheme(win, platform, dark);
      assert.deepEqual(calls[0], ['background', dark ? '#08080a' : '#ffffff']);
      assert.equal(calls.length, platform === 'darwin' ? 1 : 2);
      if (platform !== 'darwin') assert.equal(calls[1][1].color, calls[0][1]);
    }
  }
});

function preload(argv) {
  let exposed;
  vm.runInNewContext(read('../desktop/preload.js'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
      ipcRenderer: { on() {}, invoke() {} },
      webFrame: {},
    }),
    process: { argv, platform: 'win32' },
  });
  return exposed;
}

test('the shared preload enables window chrome only in the main window, never in quick ask', () => {
  assert.equal(preload(['electron', '--knowgap-main-window']).windowChrome.platform, 'win32');
  assert.equal(preload(['electron']).windowChrome, undefined);
  const main = read('../desktop/main.js');
  assert.match(main, /additionalArguments: \["--knowgap-main-window"\]/);
  assert.match(main, /nativeTheme\.on\("updated", syncMainWindowTheme\)/);
  const sync = main.match(/function syncMainWindowTheme\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(sync, /applyWindowTheme\(mainWindow,/);
  assert.doesNotMatch(sync, /applyWindowTheme\(quickWindow,/);
  assert.ok(JSON.parse(read('../desktop/package.json')).build.files.includes('window-chrome.js'));
});

test('desktop space is reserved before first paint, without changing browser or quick-panel layout', () => {
  const layout = read('src/app/layout.tsx');
  const script = layout.match(/const DESKTOP_CHROME_SCRIPT = `([^`]+)`/)[1];
  for (const platform of [undefined, 'win32', 'darwin', 'linux', 'other']) {
    const dataset = {};
    vm.runInNewContext(script, {
      window: { knowgap: platform ? { windowChrome: { platform } } : undefined },
      document: { documentElement: { dataset } },
    });
    assert.equal(dataset.desktopPlatform, ['win32', 'darwin', 'linux'].includes(platform) ? platform : undefined);
  }
  const css = read('src/app/globals.css');
  assert.match(css, /--desktop-titlebar-height: 0px/);
  assert.match(css, new RegExp(`--desktop-titlebar-height: ${TITLE_BAR_HEIGHT}px`));
  assert.match(css, /-webkit-app-region: drag/);
  assert.match(css, /env\(titlebar-area-width,/);
  const app = read('src/components/chat/ChatApp.module.css');
  assert.match(app, /height: calc\(100dvh - var\(--desktop-titlebar-height\)\)/);
  const main = app.match(/\.main \{([^}]+)\}/)[1];
  assert.doesNotMatch(main, /\b(?:margin|border|border-radius|box-shadow):/);
  assert.doesNotMatch(app, /\.sidebarClosed \.main\s*\{/);
});

test('external pages open in the default browser, never in an in-app window', () => {
  const main = read('../desktop/main.js');
  assert.match(main, /screen, shell \} = require\("electron"\)/);
  assert.match(main, /mainWindow\.webContents\.setWindowOpenHandler\(\(\{ url \}\) => \{\s*openInDefaultBrowser\(url\);\s*return \{ action: "deny" \};/);
  assert.match(main, /will-navigate[\s\S]*origin === appOrigin\) return;[\s\S]*event\.preventDefault\(\);\s*openInDefaultBrowser\(url\)/);
  const helper = main.match(/function openInDefaultBrowser\(url\) \{([\s\S]*?)\n\}/)[1];
  assert.match(helper, /parsed\.protocol === "https:" \|\| parsed\.protocol === "http:"/);
  assert.match(helper, /shell\.openExternal\(parsed\.toString\(\)\)/);
  // 只放行 http / https：about:blank、file:、自定义协议都不会交给系统
  const run = (url) => {
    const opened = [];
    const fn = new Function('URL', 'shell', `${main.match(/function openInDefaultBrowser[\s\S]*?\n\}/)[0]}; return openInDefaultBrowser;`)(URL, { openExternal: (u) => opened.push(u) });
    fn(url);
    return opened;
  };
  assert.deepEqual(run('https://auth.openai.com/api/accounts/authorize?x=1'), ['https://auth.openai.com/api/accounts/authorize?x=1']);
  for (const bad of ['about:blank', 'file:///C:/Windows/system32', 'javascript:alert(1)', 'ms-settings:', 'not a url']) assert.deepEqual(run(bad), [], bad);
});

test('the fixed memory drawer clears native caption buttons without shifting browser or quick-panel content', () => {
  const app = read('src/components/chat/ChatApp.module.css');
  const drawer = app.match(/\.drawer \{([^}]+)\}/)[1];
  assert.match(drawer, /position: fixed/);
  assert.match(drawer, /top: var\(--desktop-titlebar-height\)/);
  assert.match(drawer, /bottom: 0/);
  assert.doesNotMatch(drawer, /(?:^|\n)\s*(?:top:\s*0|height:\s*100(?:d?vh|%))/);
  const globals = read('src/app/globals.css');
  assert.match(globals.match(/:root \{([^}]+)\}/)[1], /--desktop-titlebar-height: 0px/);
  assert.match(globals.match(/:root\[data-desktop-platform\] \{([^}]+)\}/)[1], new RegExp(`--desktop-titlebar-height: ${TITLE_BAR_HEIGHT}px`));
  const memory = read('src/components/chat/MemoryDrawer.tsx');
  assert.match(memory, /aria-label="刷新"/);
  assert.match(memory, /aria-label="关闭学习记忆"/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const { resolveI18n } = require('./i18n-support.cjs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function preload() {
  let exposed;
  const ipc = new (require('node:events').EventEmitter)();
  const calls = [];
  ipc.invoke = (...args) => { calls.push(args); return Promise.resolve(); };
  vm.runInNewContext(read('../desktop/preload.js'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } }, ipcRenderer: ipc, webFrame: {} }),
    process: { argv: [], platform: 'win32' },
  });
  return { exposed, ipc, calls };
}

test('preload exports only fixed updater methods; subscription returns a real unsubscribe', async () => {
  const { exposed, ipc, calls } = preload();
  assert.deepEqual(Object.keys(exposed.updater).sort(), ['getState', 'check', 'install', 'onState'].sort());
  await exposed.updater.getState();
  await exposed.updater.check({ download: true });
  await exposed.updater.install('https://evil.test/not-an-installer.exe');
  assert.equal(calls[0][0], 'updater:get-state');
  assert.equal(calls[1][0], 'updater:check');
  assert.deepEqual(calls[2], ['updater:install']);
  assert.throws(() => exposed.updater.onState('not a listener'));
  const received = [];
  const off = exposed.updater.onState(state => received.push(state));
  ipc.emit('updater:state', { secretEvent: true }, { status: 'downloaded' });
  assert.deepEqual(received, [{ status: 'downloaded' }], 'never passes Electron event to page code');
  off(); off();
  ipc.emit('updater:state', {}, { status: 'error' });
  assert.equal(received.length, 1);
  assert.equal(ipc.listenerCount('updater:state'), 0);
});

const settings = { autoCheckUpdates: true, autoDownloadUpdates: true, autoInstallOnQuit: false, updateUrl: '' };
const baseState = { status: 'idle', enabled: true, currentVersion: '0.5.6', version: null, progress: null, releaseNotes: '', error: null };
function renderRows(state, prefs = settings) {
  const source = ts.transpileModule(read('src/components/settings/UpdateRows.tsx'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const values = [prefs, prefs?.updateUrl || '', '', false, false];
  const css = new Proxy({}, { get: (_target, key) => String(key) });
  const localRequire = id => {
    if (resolveI18n(id)) return resolveI18n(id);
    if (id === 'react') return { ...React, useEffect() {}, useState: () => [values.shift(), () => {}] };
    if (id === '@/lib/desktop-updater') return { useUpdaterState: () => state, desktopUpdateApi: () => null };
    if (id.endsWith('.css')) return { default: css };
    return require(id);
  };
  new Function('exports', 'require', source)(exports, localRequire);
  return renderToStaticMarkup(React.createElement(exports.UpdateRows));
}

test('software update group is absent in browser; general settings has just one mount below DesktopRows', () => {
  assert.equal(renderRows(null), '');
  const dialog = read('src/components/settings/SettingsDialog.tsx');
  assert.match(dialog, /<DesktopRows \/>\s*<UpdateRows \/>/);
  assert.equal((dialog.match(/<UpdateRows \/>/g) || []).length, 1);
  assert.match(read('src/lib/desktop-updater.ts'), /typeof window === "undefined"/);
});

test('downloaded version is explicit, update notes are escaped text, and there is no automatic install or modal', () => {
  const html = renderRows({ ...baseState, status: 'downloaded', version: '0.5.7', releaseNotes: '<script>alert(1)</script>' });
  assert.match(html, /新版本 0.5.7 已下载，重启即可安装/);
  assert.match(html, /重启并安装/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<details[\s\S]*<summary>更新说明/);
  assert.match(html, /中断正在生成的回复/);
  assert.match(html, /UAC/);
  assert.match(html, /未知发布者/);
  const source = read('src/components/settings/UpdateRows.tsx');
  assert.doesNotMatch(source, /showModal|alert\(|Notification|dangerouslySetInnerHTML/);
});

test('settings toggles use accessible names, safe defaults, source help and disabled states', () => {
  const html = renderRows(baseState);
  assert.match(html, /role="switch" aria-checked="true" aria-label="自动检查更新"/);
  assert.match(html, /role="switch" aria-checked="true" aria-label="自动下载"/);
  assert.match(html, /role="switch" aria-checked="false" aria-label="退出时自动安装已下载的更新"/);
  assert.match(html, /for="knowgap-update-url"/);
  assert.match(html, /aria-describedby="knowgap-update-url-help"/);
  assert.match(html, /默认：GitHub Releases/);
  assert.match(renderRows({ ...baseState, enabled: false, disabledReason: '已关闭' }), /已关闭/);
  assert.match(renderRows({ ...baseState, sourceFromEnv: true }), /KNOWGAP_UPDATE_URL/);
});

test('download progress exposes percent, speed, bytes and a labeled native progressbar', () => {
  const html = renderRows({ ...baseState, status: 'downloading', version: '0.5.7',
    progress: { percent: 50, bytesPerSecond: 1048576, transferred: 2097152, total: 4194304 } });
  assert.match(html, /<progress[^>]*value="50"[^>]*aria-label="更新下载进度"/);
  assert.match(html, /50% · 2.0 MB \/ 4.0 MB · 1.0 MB\/秒/);
  assert.match(renderRows({ ...baseState, status: 'available', version: '0.5.7' }), /下载更新/);
});

test('sidebar downloaded indicator is quiet, keyboard-accessible and opens the existing settings', () => {
  const source = read('src/components/desktop/UpdateIndicator.tsx');
  assert.match(source, /state\.status !== "downloaded"\) return null/);
  assert.match(source, /<button[^>]*onClick=\{onOpenSettings\}[^>]*aria-label=\{label\} title=\{label\}/);
  assert.doesNotMatch(source, /Notification|alert\(|showModal|animate/);
  assert.match(read('src/components/chat/ConversationSidebar.tsx'), /<UpdateIndicator onOpenSettings=\{props.onOpenSettings\} \/>/);
  assert.match(read('src/components/settings/UpdateRows.module.css'), /:focus-visible/);
  assert.match(read('src/lib/desktop-updater.ts'), /alive = false; unsubscribe\(\)/);
});

test('release configuration fixes space renaming, bundles updater and disables accidental publishing', () => {
  const pkg = JSON.parse(read('../desktop/package.json'));
  assert.equal(pkg.dependencies['electron-updater'], '6.6.2');
  assert.ok(pkg.build.files.includes('updater.js'));
  assert.equal(pkg.build.nsis.artifactName, 'KnowGap-Setup-${version}.exe');
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'YinLingxiao', repo: 'KnowGap' }]);
  assert.match(pkg.scripts.dist, /--publish never/);
});

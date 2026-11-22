const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real main-process functions with a fake OS registration service.
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const registration = source.slice(source.indexOf('function registerQuickShortcut()'), source.indexOf('function showMain()'));
const startup = source.slice(source.indexOf('async function open()'), source.indexOf('\nif (!app.requestSingleInstanceLock()'));

function context(results) {
  const attempts = [];
  const callback = () => {};
  const sandbox = {
    QUICK_SHORTCUTS: ['Alt+Space', 'CommandOrControl+Shift+K'], quickShortcut: null,
    toggleQuickWindow: callback, process: { platform: 'win32', argv: [], env: {} },
    console: { log() {}, warn() {} },
    globalShortcut: { register(key, listener) {
      attempts.push(key);
      assert.equal(listener, callback);
      const value = results.shift();
      if (value instanceof Error) throw value;
      return value;
    } },
  };
  vm.createContext(sandbox);
  vm.runInContext(registration, sandbox);
  return { sandbox, attempts };
}

test('native registration falls back after an occupied or rejected shortcut', () => {
  for (const first of [false, new Error('reserved')]) {
    const { sandbox, attempts } = context([first, true]);
    sandbox.registerQuickShortcut();
    assert.deepEqual(attempts, ['Alt+Space', 'CommandOrControl+Shift+K']);
    assert.equal(sandbox.quickShortcut, 'CommandOrControl+Shift+K');
    assert.equal(sandbox.displayShortcut(), 'Ctrl+Shift+K');
  }
});

test('native registration keeps the default when available and returns no key when all fail', () => {
  const available = context([true]);
  available.sandbox.registerQuickShortcut();
  assert.deepEqual(available.attempts, ['Alt+Space']);
  assert.equal(available.sandbox.displayShortcut(), 'Alt+Space');
  const unavailable = context([false, false]);
  unavailable.sandbox.registerQuickShortcut();
  assert.equal(unavailable.sandbox.displayShortcut(), null);
});

test('main page can query the registered fallback as soon as it starts rendering', async () => {
  const { sandbox } = context([false, true]);
  let readDuringLoad;
  Object.assign(sandbox, {
    app: { isPackaged: true, getPath: () => '/test-data' }, process: { platform: 'win32', argv: [], env: {}, resourcesPath: '/test-resources' },
    path, fs: { existsSync: () => true, readFileSync: () => Buffer.from('index') },
    backendPath: () => '/test-resources/backend.exe', staticPath: () => '/test-resources/frontend',
    createMainWindow() {}, mainWindow: {
      isDestroyed: () => false, loadURL: async () => { readDuringLoad = sandbox.quickShortcut; },
    },
    createStartup: () => ({ ready: Promise.resolve(), setStatus() {}, finish: async () => {} }),
    nativeTheme: { shouldUseDarkColors: false }, stopping: false, revealOnReady: false,
    showMain() {}, pickPort: async () => 8000, spawn: () => ({ on() {} }),
    waitHealth: async () => {}, rememberPort() {}, refreshTrayMenu() {},
    createHash: () => ({ update() { return this; }, digest: () => 'revision' }),
    frontendUrl: () => 'http://127.0.0.1:8000/', __dirname: path.join(__dirname, '..'),
  });
  vm.runInContext(startup, sandbox);
  await sandbox.open();
  assert.equal(readDuringLoad, 'CommandOrControl+Shift+K');
});

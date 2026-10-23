const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createUpdater, UPDATE_DEFAULTS, CHANNELS, normalizeUpdateSettings, validateUpdatePatch, validateUpdateUrl, releaseText } = require('../updater');

const tick = () => new Promise(resolve => setImmediate(resolve));
const info = { version: '0.5.7', releaseNotes: '<p>修复更新</p>' };
function fixture(options = {}) {
  const calls = [];
  const events = [];
  const handlers = new Map();
  const timers = new Map();
  const engine = new EventEmitter();
  engine.setFeedURL = feed => calls.push(['feed', feed]);
  engine.checkForUpdates = async () => { engine.emit('update-not-available', info); };
  engine.downloadUpdate = async () => calls.push('download');
  engine.quitAndInstall = (...args) => calls.push(['install', ...args]);
  const prefs = { ...UPDATE_DEFAULTS, ...options.settings };
  const app = { isPackaged: true, getVersion: () => '0.5.6', ...options.app };
  const updater = createUpdater({ app, autoUpdater: engine, platform: 'win32', env: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_name, state) => events.push(state) } }],
    isTrustedSender: event => event.trusted === true,
    getSettings: () => prefs,
    confirmInstall: async () => { calls.push('confirm'); return true; },
    prepareInstall: async () => { calls.push('quitting'); await tick(); calls.push('backend-stopped', 'quick-destroyed', 'tray-destroyed'); },
    cancelInstall: () => calls.push('recover'),
    timers: {
      setTimeout: (fn, ms) => { timers.set('delay', { fn, ms }); return 'delay'; },
      clearTimeout: key => timers.delete(key),
      setInterval: (fn, ms) => { timers.set('interval', { fn, ms }); return 'interval'; },
      clearInterval: key => timers.delete(key),
    },
    ...options, // settings is consumed above; unknown fields are ignored by createUpdater
  });
  return { updater, engine, prefs, calls, events, handlers, timers };
}

test('settings defaults are safe; old settings survive and patches reject unknown keys/types', () => {
  assert.deepEqual(normalizeUpdateSettings(), UPDATE_DEFAULTS);
  assert.deepEqual(normalizeUpdateSettings({ openAtLogin: true, updateUrl: 'bad' }), UPDATE_DEFAULTS);
  assert.equal(normalizeUpdateSettings({ autoCheckUpdates: false, autoDownloadUpdates: false, autoInstallOnQuit: true }).autoInstallOnQuit, true);
  assert.deepEqual(validateUpdatePatch({ closeToTray: false, openAtLogin: true }), { closeToTray: false, openAtLogin: true });
  for (const patch of [null, [], 'url', { url: 'https://evil.test' }, { autoInstallOnQuit: 'true' }, { updateUrl: 3 }, { __proto__: null, theme: 'dark' }]) {
    assert.throws(() => validateUpdatePatch(patch));
  }
});

test('custom feed is a secure directory URL, never credentials or an arbitrary file path', () => {
  assert.equal(validateUpdateUrl(''), '');
  assert.equal(validateUpdateUrl(' https://updates.example.test/windows '), 'https://updates.example.test/windows/');
  assert.equal(validateUpdateUrl('http://127.0.0.1:8123'), 'http://127.0.0.1:8123/');
  for (const url of ['not a url', 'http://example.test', 'http://localhost:8123', 'http://127.0.0.2', 'file:///C:/x',
    'https://name:password@example.test', 'https://name@example.test', 'https://example.test/latest.yml', 'https://example.test/a.exe',
    'https://example.test/?token=secret', 'https://example.test/#x', 'https://example.test\\evil', 4, null]) {
    assert.throws(() => validateUpdateUrl(url), undefined, String(url));
  }
});

test('production guards, 20 second delay, 4 hour interval, fixed GitHub source and security policy', async () => {
  const { updater, engine, timers, calls } = fixture();
  assert.equal(timers.get('delay').ms, 20000);
  assert.equal(timers.get('interval').ms, 4 * 60 * 60 * 1000);
  assert.equal(engine.autoInstallOnAppQuit, false);
  assert.equal(engine.autoDownload, false);
  assert.equal(engine.allowPrerelease, false);
  assert.equal(engine.allowDowngrade, false);
  assert.equal(engine.disableDifferentialDownload, false);
  await updater.check();
  assert.deepEqual(calls[0], ['feed', { provider: 'github', owner: 'YinLingxiao', repo: 'KnowGap' }]);
  updater.dispose();
  assert.equal(timers.size, 0);
  assert.equal(engine.listenerCount('error'), 0);
});

test('disabled environment, development and non-Windows never touch the update engine', async () => {
  for (const options of [{ env: { KNOWGAP_DISABLE_UPDATE: '1' } }, { app: { isPackaged: false, getVersion: () => '0.5.6' } }, { platform: 'linux' }]) {
    const { updater, calls, timers } = fixture(options);
    assert.equal(updater.getState().enabled, false);
    await updater.check({}, false);
    assert.equal(updater.getState().status, 'idle');
    assert.equal((await updater.check()).status, 'error');
    assert.equal(await updater.install(), false);
    assert.equal(timers.size, 0);
    assert.equal(calls.length, 0);
  }
});

test('check with no new version is silent in background, explicit in manual mode', async () => {
  const { updater, events } = fixture();
  assert.equal((await updater.check({}, false)).status, 'idle');
  assert.ok(events.every(state => !state.error));
  assert.equal((await updater.check()).status, 'none');
});

test('network/limit/hash errors are quiet in background and Chinese + redacted on manual check', async () => {
  for (const message of ['ECONNRESET https://private.test/secret', 'HTTP 403 rate limit', 'sha512 checksum invalid', '404 latest.yml']) {
    const { updater, engine, events } = fixture();
    engine.checkForUpdates = async () => { const error = new Error(message); engine.emit('error', error); throw error; };
    assert.equal((await updater.check({}, false)).status, 'idle');
    assert.ok(events.every(state => !state.error));
    const manual = await updater.check();
    assert.equal(manual.status, 'error');
    assert.match(manual.error, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(manual.error, /private|secret|ECONNRESET/);
  }
});

test('available -> downloading -> progress -> downloaded never invokes install on its own', async () => {
  const { updater, engine, calls, events } = fixture();
  engine.checkForUpdates = async () => { engine.emit('update-available', info); };
  await updater.check();
  await tick();
  engine.emit('download-progress', { percent: 42.5, bytesPerSecond: 1000, transferred: 4250, total: 10000 });
  assert.deepEqual(updater.getState().progress, { percent: 42.5, bytesPerSecond: 1000, transferred: 4250, total: 10000 });
  engine.emit('update-downloaded', info);
  assert.equal(updater.getState().status, 'downloaded');
  assert.equal(updater.getState().version, '0.5.7');
  assert.equal(updater.getState().releaseNotes, '修复更新');
  assert.ok(events.some(state => state.status === 'available'));
  assert.ok(calls.includes('download'));
  assert.ok(!calls.some(call => Array.isArray(call) && call[0] === 'install'));
  assert.equal(updater.handleBeforeQuit({ preventDefault: () => assert.fail('default off') }), false);
  const copy = updater.getState(); copy.version = 'bad';
  assert.equal(updater.getState().version, '0.5.7');
});

test('progress is finite/clamped, and release notes are bounded plain text', () => {
  const { updater, engine } = fixture();
  engine.emit('download-progress', { percent: 101, bytesPerSecond: Infinity, transferred: -1, total: NaN });
  assert.deepEqual(updater.getState().progress, { percent: 100, bytesPerSecond: 0, transferred: 0, total: 0 });
  assert.equal(releaseText('x'.repeat(9999)).length, 6000);
  assert.equal(releaseText([{ note: '<p>一</p>' }, { note: '二\u0000' }]), '一\n二');
});

test('automatic downloads can be disabled; explicit download uses the already discovered release', async () => {
  const { updater, engine, calls } = fixture({ settings: { autoDownloadUpdates: false, autoCheckUpdates: false } });
  engine.checkForUpdates = async () => engine.emit('update-available', info);
  await updater.check(); await tick();
  assert.equal(updater.getState().status, 'available');
  assert.ok(!calls.includes('download'));
  await updater.check({ download: true });
  assert.ok(calls.includes('download'));
});

test('explicit install always confirms then awaits backend teardown, destroys quick/tray, then installs once', async () => {
  const { updater, engine, calls } = fixture();
  engine.emit('update-downloaded', info);
  assert.equal(await updater.install(), true);
  assert.deepEqual(calls, ['confirm', 'quitting', 'backend-stopped', 'quick-destroyed', 'tray-destroyed', ['install', true, true]]);
  assert.equal(await updater.install(), false);
});

test('cancel, backend shutdown failure and installer error do not leave an install/quit loop', async () => {
  const canceled = fixture({ confirmInstall: async () => false });
  canceled.engine.emit('update-downloaded', info);
  assert.equal(await canceled.updater.install(), false);
  assert.equal(canceled.calls.length, 0);
  const failed = fixture({ prepareInstall: async () => { throw new Error('busy'); }, settings: { autoInstallOnQuit: true } });
  failed.engine.emit('update-downloaded', info);
  assert.equal(await failed.updater.install(), false);
  assert.equal(failed.updater.getState().status, 'downloaded');
  assert.ok(failed.calls.includes('recover'));
  assert.equal(failed.updater.handleBeforeQuit({ preventDefault: () => assert.fail('must not retry') }), false);
  const errored = fixture();
  errored.engine.emit('update-downloaded', info);
  errored.engine.quitAndInstall = () => errored.engine.emit('error', new Error('NSIS failed'));
  assert.equal(await errored.updater.install(), false);
  assert.ok(errored.calls.includes('recover'));
});

test('a teardown exception permits recovery to quit/relaunch instead of leaving the stopped backend behind', async () => {
  let updater;
  let recovered = false;
  const f = fixture({
    prepareInstall: async () => { throw new Error('teardown failed after backend stopped'); },
    cancelInstall: () => {
      assert.equal(updater.handleBeforeQuit({ preventDefault: () => assert.fail('recovery must be allowed to quit') }), false);
      recovered = true;
    },
    settings: { autoInstallOnQuit: true },
  });
  updater = f.updater;
  f.engine.emit('update-downloaded', info);
  assert.equal(await updater.install(), false);
  assert.equal(recovered, true);
});

test('opt-in quit installation is intercepted and ordered, without reopening the app or background modal', async () => {
  const { updater, engine, calls } = fixture({ settings: { autoInstallOnQuit: true } });
  engine.emit('update-downloaded', info);
  let prevented = false;
  assert.equal(updater.handleBeforeQuit({ preventDefault: () => { prevented = true; } }), true);
  assert.equal(prevented, true);
  await tick(); await tick();
  assert.deepEqual(calls, ['quitting', 'backend-stopped', 'quick-destroyed', 'tray-destroyed', ['install', true, false]]);
  assert.equal(engine.autoInstallOnAppQuit, false);
});

test('a second Quit cannot skip an in-flight installation teardown', async () => {
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const { updater, engine } = fixture({ prepareInstall: () => stopped });
  engine.emit('update-downloaded', info);
  const task = updater.install();
  await tick();
  let blocked = false;
  assert.equal(updater.handleBeforeQuit({ preventDefault: () => { blocked = true; } }), true);
  assert.equal(blocked, true);
  release();
  assert.equal(await task, true);
  assert.equal(updater.handleBeforeQuit({ preventDefault: () => assert.fail('allow engine quit') }), false);
});

test('environment source overrides settings; invalid override fails closed; settings changes are gated', async () => {
  const { updater, calls } = fixture({ env: { KNOWGAP_UPDATE_URL: 'http://127.0.0.1:8123' }, settings: { updateUrl: 'https://other.test' } });
  await updater.check();
  assert.deepEqual(calls[0], ['feed', { provider: 'generic', url: 'http://127.0.0.1:8123/', useMultipleRangeRequest: true }]);
  assert.equal(updater.getState().sourceFromEnv, true);
  const invalid = fixture({ env: { KNOWGAP_UPDATE_URL: 'http://remote.test' } });
  assert.equal((await invalid.updater.check()).status, 'error');
  assert.equal(invalid.calls.length, 0);
  invalid.engine.emit('update-downloaded', info);
  assert.throws(() => invalid.updater.validateSettingsChange({ updateUrl: 'https://new.test/' }));
});

test('IPC has a fixed whitelist, validates arguments and rejects non-local/untrusted frames', async () => {
  const { handlers, updater } = fixture();
  assert.deepEqual([...handlers.keys()].sort(), [CHANNELS.get, CHANNELS.check, CHANNELS.install].sort());
  for (const handler of handlers.values()) assert.throws(() => handler({ trusted: false }));
  assert.throws(() => handlers.get(CHANNELS.install)({ trusted: true }, '/tmp/evil.exe'));
  assert.throws(() => handlers.get(CHANNELS.get)({ trusted: true }, 'url'));
  for (const arg of [null, [], { url: 'https://evil.test' }, { download: 'true' }]) await assert.rejects(updater.check(arg));
  assert.equal(handlers.get(CHANNELS.get)({ trusted: true }).currentVersion, '0.5.6');
});

test('main integration retains NSIS upgrade data guard and awaits taskkill before destruction', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const prepare = main.match(/prepareInstall: async \(\) => \{([\s\S]*?)\n    \},/)[1];
  assert.ok(prepare.indexOf('quitting = true') < prepare.indexOf('await stopBackend()'));
  assert.ok(prepare.indexOf('await stopBackend()') < prepare.indexOf('quickWindow.destroy()'));
  assert.ok(prepare.indexOf('quickWindow.destroy()') < prepare.indexOf('tray.destroy()'));
  assert.match(main, /killer\.once\("exit"/);
  assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.match(main, /new URL\(event\.senderFrame\.url\)\.origin === appOrigin/);
  const nsis = fs.readFileSync(path.join(__dirname, '../installer.nsh'), 'utf8');
  assert.match(nsis, /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(nsis, /\$\{andIfNot\} \$\{Silent\}/);
});

test('actual main prepareInstall callback cannot destroy tray/quick or install before backend finishes', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const body = main.match(/prepareInstall: async \(\) => \{([\s\S]*?)\n    \},/)[1];
  const calls = [];
  let release;
  const stop = () => { calls.push('stop-start'); return new Promise(resolve => { release = () => { calls.push('stop-done'); resolve(true); }; }); };
  const runner = new Function('stopBackend', 'startup', 'quickWindow', 'tray',
    `let quitting = false; return { run: async () => { ${body} }, quitting: () => quitting };`)(stop,
    { dispose: () => calls.push('startup-destroyed') },
    { isDestroyed: () => false, destroy: () => calls.push('quick-destroyed') },
    { destroy: () => calls.push('tray-destroyed') });
  const task = runner.run();
  assert.equal(runner.quitting(), true);
  assert.deepEqual(calls, ['stop-start']);
  release(); await task;
  assert.deepEqual(calls, ['stop-start', 'stop-done', 'startup-destroyed', 'quick-destroyed', 'tray-destroyed']);
});

test('actual stopBackend waits for taskkill completion, is idempotent, and fails closed on OS error', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').match(/function stopBackend\(\) \{[\s\S]*?\n\}/)[0];
  for (const success of [true, false]) {
    const killer = new EventEmitter();
    const child = { pid: 4321, killed: false, exitCode: null };
    let spawned = 0;
    const spawn = (file, args, options) => {
      spawned++;
      assert.equal(file, 'taskkill');
      assert.deepEqual(args, ['/pid', '4321', '/t', '/f']);
      assert.equal(options.windowsHide, true);
      return killer;
    };
    const runner = new Function('spawn', 'process', 'initialBackend', `${source}; let stopping = false, backend = initialBackend, backendStopTask = null;
      return { stopBackend, backend: () => backend, stopping: () => stopping };`)(spawn, { platform: 'win32' }, child);
    const task = runner.stopBackend();
    assert.equal(runner.stopBackend(), task);
    assert.equal(spawned, 1);
    assert.equal(runner.backend(), child);
    assert.equal(runner.stopping(), true);
    if (success) killer.emit('exit', 0); else killer.emit('error', new Error('denied'));
    assert.equal(await task, success);
    assert.equal(runner.backend(), success ? null : child);
  }
});

test('disabling and re-enabling scheduled checks leaves manual checks usable and no duplicate timers', async () => {
  const { updater, timers, prefs, engine, calls } = fixture({ settings: { autoCheckUpdates: false, updateUrl: 'https://mirror.example.test/updates' } });
  assert.equal(timers.size, 0);
  await updater.check();
  assert.equal(calls[0][1].provider, 'generic');
  prefs.autoCheckUpdates = true;
  updater.configure(); updater.configure();
  assert.equal(timers.size, 2);
  prefs.autoCheckUpdates = false;
  updater.configure();
  assert.equal(timers.size, 0);
  engine.emit('update-downloaded', info);
  assert.equal(await updater.install(), true);
});

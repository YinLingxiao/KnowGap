const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resetLegacyData, MARKER } = require('../dataReset');

function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-reset-'));
  for (const name of files) {
    const full = path.join(dir, name);
    if (name.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, 'x'); }
  }
  const calls = [];
  const dialog = { showMessageBoxSync: (options) => { calls.push(['dialog', options.message]); return 0; } };
  const session = { clearStorageData: async () => calls.push('storage'), clearCache: async () => calls.push('cache') };
  return { dir, calls, run: () => resetLegacyData({ dir, fs, dialog, session }) };
}

test('old data is cleared once after a notice, keeping Chromium runtime entries', async () => {
  const { dir, calls, run } = setup([
    'knowgap.sqlite3', 'knowgap.sqlite3-wal', 'ai-settings.json', '.env', 'desktop-settings.json', 'port.json',
    'logs/backend.log', 'avatars/a.png', 'files/', 'Local Storage/leveldb/x', 'Cache/', 'Preferences',
  ]);
  assert.equal(await run(), 'reset');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Cache', 'Local Storage', MARKER, 'Preferences'].sort());
  assert.deepEqual(calls, [['dialog', 'KnowGap 1.0.0 会清空旧版本的全部数据'], 'storage', 'cache']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')), { version: '1.0.0' });

  fs.writeFileSync(path.join(dir, 'knowgap.sqlite3'), 'new data after reset');
  assert.equal(await run(), 'done', 'the reset runs only once');
  assert.ok(fs.existsSync(path.join(dir, 'knowgap.sqlite3')));
  assert.equal(calls.length, 3);
});

test('a fresh install shows no notice and only writes the marker', async () => {
  const { dir, calls, run } = setup(['Preferences']);
  assert.equal(await run(), 'fresh');
  assert.deepEqual(calls, []);
  assert.ok(fs.existsSync(path.join(dir, MARKER)) && fs.existsSync(path.join(dir, 'Preferences')));
});

test('startup resets before reading settings and the module is packaged', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const reset = main.indexOf('await resetLegacyData(');
  assert.ok(reset > 0 && reset < main.indexOf('loadSettings();', reset));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('dataReset.js'));
});

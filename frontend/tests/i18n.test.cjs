// Compile the message catalog and its helpers in isolation; no framework or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-i18n-'));
fs.mkdirSync(path.join(temporary, 'lib', 'i18n'), { recursive: true });
for (const relative of ['lib/i18n/messages.ts', 'lib/i18n/index.ts']) {
  fs.writeFileSync(
    path.join(temporary, relative.replace(/\.ts$/, '.js')),
    ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
  );
}
const { zh, en, translate, interpolate } = require(path.join(temporary, 'lib/i18n/index.js'));

const placeholderPattern = /\{(\w+)\}/g;
const placeholders = (value) => [...value.matchAll(placeholderPattern)].map((match) => match[1]).sort();

test('every Chinese key has an English translation with the same placeholders', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(zh)) {
    assert.ok(en[key].trim(), `missing English copy for ${key}`);
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `placeholder mismatch for ${key}`);
  }
});

test('translate picks the language and interpolates values', () => {
  assert.equal(translate('zh', 'chat.newChat'), '新对话');
  assert.equal(translate('en', 'chat.newChat'), 'New chat');
  assert.equal(translate('en', 'chat.homePlaceholderInSpace', { name: 'Japanese' }), 'What would you like to understand in “Japanese”?');
  assert.equal(translate('en', 'time.minutesAgo', { count: 3 }), '3 min ago');
});

test('interpolation keeps unknown placeholders instead of dropping them', () => {
  assert.equal(interpolate('a {known} {unknown}', { known: 'b' }), 'a b {unknown}');
});

// Compile the message catalog and its helpers in isolation; no framework or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-i18n-'));
fs.mkdirSync(path.join(temporary, 'lib', 'i18n'), { recursive: true });
for (const relative of [
  'lib/i18n/messages.ts',
  'lib/i18n/phrases.ts',
  'lib/i18n/phrases-agenda.ts',
  'lib/i18n/phrases-onboarding.ts',
  'lib/i18n/phrases-settings.ts',
  'lib/i18n/phrases-widgets.ts',
  'lib/i18n/phrases-extra.ts',
  'lib/i18n/index.ts',
]) {
  fs.writeFileSync(
    path.join(temporary, relative.replace(/\.ts$/, '.js')),
    ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
  );
}
const { zh, en, translate, interpolate, translatePhrase } = require(path.join(temporary, 'lib/i18n/index.js'));

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

test('phrase translation falls back to the catalog and keeps Chinese in Chinese mode', () => {
  assert.equal(translatePhrase('zh', '保存'), '保存');
  assert.equal(translatePhrase('en', '保存'), 'Save');
  assert.equal(translatePhrase('en', '第 {page} 页', { page: 3 }), 'p. 3');
});

test('every literal tx/tr source string has an English phrase', () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !full.includes(`${path.sep}lib${path.sep}i18n${path.sep}`)) files.push(full);
    }
  };
  walk(path.join(__dirname, '../src/components'));
  walk(path.join(__dirname, '../src/lib/agenda'));

  const missing = [];
  const pattern = /\b(?:tx|tr)\(\s*"((?:[^"\\]|\\.)*)"/g;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const text = match[1];
      if (!/[\u4e00-\u9fff]/.test(text)) continue;
      if (translatePhrase('en', text) === text) {
        missing.push(`${path.relative(path.join(__dirname, '..'), file)}: ${text}`);
      }
    }
  }
  assert.deepEqual(missing, [], `missing English phrases:\n${missing.join('\n')}`);
});

test('phrase modules do not silently disagree on a translation', () => {
  const modules = [
    'phrases.ts',
    'phrases-agenda.ts',
    'phrases-onboarding.ts',
    'phrases-settings.ts',
    'phrases-widgets.ts',
    'phrases-extra.ts',
  ];
  const seen = new Map();
  const conflicts = [];
  for (const module of modules) {
    const source = fs.readFileSync(path.join(__dirname, '../src/lib/i18n', module), 'utf8');
    for (const match of source.matchAll(/^\s*"([^"]+)":\s*"([^"]*)"/gm)) {
      const [, key, value] = match;
      const previous = seen.get(key);
      if (previous && previous.value !== value) {
        conflicts.push(`${key}\n  ${previous.module}: ${previous.value}\n  ${module}: ${value}`);
      } else if (!previous) {
        seen.set(key, { value, module });
      }
    }
  }
  assert.deepEqual(conflicts, [], `conflicting English phrases:\n${conflicts.join('\n')}`);
});

test('ambiguous catalog values have an explicit phrase translation', () => {
  const bySource = new Map();
  for (const key of Object.keys(zh)) {
    const translations = bySource.get(zh[key]) ?? new Set();
    translations.add(en[key]);
    bySource.set(zh[key], translations);
  }
  const ambiguous = [...bySource].filter(([, translations]) => translations.size > 1).map(([source]) => source);
  assert.ok(ambiguous.length > 0, 'expected some context-dependent labels');
  for (const source of ambiguous) {
    assert.notEqual(translatePhrase('en', source), source, `ambiguous source needs an explicit phrase: ${source}`);
  }
});

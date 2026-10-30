// Shared by component tests that transpile single files: provides the Chinese
// i18n context the real <LanguageProvider> would, without React state or storage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-i18n-support-'));
fs.mkdirSync(path.join(temporary, 'lib', 'i18n'), { recursive: true });
for (const file of fs.readdirSync(path.join(__dirname, '../src/lib/i18n')).filter((name) => name.endsWith('.ts'))) {
  fs.writeFileSync(
    path.join(temporary, 'lib', 'i18n', file.replace(/\.ts$/, '.js')),
    ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/i18n', file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
  );
}
const i18n = require(path.join(temporary, 'lib/i18n/index.js'));
const errors = require(path.join(temporary, 'lib/i18n/errors.js'));

const value = {
  lang: 'zh',
  setLang() {},
  t: (key, vars) => i18n.translate('zh', key, vars),
  tx: (text, vars) => i18n.translatePhrase('zh', text, vars),
};

/** Resolve the i18n-related module specifiers a transpiled component may require. */
function resolveI18n(name) {
  if (name === '@/components/LanguageProvider') return { useI18n: () => value, LanguageProvider: ({ children }) => children };
  if (name === '@/lib/i18n') return i18n;
  if (name === '@/lib/i18n/errors') return errors;
  return undefined;
}

module.exports = { i18nValue: value, resolveI18n };

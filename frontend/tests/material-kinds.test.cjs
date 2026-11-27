const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const file = path.join(__dirname, '../src/lib/materials/kinds.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const kinds = mod.exports;

test('fileExtension：小写化扩展名，忽略尾部空格，没有扩展名返回空串', () => {
  assert.equal(kinds.fileExtension('A题.DOCX'), 'docx');
  assert.equal(kinds.fileExtension('lecture.final.pdf '), 'pdf');
  assert.equal(kinds.fileExtension('README'), '');
  assert.equal(kinds.fileExtension('.gitignore'), 'gitignore');
});

test('kindFromFilename：按后缀归档，旧版 Office 归到新版类型', () => {
  const cases = {
    'a.pdf': 'pdf',
    'a.MD': 'md',
    'a.txt': 'txt',
    'a.csv': 'csv',
    'a.docx': 'docx',
    'a.doc': 'docx',
    'a.pptx': 'pptx',
    'a.ppt': 'pptx',
    'a.xlsx': 'xlsx',
    'a.xls': 'xlsx',
  };
  for (const [name, kind] of Object.entries(cases)) {
    assert.equal(kinds.kindFromFilename(name), kind, name);
  }
  assert.equal(kinds.kindFromFilename('a.exe'), null);
  assert.equal(kinds.kindFromFilename('README'), null);
  assert.equal(kinds.kindFromFilename('a.pdf.exe'), null);
});

test('isMaterialKind：只认后端资料接口的七种类型', () => {
  for (const kind of ['pdf', 'md', 'txt', 'csv', 'docx', 'pptx', 'xlsx']) {
    assert.equal(kinds.isMaterialKind(kind), true, kind);
  }
  assert.equal(kinds.isMaterialKind('doc'), false);
  assert.equal(kinds.isMaterialKind(''), false);
  assert.equal(kinds.isMaterialKind(undefined), false);
});

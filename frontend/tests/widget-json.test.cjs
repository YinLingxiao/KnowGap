// Tolerant widget JSON parsing: punctuation repair for finished blocks, best-effort closing for streaming previews.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/chat/widgetJson.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const { parseWidgetJson, parsePartialWidgetJson } = mod.exports;

test('valid widget JSON parses unchanged', () => {
  assert.deepEqual(parseWidgetJson('{"type":"micro_quiz","title":"栈"}'), { type: 'micro_quiz', title: '栈' });
});

test('unescaped inner quotes inside string values are repaired', () => {
  const raw = '{"type":"step_simulator","title":"理解"后进先出"规则","steps":[]}';
  assert.equal(parseWidgetJson(raw).title, '理解"后进先出"规则');
  const withColon = '{"type":"comparison_matrix","values":["标签 "a": [1, 2]","而"关闭受控源"这条错误规则"]}';
  assert.deepEqual(parseWidgetJson(withColon).values, ['标签 "a": [1, 2]', '而"关闭受控源"这条错误规则']);
});

test('trailing commas and raw newlines inside strings are repaired', () => {
  const raw = '{"type":"code_playground","scaffold":"def f():\n    ___",\n"test_cases":[{"input":"1",},],}';
  const parsed = parseWidgetJson(raw);
  assert.equal(parsed.scaffold, 'def f():\n    ___');
  assert.deepEqual(parsed.test_cases, [{ input: '1' }]);
});

test('commas and brackets inside strings are data, not punctuation', () => {
  assert.equal(parseWidgetJson('{"type":"x","note":"a, } and , ]",}').note, 'a, } and , ]');
});

test('truncated streaming blocks and non-widgets stay null', () => {
  assert.equal(parseWidgetJson('{"type":"micro_quiz","title":"栈'), null);
  assert.equal(parseWidgetJson('{"title":"no type"}'), null);
  assert.equal(parseWidgetJson('[{"type":"x"}]'), null);
  assert.equal(parseWidgetJson(''), null);
});

test('streaming preview keeps an unfinished string value and closes the brackets', () => {
  assert.deepEqual(parsePartialWidgetJson('{"type":"step_simulator","steps":[{"label":"压入","detail":"把 1 放'), {
    type: 'step_simulator', steps: [{ label: '压入', detail: '把 1 放' }],
  });
});

test('streaming preview drops an unfinished key, number or literal', () => {
  assert.deepEqual(parsePartialWidgetJson('{"type":"micro_quiz","question":"栈","opti'), { type: 'micro_quiz', question: '栈' });
  assert.deepEqual(parsePartialWidgetJson('{"type":"micro_quiz","question":"栈","answerIndex":1'), { type: 'micro_quiz', question: '栈' });
  assert.deepEqual(parsePartialWidgetJson('{"type":"micro_quiz","options":["A","B",'), { type: 'micro_quiz', options: ['A', 'B'] });
  assert.deepEqual(parsePartialWidgetJson('{"type":"x","ok":tr'), { type: 'x' });
});

test('streaming preview handles escapes and needs an object with a type', () => {
  assert.equal(parsePartialWidgetJson('{"type":"x","t":"a\\').t, 'a');
  assert.equal(parsePartialWidgetJson('{"type":"x","t":"say \\"hi').t, 'say "hi');
  assert.equal(parsePartialWidgetJson('{"title":"no type"'), null);
  assert.equal(parsePartialWidgetJson('{"typ'), null);
  assert.equal(parsePartialWidgetJson('not json'), null);
});

// 流式平滑显示时，已开始的卡片直接跳到 full 中的当前完整内容，但结果必须仍是 full 的前缀。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/chat/smoothWidgets.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const { fastForwardWidgets } = mod.exports;

function upTo(text, marker) {
  const at = text.indexOf(marker);
  assert.notEqual(at, -1, `测试文本缺少标记 ${marker}`);
  return text.slice(0, at);
}

test('没有卡片时原样返回', () => {
  assert.equal(fastForwardWidgets('', ''), '');
  assert.equal(fastForwardWidgets('普通正文', '普通正文'), '普通正文');
  assert.equal(fastForwardWidgets('普通', '普通正文'), '普通');
  const full = '说明\n```ts\nconst a = 1;\n```\n继续';
  const shown = '说明\n```ts\nconst a = 1;\n';
  assert.equal(fastForwardWidgets(shown, full), shown);
});

test('卡片刚开始就跳到 full 里的完整卡片', () => {
  const full = ['前言', '```knowgap-widget', '{"type":"micro_quiz"}', '```', '后文'].join('\n');
  const expected = upTo(full, '```\n后文') + '```';
  assert.equal(fastForwardWidgets('前言\n```knowgap-widget', full), expected);
  assert.equal(fastForwardWidgets('前言\n```knowgap-widget\n{"type":"micro_quiz"}\n``', full), expected);
  // 语言名还没写完时不能认定是卡片
  assert.equal(fastForwardWidgets('前言\n```knowgap-wid', full), '前言\n```knowgap-wid');
});

test('语言名恰好是卡片前缀但 full 继续扩展时不会误判', () => {
  const full = '```knowgap-widget-extra\n{"type":"micro_quiz"}\n```\n后文';
  assert.equal(fastForwardWidgets('```knowgap-widget', full), '```knowgap-widget');
});

test('未闭合三反引号卡片直接放出 full 中已有内容，波浪线和更长围栏保持原样', () => {
  const full = '```widget\n{"type":"step_simulator","steps":[';
  assert.equal(fastForwardWidgets('```widget\n{"type"', full), full);
  assert.equal(fastForwardWidgets('```widget', full), full);
  const tilde = '~~~knowgap-visual\n{"type":"diagram"}';
  const tildeShown = '~~~knowgap-visual\n{"type"';
  assert.equal(fastForwardWidgets(tildeShown, tilde), tildeShown);
  const longer = '````knowgap-widget\n{"type":"micro_quiz"}\n````\n后文';
  const longerShown = '````knowgap-widget\n{"type"';
  assert.equal(fastForwardWidgets(longerShown, longer), longerShown);
});

test('已闭合卡片只带到闭合围栏，不提前放出后面的正文', () => {
  const full = 'A\n```knowgap-widget\n{"a":1}\n```\nB';
  const shown = 'A\n```knowgap-widget\n{"a"';
  const result = fastForwardWidgets(shown, full);
  assert.equal(result, 'A\n```knowgap-widget\n{"a":1}\n```');
  assert.ok(!result.includes('\nB'));
});

test('两个卡片依次开始时保留中间正文并对齐到第二个卡片', () => {
  const full = [
    'A', '```widget', '{"a":1}', '```', '中间',
    '```knowgap-visual', '{"b":2}', '```', '尾',
  ].join('\n');
  const shown = 'A\n```widget\n{"a":1}\n```\n中间\n```knowgap-visual\n{"b":';
  assert.equal(fastForwardWidgets('A\n```widget\n{"a":1}\n```', full), 'A\n```widget\n{"a":1}\n```');
  const result = fastForwardWidgets(shown, full);
  assert.equal(result, upTo(full, '```\n尾') + '```');
  assert.ok(result.includes('中间'));
  assert.ok(!result.includes('尾'));
});

test('普通围栏里的伪卡片文字不会被视为卡片', () => {
  const full = [
    '```text', '示例：', '```knowgap-widget', '{"fake":true}', '```',
    '```knowgap-widget', '{"real":true}', '```', '后文',
  ].join('\n');
  const inside = '```text\n示例：\n```knowgap-widget\n{"fake":true}';
  assert.equal(fastForwardWidgets(inside, full), inside);
  const atReal = '```text\n示例：\n```knowgap-widget\n{"fake":true}\n```\n```knowgap-widget';
  assert.equal(fastForwardWidgets(atReal, full), upTo(full, '```\n后文') + '```');
  const longer = ['````text', '```knowgap-widget', '{"fake":true}', '```', '````', '后文'].join('\n');
  const longerInside = '````text\n```knowgap-widget\n{"fake":true}';
  assert.equal(fastForwardWidgets(longerInside, longer), longerInside);
  const tilde = ['~~~text', '```knowgap-widget', '{"fake":true}', '```', '~~~', '后文'].join('\n');
  const tildeInside = '~~~text\n```knowgap-widget\n{"fake":true}';
  assert.equal(fastForwardWidgets(tildeInside, tilde), tildeInside);
});

test('每个字符前缀的结果都仍然是 full 的前缀', () => {
  const fixtures = [
    ['A', '```knowgap-widget', '{"a":1}', '```', 'B'].join('\n'),
    '```widget\n{"type":"step_simulator","steps":[',
    ['```text', '```knowgap-widget', '{"fake":true}', '```', '```', '```widget', '{"x":2}', '```', '后'].join('\n'),
    'A\r\n```knowgap-visual\r\n{"b":2}\r\n```\r\n后',
    '```knowgap-widget-extra\n{}\n```\n后',
    '````knowgap-widget\n{"a":1}\n````\n后',
  ];
  for (const full of fixtures) {
    for (let i = 0; i <= full.length; i += 1) {
      const shown = full.slice(0, i);
      const result = fastForwardWidgets(shown, full);
      assert.ok(full.startsWith(result), `前缀 ${i} 的结果不是 full 的前缀：${JSON.stringify(result)}`);
    }
  }
});

test('shown 不是 full 前缀时保持原样', () => {
  assert.equal(fastForwardWidgets('abc', 'abd'), 'abc');
  assert.equal(fastForwardWidgets('```knowgap-widget\n{}', '```widget\n{}'), '```knowgap-widget\n{}');
});

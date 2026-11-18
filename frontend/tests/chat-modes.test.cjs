// The mode selector and the request body must use the same wire values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-modes-'));
const source = path.join(__dirname, '../src/lib/chat/modes.ts');
const output = path.join(temporary, 'modes.js');
fs.writeFileSync(output, ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText);
const { CHAT_MODE_OPTIONS } = require(output);

test('the six labels map to the six backend mode values in order', () => {
  assert.deepEqual(CHAT_MODE_OPTIONS.map((option) => option.id), [
    'explain', 'solve', 'practice', 'plan', 'research', 'organize',
  ]);
  assert.deepEqual(CHAT_MODE_OPTIONS.map((option) => option.labelKey), [
    'chat.mode.explain', 'chat.mode.solve', 'chat.mode.practice',
    'chat.mode.plan', 'chat.mode.research', 'chat.mode.organize',
  ]);
});
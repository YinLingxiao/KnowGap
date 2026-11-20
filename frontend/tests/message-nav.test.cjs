// The question navigator pairs each question with the start of its answer, locally.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-message-nav-'));
const source = path.join(__dirname, '../src/lib/chat/messageNav.ts');
const output = path.join(temporary, 'messageNav.js');
fs.writeFileSync(output, ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText);
const { navTurns, answerPreview, hasQuizCard } = require(output);

const msg = (id, role, content, kind = 'text') => ({ id, role, kind, content });
const quiz = '```knowgap-widget\n{"type": "micro_quiz", "question": "栈顶在哪？"}\n```';

test('each question gets the first text answer before the next question', () => {
  const turns = navTurns([
    msg('u1', 'user', '栈是什么？'),
    msg('a1', 'assistant', '## 栈\n**后进先出**的线性表。'),
    msg('a1b', 'assistant', '补充一句'),
    msg('u2', 'user', '考考我'),
    msg('a2', 'assistant', `来一道：\n${quiz}`),
    msg('u3', 'user', '还没回答的提问'),
  ], () => true, (m) => m.content);
  assert.deepEqual(turns.map((t) => [t.id, t.answer, t.hasQuiz]), [
    ['u1', '栈 后进先出的线性表。', false],
    ['u2', '来一道：', true],
    ['u3', '', false],
  ]);
});

test('hidden user messages are skipped and do not borrow the next answer', () => {
  const turns = navTurns([
    msg('u1', 'user', '第一问'),
    msg('a1', 'assistant', '第一答'),
    msg('sys', 'user', '[系统事件]'),
    msg('a2', 'assistant', '回应系统事件'),
  ], (m) => m.id !== 'sys', (m) => m.content);
  assert.deepEqual(turns.map((t) => [t.id, t.answer]), [['u1', '第一答']]);
});

test('answer previews drop cards, code, formulas and links, and are capped', () => {
  const text = `看[这篇](https://x.test)和公式 $$a^2$$\n\`\`\`python\nprint(1)\n\`\`\`\n${quiz}\n- 要点一\n> 引用`;
  assert.equal(answerPreview(text), '看这篇和公式 要点一 引用');
  assert.equal(answerPreview('字'.repeat(200), 10), `${'字'.repeat(10)}…`);
  assert.equal(hasQuizCard(quiz), true);
  assert.equal(hasQuizCard('```knowgap-widget\n{"type": "step_simulator"}\n```'), false);
});

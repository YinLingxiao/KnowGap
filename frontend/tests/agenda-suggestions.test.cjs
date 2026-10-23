const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-agenda-model-'));
const dir = path.join(__dirname, '../src');
function emit(rel, out) {
  let source = fs.readFileSync(path.join(dir, rel), 'utf8');
  source = source.replaceAll('from "@/lib/agenda/quickAdd"', 'from "./quickAdd"');
  source = source.replaceAll('from "@/lib/agenda/types"', 'from "./types"');
  source = source.replaceAll('from "./types"', 'from "./types"');
  fs.writeFileSync(path.join(temp, out), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText);
}
emit('lib/agenda/types.ts', 'types.js');
emit('lib/agenda/quickAdd.ts', 'quickAdd.js');
emit('components/agenda/agendaModel.ts', 'agendaModel.js');
const { buildTodaySuggestions, completedOn } = require(path.join(temp, 'agendaModel.js'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const task = (partial) => ({
  id: 't', title: '任务', notes: '', parentId: null, priority: 3, labels: [],
  subjectId: null, threadId: null, scheduledDate: null, scheduledStartAt: null,
  durationMinutes: null, deadlineDate: null, reminderMinutes: null,
  status: 'open', completedAt: null, source: 'manual', memoryId: null,
  reviewStep: null, sortOrder: 0, createdAt: '2026-10-20T00:00:00', updatedAt: '2026-10-20T00:00:00',
  ...partial,
});

const TODAY = '2026-10-24';

test('completedOn counts tasks finished on that local day', () => {
  const tasks = [
    task({ id: 'a', status: 'done', completedAt: '2026-10-24T09:00:00' }),
    task({ id: 'b', status: 'done', completedAt: '2026-10-23T23:00:00' }),
    task({ id: 'c', status: 'open', completedAt: null }),
    task({ id: 'd', status: 'cancelled', completedAt: '2026-10-24T12:00:00' }),
  ];
  assert.equal(completedOn(tasks, TODAY), 1);
  assert.equal(completedOn(tasks, '2026-10-23'), 1);
});

test('buildTodaySuggestions offers inbox, a near task, and an empty deadline space', () => {
  const tasks = [
    task({ id: 'inbox', title: '还没排的' }),
    task({ id: 'soon', title: '后天的', scheduledDate: '2026-10-26' }),
    task({ id: 'far', title: '很后面', scheduledDate: '2026-11-20' }),
    task({ id: 'owned', title: '已有任务', subjectId: 'busy', scheduledDate: '2026-10-28' }),
  ];
  const subjects = [
    { id: 'empty', name: '电路原理', deadline: '2026-10-30' },
    { id: 'busy', name: '高数', deadline: '2026-10-28' },
    { id: 'late', name: '英语', deadline: '2026-12-01' },
  ];
  const suggestions = buildTodaySuggestions(tasks, subjects, TODAY);
  assert.equal(suggestions.length, 3);
  assert.deepEqual(suggestions.map((item) => item.kind), ['inbox', 'pull', 'breakdown']);
  assert.equal(suggestions[0].taskId, 'inbox');
  assert.equal(suggestions[1].taskId, 'soon');
  assert.equal(suggestions[2].subjectId, 'empty');
});

test('buildTodaySuggestions stays within three and skips spaces that already have tasks', () => {
  const tasks = [task({ id: 'inbox', title: '收件' })];
  const subjects = [
    { id: 'a', name: '甲', deadline: '2026-10-25' },
    { id: 'b', name: '乙', deadline: '2026-10-26' },
    { id: 'c', name: '丙', deadline: '2026-10-27' },
  ];
  const suggestions = buildTodaySuggestions(tasks, subjects, TODAY);
  assert.equal(suggestions.length, 3);
  assert.deepEqual(suggestions.map((item) => item.subjectId), [null, 'a', 'b']);
});

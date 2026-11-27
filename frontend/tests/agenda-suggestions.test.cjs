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
  sortOrder: 0, createdAt: '2026-10-20T00:00:00', updatedAt: '2026-10-20T00:00:00',
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

test('buildTodaySuggestions offers the inbox task and a task within a week', () => {
  const tasks = [
    task({ id: 'inbox', title: '还没排的' }),
    task({ id: 'soon', title: '后天的', scheduledDate: '2026-10-26' }),
    task({ id: 'far', title: '很后面', scheduledDate: '2026-11-20' }),
  ];
  const suggestions = buildTodaySuggestions(tasks, TODAY);
  assert.deepEqual(suggestions.map((item) => [item.kind, item.taskId]), [['inbox', 'inbox'], ['pull', 'soon']]);
});

test('buildTodaySuggestions takes deadlines only from tasks, never from learning spaces', () => {
  // 学习空间不再有截止日期：没有任务时不会凭空建议「某空间快截止了」。
  assert.deepEqual(buildTodaySuggestions([], TODAY), []);
  // 只有截止日期、还没排期的任务：7 天内截止就建议排一下
  const tasks = [
    task({ id: 'due', title: '交报告', scheduledDate: null, deadlineDate: '2026-10-27' }),
    task({ id: 'later', title: '期末论文', scheduledDate: null, deadlineDate: '2026-12-20' }),
  ];
  const suggestions = buildTodaySuggestions(tasks, TODAY);
  assert.deepEqual(suggestions.map((item) => [item.kind, item.taskId]), [['due', 'due']]);
  assert.match(suggestions[0].detail, /截止，还没排期/);
});

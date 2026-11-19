// Contract tests for the still-pending multi-agent learning-plan endpoints.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-learning-plan-'));
for (const name of ['lib/config.ts', 'lib/api/errors.ts', 'lib/api/http-client.ts', 'lib/chat/learningPlan.ts', 'lib/agenda/api.ts']) {
  const output = path.join(temp, name.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  let js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  js = js.replace(/require\("@\/([^"]+)"\)/g, (_, specifier) => {
    const relative = path.relative(path.dirname(output), path.join(temp, specifier + '.js')).replace(/\\/g, '/');
    return `require("./${relative}")`;
  });
  fs.writeFileSync(output, js);
}
const { learningPlanApi, mapDraft, mapTaskDraft } = require(path.join(temp, 'lib/chat/learningPlan.js'));
const { mapTask } = require(path.join(temp, 'lib/agenda/api.js'));

const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; fs.rmSync(temp, { recursive: true, force: true }); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const draftWire = {
  draft_id: 'plan_1',
  agents: [
    { agent: 'review', output: { approved: ['d1'], rejected: [{ draft_task_id: 'd2', code: 'duplicate', message: '与 d1 依据相同' }], total_minutes: 30 } },
    { agent: 'other', output: {} },
    { agent: 'plan', output: { tasks: [{ draft_task_id: 'd1', title: '栈练习', memory_id: 'mem_1', evidence: 'mem_1：栈溢出', duration_minutes: 30, scheduled_date: '2026-11-21', order: 2 }] } },
    { agent: 'diagnose', output: { weak_points: [{ memory_id: 'mem_1', topic: '栈溢出', summary: '越界写成溢出', due: '2026-11-21', priority: 1 }] } },
  ],
  tasks: [
    { draft_task_id: 'd1', title: '栈练习', memory_id: 'mem_1', evidence: 'mem_1：栈溢出', duration_minutes: 30, scheduled_date: '2026-11-21', order: 2 },
    { draft_task_id: '', title: '坏任务' },
  ],
};

test('draft mapping keeps the diagnose → plan → review order and optional fields', () => {
  const draft = mapDraft(draftWire);
  assert.equal(draft.draftId, 'plan_1');
  assert.deepEqual(draft.agents.map((agent) => agent.agent), ['diagnose', 'plan', 'review']);
  assert.equal(draft.agents[0].output.kind, 'diagnose');
  assert.equal(draft.agents[0].output.weakPoints[0].topic, '栈溢出');
  assert.equal(draft.agents[1].output.tasks[0].draftTaskId, 'd1');
  assert.equal(draft.agents[2].output.totalMinutes, 30);
  assert.equal(draft.agents[2].output.rejected[0].message, '与 d1 依据相同');
  assert.equal(draft.tasks.length, 1);
  assert.equal(draft.tasks[0].memoryId, 'mem_1');
  assert.equal(draft.tasks[0].durationMinutes, 30);
});

test('missing optional fields and unknown agents do not throw', () => {
  const draft = mapDraft({ agents: [{ agent: 'plan', output: {} }], tasks: [{}] });
  assert.equal(draft.draftId, '');
  assert.deepEqual(draft.agents[0].output.tasks, []);
  assert.deepEqual(draft.tasks, []);
  assert.equal(mapTaskDraft({ draft_task_id: 'x', title: '任务' }).durationMinutes, null);
});

test('draft request sends snake_case budget and deadline', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return json(draftWire);
  };
  const draft = await learningPlanApi.draft({ subjectId: 'sub/os', budgetMinutes: 90, deadline: '2026-11-24' });
  assert.equal(draft.draftId, 'plan_1');
  assert.ok(calls[0].url.endsWith('/api/learning/plans/draft'));
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { subject_id: 'sub/os', budget_minutes: 90, deadline: '2026-11-24' });
});

test('confirmation sends only selected task ids and maps created/skipped tasks', async () => {
  global.fetch = async (url, options) => {
    assert.ok(url.endsWith('/api/learning/plans/plan%2F1/confirm'));
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { task_ids: ['d1'] });
    return json({
      created: [{ id: 'task_5b', title: '栈练习', source: 'learning_agent', duration_minutes: 30 }],
      skipped: [{ draft_task_id: 'd2', code: 'already_confirmed', message: '该任务已经写入日程' }],
    });
  };
  const result = await learningPlanApi.confirm('plan/1', ['d1']);
  assert.deepEqual(result.created, [{ id: 'task_5b', title: '栈练习', source: 'learning_agent', durationMinutes: 30 }]);
  assert.deepEqual(result.skipped, ['d2']);
});

test('confirmation surfaces the backend failure detail', async () => {
  global.fetch = async () => json({ detail: '草稿已过期' }, 404);
  await assert.rejects(learningPlanApi.confirm('plan_1', ['d1']), /草稿已过期/);
});

test('agenda task mapping keeps learning_agent instead of downgrading it to manual', () => {
  const task = mapTask({ id: 't1', title: '复习', source: 'learning_agent', memory_id: 'mem_1', duration_minutes: 30 });
  assert.equal(task.source, 'learning_agent');
  assert.equal(task.memoryId, 'mem_1');
  assert.equal(mapTask({ id: 't2', title: '手动', source: 'unknown' }).source, 'manual');
});
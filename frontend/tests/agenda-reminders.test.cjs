const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const mod = { exports: {} };
new Function('exports', ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../src/lib/agenda/reminders.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText)(mod.exports);
const { reminderTime, reminderKey, reminderDelay, reminderBody, REMINDER_CATCHUP_MS, REMINDER_HORIZON_MS } = mod.exports;
const task = { id: 'task-one', status: 'open', scheduledStartAt: '2026-10-22T10:00', reminderMinutes: 10 };
const at = new Date(2026, 9, 22, 9, 50).getTime();

test('local reminder time, on-time zero and disabled states', () => {
  assert.equal(reminderTime(task), at);
  assert.equal(reminderTime({ ...task, reminderMinutes: 0 }), at + 600_000);
  assert.equal(reminderTime({ ...task, reminderMinutes: 1440 }), at + 600_000 - 86_400_000);
  for (const change of [{ scheduledStartAt: null }, { reminderMinutes: null }, { status: 'done' }, { status: 'cancelled' }, { scheduledStartAt: 'invalid' }]) {
    assert.equal(reminderTime({ ...task, ...change }), null);
  }
});

test('24 hour horizon and inclusive ten minute catch-up window', () => {
  const seen = new Set();
  assert.equal(reminderDelay(task, at - REMINDER_HORIZON_MS, seen), REMINDER_HORIZON_MS);
  assert.equal(reminderDelay(task, at - REMINDER_HORIZON_MS - 1, seen), null);
  assert.equal(reminderDelay(task, at, seen), 0);
  assert.equal(reminderDelay(task, at + REMINDER_CATCHUP_MS, seen), 0);
  assert.equal(reminderDelay(task, at + REMINDER_CATCHUP_MS + 1, seen), null);
});

test('persisted task + time keys deduplicate reloads but allow rescheduling', () => {
  const restored = new Set(JSON.parse(JSON.stringify([reminderKey(task.id, at)])));
  assert.equal(reminderDelay(task, at, restored), null);
  assert.equal(reminderDelay({ ...task, id: 'another-task' }, at, restored), 0);
  assert.equal(reminderDelay({ ...task, reminderMinutes: 5 }, at, restored), 300_000);
});

test('notification copy names time, duration, space and click action', () => {
  assert.equal(reminderBody({ ...task, durationMinutes: 45 }, '电路原理'), '10:00 开始 · 45 分钟 · 电路原理\n点击开始专注');
  assert.equal(reminderBody({ ...task, durationMinutes: null }), '10:00 开始 · 未归入空间\n点击开始专注');
});

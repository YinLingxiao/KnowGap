// The memory page groups notes and knowledge points into Claude-style rows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-memory-groups-'));
const source = path.join(__dirname, '../src/lib/chat/memoryGroups.ts');
const output = path.join(temporary, 'memoryGroups.js');
fs.writeFileSync(output, ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText);
const { userRows, environmentRow, topicRows, userNotesWithout, splitEntries } = require(output);

const notes = splitEntries([
  '[Identity] 称呼：小林', '[Identity] 先验技能：C语言、高等数学',
  '[Preference] 讲解偏好：先举例', '学习特点：看图快（推断）', '[Context] 阶段目标：下周三考数据结构',
].join('\n§\n'));

test('user notes split into profile, preferences and goals with prefixes stripped', () => {
  const rows = userRows(notes, '2026-11-20T00:00:00Z');
  assert.deepEqual(rows.map((r) => [r.id, r.details]), [
    ['profile', ['称呼：小林', '先验技能：C语言、高等数学']],
    ['preferences', ['讲解偏好：先举例', '学习特点：看图快（推断）']],
    ['goals', ['阶段目标：下周三考数据结构']],
  ]);
  assert.deepEqual(userRows([], null).map((r) => r.id), ['profile'], 'empty groups other than the profile are hidden');
  assert.equal(environmentRow([], null), null);
  assert.deepEqual(environmentRow(['资料位置：D:\\课程'], null).details, ['资料位置：D:\\课程']);
});

test('deleting a group keeps the name and every other group', () => {
  assert.deepEqual(userNotesWithout('profile', notes), [
    '[Identity] 称呼：小林', '[Preference] 讲解偏好：先举例', '学习特点：看图快（推断）', '[Context] 阶段目标：下周三考数据结构',
  ]);
  assert.deepEqual(userNotesWithout('preferences', notes).length, 3);
});

test('knowledge points group by space in space order, general last, newest first', () => {
  const m = (id, subjectId, updatedAt, extra = {}) => ({
    id, subjectId, updatedAt, kind: 'misconception', status: 'suspected', topic: id, summary: `${id} 概要`, ...extra,
  });
  const rows = topicRows([
    m('通用点', null, '2026-11-01'),
    m('栈', 's2', '2026-11-02'),
    m('队列', 's2', '2026-11-05', { kind: 'mastery', status: 'observed' }),
    m('偏好', 's1', '2026-11-06', { kind: 'preference' }),
    m('电路', 's1', '2026-11-03', { status: 'improving' }),
  ], ['s1', 's2', 's3']);
  assert.deepEqual(rows.map((r) => [r.id, r.details, r.updatedAt]), [
    ['topic:s1', ['电路'], '2026-11-03'],
    ['topic:s2', ['队列', '栈'], '2026-11-05'],
    ['topic:general', ['通用点'], '2026-11-01'],
  ]);
  assert.deepEqual(rows[1].points.map((p) => p.state), ['mastered', 'review']);
  assert.equal(rows[0].points[0].state, 'improving');
});

test('the approval switch saves only its own setting', () => {
  const pane = fs.readFileSync(path.join(__dirname, '../src/components/settings/MemorySettingsPane.tsx'), 'utf8');
  assert.match(pane, /saveMemoryApproval\(/);
  assert.doesNotMatch(pane, /saveAgentSettings\(/, 'saving the full settings could wipe workspace and auto-approve');
});

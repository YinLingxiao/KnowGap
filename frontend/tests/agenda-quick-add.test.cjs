// Exercise the real quick-add parser (transpiled from TypeScript) without extra test dependencies.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-quick-add-'));
const output = path.join(temp, 'quickAdd.js');
fs.writeFileSync(output, ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../src/lib/agenda/quickAdd.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText);
const { parseQuickAdd, quickAddToInput } = require(output);
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// 2026-10-21 周三、10-19 周一、10-25 周日、10-31 周六（月底）、12-31 周四（年底）
const WED = new Date(2026, 9, 21, 10, 0);
const MON = new Date(2026, 9, 19, 9, 0);
const SUN = new Date(2026, 9, 25, 9, 0);
const MONTH_END = new Date(2026, 9, 31, 23, 30);
const YEAR_END = new Date(2026, 11, 31, 8, 0);
const NOV_5 = new Date(2026, 10, 5, 12, 0);
const SUBJECTS = [{ id: 's-circuit', name: '电路原理' }, { id: 's-math', name: 'Calculus' }];

const parse = (text, now = WED, subjects = SUBJECTS, ignored = []) => parseQuickAdd(text, now, subjects, ignored);
const date = (text, now = WED) => parse(text, now).fields.scheduledDate;
const deadline = (text, now = WED) => parse(text, now).fields.deadlineDate;
const start = (text, now = WED) => parse(text, now).fields.scheduledStartAt;
const minutes = (text) => parse(text).fields.durationMinutes;

test('reminders are separate from duration, retain offsets and map to input', () => {
  const text = '明天15:00 复习 45分钟 提醒我提前 30 分钟';
  const result = parse(text);
  assert.equal(result.title, '复习');
  assert.equal(result.fields.durationMinutes, 45);
  assert.equal(result.fields.reminderMinutes, 30);
  assert.equal(quickAddToInput(result.fields).reminderMinutes, 30);
  const token = result.tokens.find(item => item.field === 'reminderMinutes');
  assert.equal(text.slice(token.start, token.end), '提醒我提前 30 分钟');
  const cancelled = parse(text, WED, SUBJECTS, [token.key]);
  assert.equal(cancelled.fields.reminderMinutes, undefined);
  assert.equal(cancelled.fields.durationMinutes, 45);
  assert.ok(cancelled.title.includes('提醒我提前 30 分钟'));
});

test('supported reminder offsets, zero, and unsupported values', () => {
  for (const value of [5, 10, 15, 30, 60, 120]) {
    assert.equal(parse(`复习 提醒我提前 ${value} 分钟`).fields.reminderMinutes, value);
  }
  assert.equal(parse('复习 提醒我提前1天').fields.reminderMinutes, 1440);
  assert.equal(parse('复习 提醒提前2小时').fields.reminderMinutes, 120);
  assert.equal(quickAddToInput(parse('复习 提醒我准时').fields).reminderMinutes, 0);
  const unsupported = parse('复习 提醒我提前25分钟');
  assert.equal(unsupported.title, '复习 提醒我提前25分钟');
  assert.equal(unsupported.fields.durationMinutes, null);
  assert.equal(unsupported.fields.reminderMinutes, undefined);
  assert.equal(parse('复习 提醒我提前30分钟').fields.scheduledStartAt, null);
});

test('weekend means this Saturday, or today on Sunday', () => {
  assert.equal(date('本周末 复习'), '2026-10-24');
  assert.equal(date('这周末 复习', MONTH_END), '2026-10-31');
  assert.equal(date('周末 复习', SUN), '2026-10-25');
});

test('the full example resolves every field and leaves only the title', () => {
  const result = parse('明天下午3点 复习戴维南定理 #电路原理 p1 45分钟');
  assert.equal(result.title, '复习戴维南定理');
  assert.deepEqual(result.fields, {
    title: '复习戴维南定理',
    priority: 1,
    labels: [],
    subjectId: 's-circuit',
    scheduledDate: '2026-10-22',
    scheduledStartAt: '2026-10-22T15:00',
    durationMinutes: 45,
    deadlineDate: null,
  });
  assert.deepEqual(result.tokens.map((token) => token.kind), ['date', 'time', 'subject', 'priority', 'duration']);
});

test('plain text stays a plain title with defaults', () => {
  const result = parse('  整理错题本  ');
  assert.equal(result.title, '整理错题本');
  assert.deepEqual(result.tokens, []);
  assert.equal(result.fields.priority, 4);
  assert.equal(result.fields.scheduledDate, null);
  assert.equal(result.fields.scheduledStartAt, null);
  assert.equal(parse('').title, '');
  assert.equal(parse('   ').title, '');
  assert.equal(parse('明天').title, '');
});

test('relative day words', () => {
  assert.equal(date('今天 复习'), '2026-10-21');
  assert.equal(date('明天 复习'), '2026-10-22');
  assert.equal(date('后天 复习'), '2026-10-23');
  assert.equal(date('大后天 复习'), '2026-10-24');
  assert.equal(date('复习 明天'), '2026-10-22');
});

test('relative days cross month and year boundaries', () => {
  assert.equal(date('明天', MONTH_END), '2026-11-01');
  assert.equal(date('后天', MONTH_END), '2026-11-02');
  assert.equal(date('大后天', MONTH_END), '2026-11-03');
  assert.equal(date('明天', YEAR_END), '2027-01-01');
  assert.equal(date('后天', YEAR_END), '2027-01-02');
});

test('weekday names pick the next occurrence and keep today when it matches', () => {
  assert.equal(date('周五 复习'), '2026-10-23');
  assert.equal(date('周三 复习'), '2026-10-21');
  assert.equal(date('周一 复习'), '2026-10-26');
  assert.equal(date('星期六 复习'), '2026-10-24');
  assert.equal(date('礼拜日 复习'), '2026-10-25');
  assert.equal(date('周天 复习'), '2026-10-25');
});

test('a weekday on that very day resolves to today, not next week', () => {
  assert.equal(date('周一 复习', MON), '2026-10-19');
  assert.equal(date('周日 复习', SUN), '2026-10-25');
  assert.equal(date('周六 复习', MONTH_END), '2026-10-31');
});

test('weeks are Monday-first so Sunday still belongs to the current week', () => {
  assert.equal(date('周一 复习', SUN), '2026-10-26');
  assert.equal(date('周日 复习', WED), '2026-10-25');
  assert.equal(date('本周日 复习', WED), '2026-10-25');
  assert.equal(date('本周一 复习', WED), '2026-10-19');
});

test('下周X jumps into the following Monday-to-Sunday week', () => {
  assert.equal(date('下周一 复习', WED), '2026-10-26');
  assert.equal(date('下周三 复习', WED), '2026-10-28');
  assert.equal(date('下周日 复习', WED), '2026-11-01');
  assert.equal(date('下周一 复习', MON), '2026-10-26');
  assert.equal(date('下周日 复习', MON), '2026-11-01');
  assert.equal(date('下周一 复习', SUN), '2026-10-26');
  assert.equal(date('下周日 复习', SUN), '2026-11-01');
  assert.equal(date('下周二 复习', YEAR_END), '2027-01-05');
});

test('month and day dates, rolling to next year when already past', () => {
  assert.equal(date('10月25日 复习'), '2026-10-25');
  assert.equal(date('10月21日 复习'), '2026-10-21');
  assert.equal(date('11月3号 复习'), '2026-11-03');
  assert.equal(date('10月5日 复习'), '2027-10-05');
  assert.equal(date('1月2日 复习', YEAR_END), '2027-01-02');
  assert.equal(date('2026-11-05 复习'), '2026-11-05');
});

test('invalid calendar dates are left in the title', () => {
  const result = parse('2月30日 交报告');
  assert.equal(result.fields.scheduledDate, null);
  assert.equal(result.title, '2月30日 交报告');
  assert.equal(date('2026-02-30 交报告'), null);
});

test('day-of-month numbers pick this month or the next valid one', () => {
  assert.equal(date('25号 复习'), '2026-10-25');
  assert.equal(date('21号 复习'), '2026-10-21');
  assert.equal(date('20号 复习'), '2026-11-20');
  assert.equal(date('31号 复习'), '2026-10-31');
  assert.equal(date('31号 复习', NOV_5), '2026-12-31');
  assert.equal(date('3号 复习', YEAR_END), '2027-01-03');
});

test('words that merely look like dates are not parsed', () => {
  assert.equal(parse('整理上周一的笔记').fields.scheduledDate, null);
  assert.equal(parse('每周一复习').fields.scheduledDate, null);
  assert.equal(parse('周围环境分析').fields.scheduledDate, null);
  assert.equal(parse('去3号楼自习').fields.scheduledDate, null);
  assert.equal(parse('去3号楼自习').title, '去3号楼自习');
});

test('time of day with periods, half hours and 24-hour clock', () => {
  assert.equal(start('上午9点 复习'), '2026-10-21T09:00');
  assert.equal(start('下午3点 复习'), '2026-10-21T15:00');
  assert.equal(start('晚上8点半 复习'), '2026-10-21T20:30');
  assert.equal(start('晚上7:15 复习'), '2026-10-21T19:15');
  assert.equal(start('中午12点 吃饭'), '2026-10-21T12:00');
  assert.equal(start('凌晨12点 复习'), '2026-10-21T00:00');
  assert.equal(start('14:30 复习'), '2026-10-21T14:30');
  assert.equal(start('9点 复习'), '2026-10-21T09:00');
  assert.equal(start('下午3点15分 复习'), '2026-10-21T15:15');
  assert.equal(start('20：00 复习'), '2026-10-21T20:00');
});

test('a time without a date schedules today, and a date without a time has no start', () => {
  const timeOnly = parse('20:00 看书');
  assert.equal(timeOnly.fields.scheduledDate, '2026-10-21');
  assert.equal(timeOnly.title, '看书');
  const dateOnly = parse('明天 看书');
  assert.equal(dateOnly.fields.scheduledDate, '2026-10-22');
  assert.equal(dateOnly.fields.scheduledStartAt, null);
});

test('start time follows the resolved date across a month boundary', () => {
  assert.equal(start('明天上午8点 复习', MONTH_END), '2026-11-01T08:00');
  assert.equal(start('周一 晚上8点 复习', SUN), '2026-10-26T20:00');
});

test('out-of-range clock values are not parsed', () => {
  assert.equal(parse('25:00 复习').fields.scheduledStartAt, null);
  assert.equal(parse('下午3点 复习').fields.scheduledStartAt, '2026-10-21T15:00');
  assert.equal(parse('12:75 复习').fields.scheduledStartAt, null);
});

test('durations in minutes and hours', () => {
  assert.equal(minutes('复习 45分钟'), 45);
  assert.equal(minutes('复习 90分钟'), 90);
  assert.equal(minutes('复习 1小时'), 60);
  assert.equal(minutes('复习 2个小时'), 120);
  assert.equal(minutes('复习 1.5小时'), 90);
  assert.equal(minutes('复习 半小时'), 30);
  assert.equal(minutes('复习 1个半小时'), 90);
  assert.equal(minutes('复习 1小时30分钟'), 90);
  assert.equal(minutes('复习 30min'), 30);
});

test('durations outside 5 to 720 minutes are left in the title', () => {
  const tooShort = parse('复习 3分钟');
  assert.equal(tooShort.fields.durationMinutes, null);
  assert.equal(tooShort.title, '复习 3分钟');
  assert.equal(minutes('复习 13小时'), null);
  assert.equal(minutes('复习 12小时'), 720);
});

test('duration and time of day do not swallow each other', () => {
  const result = parse('下午3点 复习 45分钟');
  assert.equal(result.fields.scheduledStartAt, '2026-10-21T15:00');
  assert.equal(result.fields.durationMinutes, 45);
  assert.equal(result.title, '复习');
});

test('priority p1 to p4, case-insensitive, and not inside other words', () => {
  assert.equal(parse('复习 p1').fields.priority, 1);
  assert.equal(parse('复习 P2').fields.priority, 2);
  assert.equal(parse('p3 复习').fields.priority, 3);
  assert.equal(parse('复习 p4').fields.priority, 4);
  assert.equal(parse('复习 p4').tokens.length, 1);
  const out = parse('复习 p5');
  assert.equal(out.fields.priority, 4);
  assert.equal(out.title, '复习 p5');
  assert.equal(parse('复习 p12').title, '复习 p12');
  assert.equal(parse('复习 step1').title, '复习 step1');
});

test('hash tags become labels, or the subject when the name matches', () => {
  const subject = parse('复习 #电路原理');
  assert.equal(subject.fields.subjectId, 's-circuit');
  assert.deepEqual(subject.fields.labels, []);
  assert.equal(subject.tokens[0].kind, 'subject');
  assert.equal(subject.tokens[0].subjectId, 's-circuit');

  const label = parse('复习 #考试');
  assert.equal(label.fields.subjectId, null);
  assert.deepEqual(label.fields.labels, ['考试']);

  const both = parse('复习 #考试 #电路原理 #重点');
  assert.equal(both.fields.subjectId, 's-circuit');
  assert.deepEqual(both.fields.labels, ['考试', '重点']);
  assert.equal(both.title, '复习');

  assert.equal(parse('复习 #calculus').fields.subjectId, 's-math');
});

test('only the first matching space is the subject; later ones become labels', () => {
  const result = parse('复习 #电路原理 #Calculus');
  assert.equal(result.fields.subjectId, 's-circuit');
  assert.deepEqual(result.fields.labels, ['Calculus']);
});

test('labels are capped at 10, deduplicated, and a hash inside a word is ignored', () => {
  const many = Array.from({ length: 12 }, (_, index) => `#t${index}`).join(' ');
  const result = parse(`复习 ${many}`);
  assert.equal(result.fields.labels.length, 10);
  assert.ok(result.title.includes('#t10') && result.title.includes('#t11'));
  assert.deepEqual(parse('复习 #考试 #考试').fields.labels, ['考试']);
  assert.equal(parse('学习C#语法').title, '学习C#语法');
  assert.deepEqual(parse('学习C#语法').fields.labels, []);
});

test('deadline keywords set the deadline and keep the schedule independent', () => {
  assert.equal(deadline('复习 截止周五'), '2026-10-23');
  assert.equal(date('复习 截止周五'), null);
  assert.equal(deadline('复习 周五前'), '2026-10-23');
  assert.equal(deadline('复习 ddl 10月30日'), '2026-10-30');
  assert.equal(deadline('复习 DDL 11月3日'), '2026-11-03');
  assert.equal(deadline('复习 截止：明天'), '2026-10-22');
  assert.equal(deadline('交作业 明天下午3点前'), '2026-10-22');

  const both = parse('明天 复习 截止周五');
  assert.equal(both.fields.scheduledDate, '2026-10-22');
  assert.equal(both.fields.deadlineDate, '2026-10-23');
  assert.equal(both.title, '复习');
});

test('deadlines respect week and month boundaries', () => {
  assert.equal(deadline('作业 截止周一', MON), '2026-10-19');
  assert.equal(deadline('作业 截止周一', WED), '2026-10-26');
  assert.equal(deadline('作业 下周日前', WED), '2026-11-01');
  assert.equal(deadline('作业 截止明天', MONTH_END), '2026-11-01');
});

test('deadline text does not leak into the schedule or title', () => {
  const result = parse('提交报告 截止后天');
  assert.equal(result.title, '提交报告');
  assert.equal(result.fields.deadlineDate, '2026-10-23');
  assert.equal(result.fields.scheduledDate, null);
  assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0].kind, 'deadline');
});

test('cancelling a chip puts its text back into the title (reversible)', () => {
  const text = '明天下午3点 复习戴维南定理 #电路原理 p1 45分钟';
  const full = parse(text);
  const byKind = Object.fromEntries(full.tokens.map((token) => [token.kind, token]));

  const noDate = parse(text, WED, SUBJECTS, [byKind.date.key]);
  assert.equal(noDate.fields.scheduledDate, '2026-10-21');
  assert.ok(noDate.title.includes('明天'));
  assert.equal(noDate.fields.scheduledStartAt, '2026-10-21T15:00');

  const noSubject = parse(text, WED, SUBJECTS, [byKind.subject.key]);
  assert.equal(noSubject.fields.subjectId, null);
  assert.deepEqual(noSubject.fields.labels, []);
  assert.ok(noSubject.title.includes('#电路原理'));

  const noPriority = parse(text, WED, SUBJECTS, [byKind.priority.key]);
  assert.equal(noPriority.fields.priority, 4);
  assert.ok(noPriority.title.includes('p1'));

  const noDuration = parse(text, WED, SUBJECTS, [byKind.duration.key]);
  assert.equal(noDuration.fields.durationMinutes, null);
  assert.ok(noDuration.title.includes('45分钟'));

  const everything = parse(text, WED, SUBJECTS, full.tokens.map((token) => token.key));
  assert.deepEqual(everything.tokens, []);
  assert.equal(everything.title, text.replace(/\s+/g, ' '));
});

test('cancelling every chip returns the original text exactly', () => {
  const text = '复习 截止周五 p2 #考试';
  const full = parse(text);
  assert.ok(full.tokens.length >= 3);
  const restored = parse(text, WED, SUBJECTS, full.tokens.map((token) => token.key));
  assert.equal(restored.title, text);
  assert.equal(restored.fields.deadlineDate, null);
  assert.equal(restored.fields.priority, 4);
});

test('token offsets point at the original text', () => {
  const text = '明天下午3点 复习戴维南定理 #电路原理 p1 45分钟';
  for (const token of parse(text).tokens) {
    assert.equal(text.slice(token.start, token.end), token.raw);
  }
});

test('the parser depends only on the injected now, not the system clock', () => {
  const first = parse('周一 复习', MON);
  const second = parse('周一 复习', SUN);
  assert.equal(first.fields.scheduledDate, '2026-10-19');
  assert.equal(second.fields.scheduledDate, '2026-10-26');
  assert.equal(MON.getTime(), new Date(2026, 9, 19, 9, 0).getTime());
});

test('quickAddToInput only sends fields that have a value', () => {
  assert.deepEqual(quickAddToInput(parse('整理错题本').fields), { title: '整理错题本', priority: 4 });
  assert.deepEqual(quickAddToInput(parse('明天下午3点 复习 #电路原理 p1 45分钟 截止周五').fields), {
    title: '复习',
    priority: 1,
    subjectId: 's-circuit',
    scheduledDate: '2026-10-22',
    scheduledStartAt: '2026-10-22T15:00',
    durationMinutes: 45,
    deadlineDate: '2026-10-23',
  });
  assert.equal(quickAddToInput({ ...parse('x').fields, title: 'a'.repeat(300) }).title.length, 200);
});

test('半/整 only belong to the clock when glued to 点 and not starting a word', () => {
  const spaced = parse('后天晚上7点 整理哈希表笔记');
  assert.equal(spaced.title, '整理哈希表笔记');
  assert.equal(spaced.fields.scheduledStartAt, '2026-10-23T19:00');
  const glued = parse('明天7点整理笔记');
  assert.equal(glued.title, '整理笔记');
  assert.equal(glued.fields.scheduledStartAt, '2026-10-22T07:00');
  assert.equal(parse('明天3点半导体复习').title, '半导体复习');
  assert.equal(parse('明天下午3点半 复习').fields.scheduledStartAt, '2026-10-22T15:30');
  assert.equal(parse('明天8点整 早读').fields.scheduledStartAt, '2026-10-22T08:00');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// 只验证「调用方把翻译函数传进纯函数」这条链路；真实的英文文案由 i18n.test.cjs 的 phrase 覆盖检查保证。
const modelFile = path.join(__dirname, '../src/components/agenda/agendaModel.ts');
const js = ts.transpileModule(fs.readFileSync(modelFile, 'utf8'), {
  fileName: modelFile,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, (name) => {
  if (name === '@/lib/agenda/quickAdd') return { formatYmd: (date) => date.toISOString().slice(0, 10) };
  if (name === '@/lib/agenda/types') return { AGENDA_CHANGED_EVENT: 'knowgap:agenda-changed' };
  return require(name);
});
const model = mod.exports;

const DICT = {
  '今天': 'Today',
  '明天': 'Tomorrow',
  '后天': 'Day after tomorrow',
  '昨天': 'Yesterday',
  '待办': 'Inbox',
  '预览': 'Preview',
  '周历': 'Week calendar',
  '逾期': 'Overdue',
  '任务': 'Tasks',
  '进行中支线': 'Open Threads',
  '{month}月{day}日': '{month}/{day}',
  '{year}年{month}月': '{month}/{year}',
  '{date} {weekday}': '{date} {weekday}',
  '周一': 'Mon',
  '周二': 'Tue',
  '周三': 'Wed',
  '周四': 'Thu',
  '周五': 'Fri',
  '周六': 'Sat',
  '周日': 'Sun',
  'P1 · 紧急': 'P1 · Urgent',
  'P2 · 高': 'P2 · High',
  'P3 · 中': 'P3 · Medium',
  'P4 · 无': 'P4 · None',
  '未归入空间': 'No space',
  '待办里还没排期': 'Unscheduled inbox',
};
const tx = (text, vars) => {
  const template = DICT[text] ?? text;
  return vars ? template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : template;
};

test('agendaModel 传入 tx 后，视图分组和日期标签输出英文', () => {
  const today = '2026-11-22';
  const upcoming = model.buildUpcomingGroups([], [], today, {}, tx);
  assert.equal(upcoming[0].label, '11/22');
  assert.equal(upcoming[0].sublabel, 'Today · Sun');
  assert.equal(upcoming[1].label, '11/23');
  assert.equal(upcoming[1].sublabel, 'Tomorrow · Mon');

  const todayGroups = model.buildTodayGroups([], [], today, {}, tx);
  assert.equal(todayGroups[0].label, 'Today');
  assert.match(todayGroups[0].sublabel, /^11\/22 · Sun$/);

  const inbox = model.buildInboxGroups([], {}, tx);
  assert.equal(inbox[0].label, 'Inbox');
});

test('AgendaPage 把 tx 传给所有会生成可见文案的 agendaModel 函数', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/agenda/AgendaPage.tsx'), 'utf8');
  for (const call of ['buildTodayGroups', 'buildInboxGroups', 'buildUpcomingGroups', 'applyViewOptions', 'buildTodaySuggestions']) {
    assert.match(source, new RegExp(`${call}\\([\\s\\S]{0,320}?\\btx\\b`), `${call} 应接收 tx`);
  }
  assert.match(source, /const heading = space \? space\.name : tx\(/, '页面标题应经过 tx');
});

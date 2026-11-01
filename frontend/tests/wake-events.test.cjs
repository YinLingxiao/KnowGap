const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../src/lib/chat/wakeEvents.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', js)(loaded, loaded.exports, () => ({}));
const { latestPlanChangeId, isHiddenSystemMessage } = loaded.exports;

const change = (id) => ({ stepId: id, title: id, from: null, to: 'in_progress' });

test('latestPlanChangeId returns null when no message changed the plan', () => {
  assert.equal(latestPlanChangeId([]), null);
  assert.equal(latestPlanChangeId([{ id: 'm1' }, { id: 'm2', planChanges: [] }]), null);
  assert.equal(latestPlanChangeId([{ id: 'm3', planChanges: undefined }]), null);
});

test('latestPlanChangeId returns the newest message with plan changes', () => {
  const id = latestPlanChangeId([
    { id: 'm1', planChanges: [change('a')] },
    { id: 'm2', planChanges: [] },
    { id: 'm3' },
    { id: 'm4', planChanges: [change('b'), change('c')] },
    { id: 'm5', planChanges: [] },
  ]);
  assert.equal(id, 'm4');
});

test('isHiddenSystemMessage hides a system event and its empty streaming reply only', () => {
  const eventIds = new Set(['event-1']);
  const event = { role: 'user', systemEvent: { type: 'thread_report' }, status: 'complete', content: '【系统事件】', replyTo: null };
  const emptyWake = { role: 'assistant', status: 'streaming', content: '', replyTo: 'event-1' };
  const wakeWithText = { role: 'assistant', status: 'streaming', content: '要不要换个例子？', replyTo: 'event-1' };
  const reasoningOnly = { role: 'assistant', status: 'streaming', content: '', replyTo: 'event-1', reasoning: '看看要不要回复' };
  const ordinary = { role: 'assistant', status: 'streaming', content: '', replyTo: 'user-1' };
  const user = { role: 'user', status: 'complete', content: '带我复习链表', replyTo: null };
  assert.equal(isHiddenSystemMessage(event, eventIds), true);
  assert.equal(isHiddenSystemMessage(emptyWake, eventIds), true);
  assert.equal(isHiddenSystemMessage(reasoningOnly, eventIds), true);
  assert.equal(isHiddenSystemMessage(wakeWithText, eventIds), false);
  assert.equal(isHiddenSystemMessage(ordinary, eventIds), false);
  assert.equal(isHiddenSystemMessage(user, eventIds), false);
  assert.equal(isHiddenSystemMessage(emptyWake, new Set()), false);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Plain module: only a type import, so the transpiled CommonJS can be loaded without shims.
const source = fs.readFileSync(path.resolve(__dirname, '../src/lib/chat/threadAlerts.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', js)(loaded, loaded.exports, () => ({}));
const { hasThreadsNeedingAttention } = loaded.exports;

const thread = (threadStatus, executionStatus) => ({ threadStatus, executionStatus });

test('a waiting or failed open Thread asks for attention', () => {
  assert.equal(hasThreadsNeedingAttention([thread('open', 'waiting')]), true);
  assert.equal(hasThreadsNeedingAttention([thread('open', 'failed')]), true);
  assert.equal(hasThreadsNeedingAttention([thread(null, 'waiting')]), true);
});

test('a resolved Thread never asks for attention, even if its last turn was waiting', () => {
  assert.equal(hasThreadsNeedingAttention([thread('resolved', 'waiting')]), false);
  assert.equal(hasThreadsNeedingAttention([thread('resolved', 'failed')]), false);
  assert.equal(hasThreadsNeedingAttention([thread('open', 'waiting'), thread('resolved', 'waiting')]), true);
});

test('busy, idle and stopped Threads do not ask for attention', () => {
  for (const status of ['working', 'queued', 'idle', 'cancelled', null]) {
    assert.equal(hasThreadsNeedingAttention([thread('open', status)]), false, String(status));
  }
  assert.equal(hasThreadsNeedingAttention([]), false);
});

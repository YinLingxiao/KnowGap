const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const file = path.join(__dirname, '../src/lib/chat/memoryScope.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const scope = mod.exports;

test('空间内不提供「全部」，只显示本空间和通用', () => {
  assert.deepEqual(scope.memoryScopeFilters(true), ['subject', 'general']);
  assert.deepEqual(scope.memoryScopeFilters(true, true), ['focused', 'subject', 'general']);
  assert.deepEqual(scope.memoryScopeFilters(false), ['all', 'general']);
  assert.equal(scope.defaultMemoryScopeFilter(true), 'subject');
  assert.equal(scope.defaultMemoryScopeFilter(true, null), 'general');
  assert.equal(scope.defaultMemoryScopeFilter(true, 'subj-a', 'subj-a'), 'subject');
  assert.equal(scope.defaultMemoryScopeFilter(true, 'subj-b', 'subj-a'), 'focused');
  assert.equal(scope.defaultMemoryScopeFilter(false, 'subj-a'), 'all');
});

test('记忆筛选严格按 subject_id 隔离；聚焦视图只放聚焦的那条', () => {
  const spaceA = { id: 'mem-a', subjectId: 'subj-a' };
  const spaceB = { id: 'mem-b', subjectId: 'subj-b' };
  const general = { id: 'mem-g', subjectId: null };
  assert.equal(scope.memoryMatchesScope(spaceA, 'subject', 'subj-a'), true);
  assert.equal(scope.memoryMatchesScope(spaceB, 'subject', 'subj-a'), false);
  assert.equal(scope.memoryMatchesScope(general, 'subject', 'subj-a'), false);
  assert.equal(scope.memoryMatchesScope(spaceB, 'general', 'subj-a'), false);
  assert.equal(scope.memoryMatchesScope(general, 'general', 'subj-a'), true);
  assert.equal(scope.memoryMatchesScope(spaceB, 'all', 'subj-a'), true);
  assert.equal(scope.memoryMatchesScope(spaceA, 'focused', 'subj-a', ['mem-b']), false);
  assert.equal(scope.memoryMatchesScope(spaceB, 'focused', 'subj-a', ['mem-b']), true);
  assert.equal(scope.memoryMatchesScope(spaceB, 'focused', 'subj-a', []), false);
  assert.equal(scope.memoryMatchesScope(spaceA, 'subject', null), false);
});

test('记忆抽屉使用统一的 scope 过滤，不再在空间里渲染全部', () => {
  const drawer = fs.readFileSync(path.join(__dirname, '../src/components/chat/MemoryDrawer.tsx'), 'utf8');
  assert.match(drawer, /memoryScopeFilters\(/);
  assert.match(drawer, /memoryMatchesScope\(/);
  assert.doesNotMatch(drawer, /filter === "all" \? true/);
});

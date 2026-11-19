// localStorage fallback for replies whose history payload has no memory_writes yet.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-memory-writes-'));
const output = path.join(temp, 'memoryWrites.js');
fs.writeFileSync(output, ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../src/lib/chat/memoryWrites.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText);
const { clearMemoryWrites, readMemoryWrites, storeMemoryWrites, memoryWritesKey,
  rememberRevokedMemoryWrite, withoutRevokedMemoryWrites, readRevokedMemoryWrites } = require(output);

const previousLocalStorage = global.localStorage;
function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

after(() => {
  global.localStorage = previousLocalStorage;
  fs.rmSync(temp, { recursive: true, force: true });
});

test('memory writes survive a reload keyed by conversation and reply', () => {
  global.localStorage = fakeStorage();
  const items = [{ id: 'note_1', layer: 'USER', content: '偏好先看例题' }];
  storeMemoryWrites('c1', 'm1', items);
  assert.deepEqual(readMemoryWrites('c1', 'm1'), items);
  assert.deepEqual(readMemoryWrites('c1', 'm2'), []);
  assert.ok(global.localStorage.values.has(memoryWritesKey('c1', 'm1')));
  clearMemoryWrites('c1', 'm1');
  assert.deepEqual(readMemoryWrites('c1', 'm1'), []);
});

test('malformed cache entries are ignored instead of breaking the reply', () => {
  const storage = fakeStorage();
  global.localStorage = storage;
  storage.setItem(memoryWritesKey('c1', 'm1'), '{not json');
  assert.deepEqual(readMemoryWrites('c1', 'm1'), []);
  storage.setItem(memoryWritesKey('c1', 'm2'), JSON.stringify([
    { id: 'note_2', layer: 'MEMORY', content: '记住' },
    { id: '', layer: 'USER', content: '无 id' },
    { nope: true },
  ]));
  assert.deepEqual(readMemoryWrites('c1', 'm2'), [{ id: 'note_2', layer: 'MEMORY', content: '记住' }]);
});

test('a revoked entry stays hidden after the history returns it again', () => {
  global.localStorage = fakeStorage();
  const items = [
    { id: 'note_1', layer: 'USER', content: '偏好先看例题' },
    { id: 'note_2', layer: 'MEMORY', content: '记住边界' },
  ];
  storeMemoryWrites('c1', 'm1', items);
  rememberRevokedMemoryWrite('c1', 'm1', 'note_1');
  assert.deepEqual(readRevokedMemoryWrites('c1', 'm1'), ['note_1']);
  assert.deepEqual(withoutRevokedMemoryWrites('c1', 'm1', items), [items[1]]);
  rememberRevokedMemoryWrite('c1', 'm1', 'note_1');
  assert.deepEqual(readRevokedMemoryWrites('c1', 'm1'), ['note_1']);
});
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { resolveI18n } = require('./i18n-support.cjs');

function transpile(relPath, overrides = {}) {
  const file = path.join(__dirname, '../src', relPath);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const localRequire = (id) => {
    if (id in overrides) return overrides[id];
    const i18n = resolveI18n(id);
    if (i18n) return i18n;
    if (id.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    return require(id);
  };
  new Function('require', 'module', 'exports', js)(localRequire, mod, mod.exports);
  return mod.exports;
}

const scope = transpile('lib/chat/memoryScope.ts');

/** 带真实 useState / useEffect 依赖比较的轻量组件驱动，用于测交互与重渲染行为。 */
function createDrawerHarness() {
  const states = [];
  const effects = [];
  let cursor = 0;
  let dirty = false;

  const reactMock = {
    ...React,
    useState(initial) {
      const slot = cursor++;
      if (!(slot in states)) {
        states[slot] = typeof initial === 'function' ? initial() : initial;
      }
      const setState = (next) => {
        const value = typeof next === 'function' ? next(states[slot]) : next;
        if (!Object.is(states[slot], value)) {
          states[slot] = value;
          dirty = true;
        }
      };
      return [states[slot], setState];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in states)) states[slot] = { current: initial };
      return states[slot];
    },
    useEffect(fn, deps) {
      const slot = cursor++;
      const prev = effects[slot];
      const changed = !prev || !deps || !prev.deps
        || deps.length !== prev.deps.length
        || deps.some((dep, idx) => !Object.is(dep, prev.deps[idx]));
      effects[slot] = { fn, deps, changed, cleanup: prev?.cleanup };
    },
  };

  const { MemoryDrawer } = transpile('components/chat/MemoryDrawer.tsx', {
    react: reactMock,
    '@/lib/chat/memoryScope': scope,
    '@/lib/chat/api': { chatApi: { agentNotes: async () => ({ user: '', memory: '' }), pendingNotes: async () => [] } },
    '@/lib/cx': transpile('lib/cx.ts'),
    '@/lib/i18n/errors': { errorText: (err) => String(err) },
    '@/lib/labels': { formatRelativeTime: () => '刚刚' },
    '../ui/Button': { Button: (props) => React.createElement('button', props) },
    'lucide-react': new Proxy({}, { get: () => () => null }),
  });

  let lastProps = null;
  let tree = null;

  function runEffects() {
    for (const effect of effects) {
      if (!effect || !effect.changed) continue;
      effect.changed = false;
      if (typeof effect.cleanup === 'function') effect.cleanup();
      effect.cleanup = effect.fn();
    }
  }

  function render(props) {
    lastProps = props;
    let guard = 0;
    do {
      dirty = false;
      cursor = 0;
      tree = MemoryDrawer(lastProps);
      runEffects();
      guard += 1;
    } while (dirty && guard < 10);
    return tree;
  }

  function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, predicate, out);
      return out;
    }
    if (predicate(node)) out.push(node);
    if (node.props && 'children' in node.props) collect(node.props.children, predicate, out);
    return out;
  }

  function filterButtons() {
    return collect(tree, (node) => node.type === 'button' && node.props?.role === 'radio');
  }

  function activeFilterLabel() {
    const active = filterButtons().find((btn) => btn.props['aria-checked'] === true);
    return active ? active.props.children : null;
  }

  function filterLabels() {
    return filterButtons().map((btn) => btn.props.children);
  }

  function clickFilter(label) {
    const target = filterButtons().find((btn) => btn.props.children === label);
    assert.ok(target, `找不到筛选按钮「${label}」，当前按钮：${filterLabels().join(', ')}`);
    target.props.onClick();
    return render(lastProps);
  }

  function visibleMemoryIds() {
    return collect(tree, (node) => typeof node.type === 'function' && node.type.name === 'MemoryItem')
      .map((node) => node.props.memory.id);
  }

  function emptyState() {
    const titles = collect(tree, (node) => node.type === 'p' && node.props?.className === 'emptyTitle')
      .map((node) => node.props.children);
    const practiceBtns = collect(tree, (node) => node.type === 'button' && node.props?.children === '去讲一个概念');
    return { title: titles[0] ?? null, hasPracticeButton: practiceBtns.length > 0 };
  }

  return { render, filterLabels, activeFilterLabel, clickFilter, visibleMemoryIds, emptyState };
}

function makeMemory(id, subjectId, kind = 'misconception') {
  return {
    id,
    kind,
    topic: `主题-${id}`,
    topicKey: null,
    summary: `摘要-${id}`,
    status: kind === 'misconception' ? 'suspected' : 'observed',
    userCorrected: false,
    origin: 'chat',
    subjectId,
    tags: [],
    evidence: [],
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T00:00:00Z',
  };
}

function baseProps(overrides = {}) {
  return {
    memories: [],
    subjects: [
      { id: 'subj-a', name: '数据结构' },
      { id: 'subj-b', name: '操作系统' },
    ],
    contextSubjectId: 'subj-a',
    loading: false,
    error: null,
    focusIds: [],
    conversationTitles: {},
    onClose() {},
    onRefresh() {},
    onUpdate: async () => true,
    onDelete: async () => true,
    onOpenConversation() {},
    onPractice() {},
    ...overrides,
  };
}

test('空间内不提供「全部」，聚焦范围汇总不依赖 memories 顺序', () => {
  const spaceA = { id: 'mem-a', subjectId: 'subj-a' };
  const spaceA2 = { id: 'mem-a2', subjectId: 'subj-a' };
  const spaceB = { id: 'mem-b', subjectId: 'subj-b' };
  const general = { id: 'mem-g', subjectId: null };

  assert.deepEqual(scope.memoryScopeFilters(true), ['subject', 'general']);
  assert.deepEqual(scope.memoryScopeFilters(true, 'mixed'), ['focused', 'subject', 'general']);
  assert.deepEqual(scope.memoryScopeFilters(false), ['all', 'general']);

  assert.equal(scope.classifyFocusedMemories('subj-a', [spaceA, spaceA2], ['mem-a', 'mem-a2']), 'subject');
  assert.equal(scope.classifyFocusedMemories('subj-a', [general], ['mem-g']), 'general');
  assert.equal(scope.classifyFocusedMemories('subj-a', [spaceA, general], ['mem-a', 'mem-g']), 'mixed');
  assert.equal(scope.classifyFocusedMemories('subj-a', [general, spaceA], ['mem-a', 'mem-g']), 'mixed');
  assert.equal(scope.classifyFocusedMemories('subj-a', [spaceA, spaceB], ['mem-a', 'mem-b']), 'mixed');
  assert.equal(scope.classifyFocusedMemories('subj-a', [spaceB, spaceA], ['mem-a', 'mem-b']), 'mixed');
  assert.equal(scope.classifyFocusedMemories('subj-a', [spaceB], ['mem-b']), 'mixed');

  assert.equal(scope.defaultMemoryScopeFilter(true, 'none'), 'subject');
  assert.equal(scope.defaultMemoryScopeFilter(true, 'subject'), 'subject');
  assert.equal(scope.defaultMemoryScopeFilter(true, 'general'), 'general');
  assert.equal(scope.defaultMemoryScopeFilter(true, 'mixed'), 'focused');
  assert.equal(scope.defaultMemoryScopeFilter(false, 'mixed'), 'all');
});

test('记忆筛选严格按 subject_id 隔离；聚焦视图只放聚焦的条目', () => {
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

test('多条跨范围聚焦记忆默认展示全部聚焦条目，且与 memories 数组顺序无关', () => {
  const memA = makeMemory('mem-a', 'subj-a');
  const memG = makeMemory('mem-g', null, 'preference');
  const memB = makeMemory('mem-b', 'subj-b');
  const memOther = makeMemory('mem-other', 'subj-b');

  // 本空间 + 通用混在一起，两种顺序都落在「聚焦记忆」且只含聚焦的两条
  for (const ordered of [[memA, memG, memOther], [memG, memA, memOther]]) {
    const h = createDrawerHarness();
    h.render(baseProps({ memories: ordered, focusIds: ['mem-a', 'mem-g'] }));
    assert.deepEqual(h.filterLabels(), ['聚焦记忆', '数据结构', '通用']);
    assert.equal(h.activeFilterLabel(), '聚焦记忆');
    assert.deepEqual(h.visibleMemoryIds().sort(), ['mem-a', 'mem-g']);
  }

  // 本空间 + 其他空间混在一起，即使本空间排在前面也会展示聚焦视图，不漏掉其他空间那条
  for (const ordered of [[memA, memB, memOther], [memB, memA, memOther]]) {
    const h = createDrawerHarness();
    h.render(baseProps({ memories: ordered, focusIds: ['mem-a', 'mem-b'] }));
    assert.equal(h.activeFilterLabel(), '聚焦记忆');
    assert.deepEqual(h.visibleMemoryIds().sort(), ['mem-a', 'mem-b']);
  }

  // 多条聚焦记忆全部属于同一范围时，直接落在该范围，不额外出现「聚焦记忆」
  const hSame = createDrawerHarness();
  const memA2 = makeMemory('mem-a2', 'subj-a');
  hSame.render(baseProps({ memories: [memA, memA2, memG], focusIds: ['mem-a', 'mem-a2'] }));
  assert.deepEqual(hSame.filterLabels(), ['数据结构', '通用']);
  assert.equal(hSame.activeFilterLabel(), '数据结构');
});

test('subjects 刷新后不重置用户手动选择的筛选；点另一条记忆才会跳回其范围', () => {
  const memA = makeMemory('mem-a', 'subj-a');
  const memG = makeMemory('mem-g', null, 'preference');
  const focusIds = [];
  const h = createDrawerHarness();

  h.render(baseProps({ memories: [memA, memG], focusIds }));
  assert.equal(h.activeFilterLabel(), '数据结构');

  // 用户手动切到「通用」
  h.clickFilter('通用');
  assert.equal(h.activeFilterLabel(), '通用');
  assert.deepEqual(h.visibleMemoryIds(), ['mem-g']);

  // 模拟 loadSubjects() 返回全新的 subjects 数组与新对象引用
  h.render(baseProps({
    memories: [memA, memG],
    focusIds,
    subjects: [
      { id: 'subj-a', name: '数据结构' },
      { id: 'subj-b', name: '操作系统' },
    ],
  }));
  assert.equal(h.activeFilterLabel(), '通用');
  assert.deepEqual(h.visibleMemoryIds(), ['mem-g']);

  // 抽屉开着时点击本空间的一条记忆提示（新数组），才跳回本空间范围
  h.render(baseProps({ memories: [memA, memG], focusIds: ['mem-a'] }));
  assert.equal(h.activeFilterLabel(), '数据结构');
  assert.deepEqual(h.visibleMemoryIds(), ['mem-a']);
});

test('contextSubjectId 存在但 subjects 未就绪时，空间内仍不出现「全部」也不显示其他空间记忆', () => {
  const memA = makeMemory('mem-a', 'subj-a');
  const memB = makeMemory('mem-b', 'subj-b');
  const memG = makeMemory('mem-g', null, 'preference');
  const h = createDrawerHarness();

  h.render(baseProps({ subjects: [], memories: [memA, memB, memG], contextSubjectId: 'subj-a' }));
  assert.deepEqual(h.filterLabels(), ['本空间', '通用']);
  assert.ok(!h.filterLabels().includes('全部'));
  assert.equal(h.activeFilterLabel(), '本空间');
  assert.deepEqual(h.visibleMemoryIds(), ['mem-a']);
});

test('聚焦的其他空间记忆被改归属或删除后，筛选自动回落到有效范围', () => {
  const memA = makeMemory('mem-a', 'subj-a');
  const memB = makeMemory('mem-b', 'subj-b');
  const focusIds = ['mem-b'];
  const h = createDrawerHarness();

  // 初始聚焦空间 B 记忆 -> 落在「聚焦记忆」
  h.render(baseProps({ memories: [memA, memB], focusIds }));
  assert.deepEqual(h.filterLabels(), ['聚焦记忆', '数据结构', '通用']);
  assert.equal(h.activeFilterLabel(), '聚焦记忆');
  assert.deepEqual(h.visibleMemoryIds(), ['mem-b']);

  // 改为归属当前空间 A -> 「聚焦记忆」消失，自动切到当前空间
  h.render(baseProps({ memories: [memA, { ...memB, subjectId: 'subj-a' }], focusIds }));
  assert.deepEqual(h.filterLabels(), ['数据结构', '通用']);
  assert.equal(h.activeFilterLabel(), '数据结构');
  assert.deepEqual(h.visibleMemoryIds().sort(), ['mem-a', 'mem-b']);

  // 改为通用 -> 自动切到「通用」
  h.render(baseProps({ memories: [memA, { ...memB, subjectId: null }], focusIds }));
  assert.deepEqual(h.filterLabels(), ['数据结构', '通用']);
  assert.equal(h.activeFilterLabel(), '通用');
  assert.deepEqual(h.visibleMemoryIds(), ['mem-b']);

  // 先切回跨空间聚焦，再把聚焦记忆删掉 -> 「聚焦记忆」消失，回落到本空间
  h.render(baseProps({ memories: [memA, memB], focusIds }));
  assert.equal(h.activeFilterLabel(), '聚焦记忆');
  h.render(baseProps({ memories: [memA], focusIds }));
  assert.deepEqual(h.filterLabels(), ['数据结构', '通用']);
  assert.equal(h.activeFilterLabel(), '数据结构');
  assert.deepEqual(h.visibleMemoryIds(), ['mem-a']);
});

test('空状态按当前空间可见记忆判断，不被其他空间的记忆误导', () => {
  const memB = makeMemory('mem-b', 'subj-b');
  const memG = makeMemory('mem-g', null, 'preference');

  // 只有空间 B 有记忆，当前空间 A 和通用都为空 -> 显示「还没有学习记忆」和引导按钮
  const h1 = createDrawerHarness();
  h1.render(baseProps({ memories: [memB], contextSubjectId: 'subj-a' }));
  assert.deepEqual(h1.emptyState(), { title: '还没有学习记忆', hasPracticeButton: true });

  // 当前空间 A 为空但通用有记忆 -> 当前标签显示「这个范围里还没有记录」，不显示首次引导按钮
  const h2 = createDrawerHarness();
  h2.render(baseProps({ memories: [memB, memG], contextSubjectId: 'subj-a' }));
  assert.deepEqual(h2.emptyState(), { title: '这个范围里还没有记录', hasPracticeButton: false });
});

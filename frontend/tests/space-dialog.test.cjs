const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { resolveI18n } = require('./i18n-support.cjs');

// 「已保存」提示用 window.setTimeout 自动消失；测试里没有浏览器窗口。
globalThis.window ??= { setTimeout: () => 0, clearTimeout() {} };
globalThis.document ??= { addEventListener() {}, removeEventListener() {} };

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

/** 有真实 useState 槽位的轻量渲染器：把本模块里的函数组件逐层展开成元素树。 */
function createHarness({ runEffects = false } = {}) {
  const states = [];
  let cursor = 0;
  const reactMock = {
    ...React,
    useState(initial) {
      const slot = cursor++;
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [states[slot], (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next; }];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in states)) states[slot] = { current: initial };
      return states[slot];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect(fn) {
      // runEffects：每个 effect 只在第一次渲染时跑一次，足够测「挂载时读取数据」。
      const slot = cursor++;
      if (!(slot in states)) { states[slot] = true; if (runEffects) fn(); }
    },
  };
  const expand = (node, keep) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((item) => expand(item, keep));
    if (typeof node.type === 'function' && keep(node.type)) return expand(node.type(node.props), keep);
    if (node.props && 'children' in node.props) {
      return { ...node, props: { ...node.props, children: expand(node.props.children, keep) } };
    }
    return node;
  };
  const render = (component, props, keep = () => false) => {
    cursor = 0;
    return expand(component(props), keep);
  };
  return { reactMock, render };
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

const textOf = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
};

const lucide = new Proxy({}, { get: () => () => null });
const spaceIcon = {
  DEFAULT_SPACE_ICON: 'folder',
  SpaceIcon: () => null,
  filterSpaceIcons: () => [{ id: 'folder', label: '文件夹', icon: () => null }],
};

function SpaceAppearancePickerStub() { return null; }

function loadCreateDialog(h) {
  return transpile('components/chat/CreateSpaceDialog.tsx', {
    react: h.reactMock,
    '@/lib/chat/attachments': { DOCUMENT_EXTENSIONS: ['.pdf'], MAX_UPLOAD_BYTES: 100 * 1024 * 1024 },
    '@/lib/materials/kinds': { kindFromFilename: () => 'pdf' },
    '@/lib/materials/uploads': { sameFile: () => false, sizeText: () => '1 KB', splitName: (n) => [n, ''] },
    '@/lib/chat/space': transpile('lib/chat/space.ts'),
    './SpaceIcon': spaceIcon,
    './SpaceAppearancePicker': { SpaceAppearancePicker: SpaceAppearancePickerStub },
    'lucide-react': lucide,
  }).CreateSpaceDialog;
}

function MemoryItemStub() { return null; }

function loadSettingsDialog(h, api = {}) {
  return transpile('components/chat/SpaceSettingsDialog.tsx', {
    react: h.reactMock,
    '@/lib/chat/api': { chatApi: {
      spaceMemorySync: async () => ({ syncedAt: null, nextSyncAt: null, entry: null, intervalDays: 1 }),
      syncSpaceMemory: async () => ({ syncedAt: null, nextSyncAt: null, entry: null, intervalDays: 1, status: 'unchanged', message: '' }),
      spaceUsage: async () => ({ total: { requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: null }, conversations: {} }),
      listThreads: async () => [],
      spaceMemoryNotes: async () => ({ content: '', entries: [], updatedAt: null, limit: 2200, history: [] }),
      spaceThreadNotes: async () => [],
      ...api,
    } },
    '@/lib/cx': transpile('lib/cx.ts'),
    '@/lib/api/errors': { toApiError: (err) => ({ message: String(err?.message ?? err) }) },
    './MemoryDrawer': {
      KIND_KEY: { misconception: 'memory.kind.misconception', mastery: 'memory.kind.mastery', preference: 'memory.kind.preference' },
      MemoryItem: MemoryItemStub,
    },
    './SpaceAppearancePicker': { SpaceAppearancePicker: SpaceAppearancePickerStub },
    './SpaceIcon': spaceIcon,
    './ModelPicker': modelPickerHelpers(),
    '@/lib/api/model-library': { MODELS_CHANGED_EVENT: 'knowgap:models-changed', modelLibraryApi: { listSelectableModels: async () => [] } },
    'lucide-react': lucide,
  });
}

function modelPickerHelpers() {
  return transpile('components/chat/ModelPicker.tsx', {
    react: React,
    '@/lib/api/model-library': { MODELS_CHANGED_EVENT: 'knowgap:models-changed', modelLibraryApi: {} },
    '@/lib/api/errors': { toApiError: (err) => err },
    '@/lib/cx': transpile('lib/cx.ts'),
    'lucide-react': lucide,
  });
}

const subject = {
  id: 'subj-1', name: '数据结构', description: '', instructions: '多用图示', goal: '搞懂树和图',
  level: 'exam', color: '#3d6fdb', icon: 'folder', mainConversationId: 'conv-1',
  mainModelKey: null, threadModelKey: null,
  progress: { toReview: 0, improving: 0, mastered: 0, openThreads: 0, resolvedThreads: 0, lastStudiedAt: null },
  conversationCount: 1, memoryCount: 2, materialCount: 3,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};

const memory = (id, subjectId, kind, topic, status = 'active') => ({
  id, subjectId, kind, topic, summary: `${topic} 的记录`, status, confidence: 0.8, userCorrected: false,
  origin: 'chat', topicKey: null, tags: [], evidence: [], createdAt: '', updatedAt: '',
});

function settingsProps(overrides = {}) {
  const calls = { update: [], delete: 0, practice: [], mainModel: [] };
  const props = {
    subject,
    memories: [
      memory('mem-a', 'subj-1', 'misconception', '栈'),
      memory('mem-b', 'subj-1', 'mastery', '队列'),
      memory('mem-x', 'subj-2', 'misconception', '进程调度'),
      memory('mem-g', null, 'preference', '先看例子'),
    ],
    subjects: [subject],
    conversationTitles: {},
    onClose() {},
    onUpdate: async (id, input) => { calls.update.push({ id, input }); return true; },
    mainModelKey: null,
    onMainModelChange: async (key) => { calls.mainModel.push(key); return true; },
    onDelete: async () => { calls.delete += 1; return true; },
    onUpdateMemory: async () => true,
    onDeleteMemory: async () => true,
    onOpenConversation() {},
    onPractice: (item) => calls.practice.push(item.id),
    ...overrides,
  };
  return { props, calls };
}

test('新建弹窗只负责新建：没有侧栏和截止日期，提交时不发送 level', async () => {
  const h = createHarness();
  const CreateSpaceDialog = loadCreateDialog(h);
  const created = [];
  const props = { onClose() {}, onCreate: async (input, files) => { created.push({ input, files }); return true; } };

  let tree = h.render(CreateSpaceDialog, props);
  assert.equal(collect(tree, (n) => n.type === 'nav').length, 0);
  assert.equal(collect(tree, (n) => n.type === 'input' && n.props?.type === 'date').length, 0);
  assert.equal(textOf(collect(tree, (n) => n.type === 'h2')[0]), '新建学习空间');
  assert.equal(collect(tree, (n) => n.type === SpaceAppearancePickerStub).length, 1);

  collect(tree, (n) => n.props?.id === 'space-name-input')[0].props.onChange({ target: { value: '编译原理' } });
  tree = h.render(CreateSpaceDialog, props);
  await collect(tree, (n) => n.props?.className === 'submitBtn')[0].props.onClick();

  assert.equal(created.length, 1);
  assert.equal(created[0].input.name, '编译原理');
  assert.equal('level' in created[0].input, false);
  assert.equal('deadline' in created[0].input, false);
});

test('空间设置有「通用」「记忆」「用量」三个分区，默认落在通用', () => {
  const h = createHarness();
  const mod = loadSettingsDialog(h);
  const { props } = settingsProps();
  const tree = h.render(mod.SpaceSettingsDialog, props);
  const nav = collect(tree, (n) => n.type === 'nav')[0];
  const items = collect(nav, (n) => n.type === 'button');
  assert.deepEqual(items.map(textOf), ['通用', '记忆', '用量']);
  assert.equal(items[0].props['aria-current'], 'page');
  assert.equal(textOf(collect(tree, (n) => n.type === 'h2')[0]), '空间设置');
});

test('通用：改名失焦即保存，清空名称会还原；删除要二次确认', async () => {
  const h = createHarness();
  const mod = loadSettingsDialog(h);
  const { props, calls } = settingsProps();
  const keep = (type) => type !== SpaceAppearancePickerStub && type !== MemoryItemStub;

  let tree = h.render(mod.SpaceSettingsDialog, props, keep);
  const name = () => collect(tree, (n) => n.props?.id === 'space-settings-name')[0];
  name().props.onChange({ target: { value: '数据结构与算法' } });
  tree = h.render(mod.SpaceSettingsDialog, props, keep);
  name().props.onBlur();
  await Promise.resolve();
  assert.deepEqual(calls.update.at(-1), { id: 'subj-1', input: { name: '数据结构与算法' } });

  name().props.onChange({ target: { value: '   ' } });
  tree = h.render(mod.SpaceSettingsDialog, props, keep);
  name().props.onBlur();
  tree = h.render(mod.SpaceSettingsDialog, props, keep);
  assert.equal(name().props.value, '数据结构');
  assert.equal(calls.update.length, 1);

  assert.equal(collect(tree, (n) => n.type === 'input' && n.props?.type === 'date').length, 0, '空间设置里没有截止日期');

  const deleteBtn = () => collect(tree, (n) => n.props?.className === 'dangerBtn')[0];
  deleteBtn().props.onClick();
  assert.equal(calls.delete, 0, '第一次点只进入确认');
  tree = h.render(mod.SpaceSettingsDialog, props, keep);
  await deleteBtn().props.onClick();
  assert.equal(calls.delete, 1);
});

test('记忆：教学说明在这里编辑，只列出本空间的记忆，不出现其他空间和通用记忆', () => {
  const h = createHarness();
  const mod = loadSettingsDialog(h);
  const { props } = settingsProps({ initialTab: 'memory' });
  const keep = (type) => type !== SpaceAppearancePickerStub && type !== MemoryItemStub;
  const tree = h.render(mod.SpaceSettingsDialog, props, keep);

  const textarea = collect(tree, (n) => n.type === 'textarea')[0];
  assert.equal(textarea.props.value, '多用图示');
  const shown = collect(tree, (n) => n.type === MemoryItemStub).map((n) => n.props.memory.id);
  assert.deepEqual(shown.sort(), ['mem-a', 'mem-b']);
  assert.match(textOf(tree), /汇总到总记忆/);
  assert.match(textOf(tree), /立即同步/);
});

test('用量：学习足迹按本空间统计，待巩固点可以专项攻克', async () => {
  const h = createHarness({ runEffects: true });
  const mod = loadSettingsDialog(h, {
    listThreads: async () => [{ id: 'th-1', threadStatus: 'resolved', title: '栈' }, { id: 'th-2', threadStatus: 'open', title: '队列' }],
  });
  const { props, calls } = settingsProps({ initialTab: 'usage' });
  const keep = (type) => type !== SpaceAppearancePickerStub && type !== MemoryItemStub;
  const stats = (tree) => Object.fromEntries(collect(tree, (n) => n.props?.className === 'stat')
    .map((n) => [textOf(n.props.children[1]), textOf(n.props.children[0])]));

  // 支线数读回来之前显示「—」，不显示一个误导人的 0
  assert.equal(stats(h.render(mod.SpaceSettingsDialog, props, keep))['已完成支线'], '—');
  await new Promise((resolve) => setImmediate(resolve));
  const tree = h.render(mod.SpaceSettingsDialog, props, keep);
  assert.deepEqual(stats(tree), { 待巩固: '1', 已掌握: '1', 已完成支线: '1', 进行中支线: '1', 资料: '3' });

  collect(tree, (n) => n.type === 'button' && textOf(n) === '专项攻克')[0].props.onClick();
  assert.deepEqual(calls.practice, ['mem-a']);
});

test('Token 数字压缩显示', () => {
  const h = createHarness();
  const { compactTokens } = loadSettingsDialog(h);
  assert.equal(compactTokens(950), '950');
  assert.equal(compactTokens(14_200), '14.2K');
  assert.equal(compactTokens(116_000), '116K');
  assert.equal(compactTokens(35_900_000), '35.9M');
  assert.equal(compactTokens(2_000_000), '2M');
});

test('图标和颜色弹层坐标在宽屏、矮视口和 340px 窄屏下都不会超出视口', () => {
  const h = createHarness();
  const { computePickerPosition } = transpile('components/chat/SpaceAppearancePicker.tsx', {
    react: h.reactMock,
    'react-dom': { createPortal: (node) => node },
    '@/lib/chat/space': transpile('lib/chat/space.ts'),
    '@/lib/cx': transpile('lib/cx.ts'),
    './SpaceIcon': spaceIcon,
    'lucide-react': lucide,
  });

  const desktop = computePickerPosition({ top: 140, bottom: 166, left: 260 }, { width: 1280, height: 800 }, 310);
  assert.equal(desktop.top, 174);
  assert.equal(desktop.left, 254);
  assert.equal(desktop.width, 276);

  const narrow = computePickerPosition({ top: 120, bottom: 146, left: 96 }, { width: 340, height: 640 }, 310);
  assert.ok(narrow.left >= 12);
  assert.ok(narrow.left + narrow.width <= 340 - 12);

  const flipped = computePickerPosition({ top: 460, bottom: 486, left: 200 }, { width: 1024, height: 600 }, 310);
  assert.equal(flipped.top, 460 - 8 - 310);
  assert.ok(flipped.top >= 12);

  const short = computePickerPosition({ top: 180, bottom: 206, left: 80 }, { width: 340, height: 300 }, 320);
  assert.ok(short.top >= 12);
  assert.equal(short.maxHeight, 300 - 24);
  assert.ok(short.top + Math.min(320, short.maxHeight) <= 300 - 12);
});

test('记忆：Memory.md 按条目显示类型标签，最近更新可以撤销；支线记录列出合并小结', async () => {
  const h = createHarness({ runEffects: true });
  const revoked = [];
  const notes = {
    size: 32,
    entries: ['[结论] 栈后进先出', '[疑问] KMP 的 next 数组怎么求'],
    updatedAt: '2026-11-27T00:00:00Z', limit: 2200,
    history: [{
      id: 'smem-1', action: 'add', content: '[结论] 栈后进先出', oldText: '', source: 'thread',
      sourceId: 'th-1', sourceTitle: '栈', createdAt: '2026-11-27T00:00:00Z', revoked: false,
    }],
  };
  const mod = loadSettingsDialog(h, {
    spaceMemoryNotes: async () => notes,
    revokeSpaceMemoryNote: async (sid, id) => { revoked.push([sid, id]); return { ...notes, entries: [notes.entries[1]] }; },
    spaceThreadNotes: async () => [{
      threadId: 'th-1', messageId: 'm-1', title: '栈的出入顺序', summary: '讲清了栈是后进先出。', takeaways: ['先进后出'],
      mergedAt: '2026-11-27T00:00:00Z', status: 'resolved',
    }],
  });
  const opened = [];
  const { props } = settingsProps({ initialTab: 'memory', onOpenConversation: (id) => opened.push(id) });
  const keep = (type) => type !== SpaceAppearancePickerStub && type !== MemoryItemStub;
  h.render(mod.SpaceSettingsDialog, props, keep);
  await new Promise((resolve) => setImmediate(resolve));
  let tree = h.render(mod.SpaceSettingsDialog, props, keep);

  const rows = collect(tree, (n) => n.type === 'li' && n.props?.children?.[0]?.props?.className?.startsWith?.('noteTag'));
  assert.deepEqual(rows.map((row) => textOf(row)), ['结论栈后进先出', '疑问KMP 的 next 数组怎么求']);
  assert.match(textOf(tree), /支线记录/);
  assert.match(textOf(tree), /栈的出入顺序/);
  collect(tree, (n) => n.type === 'button' && textOf(n) === '打开这条支线')[0].props.onClick();
  assert.deepEqual(opened, ['th-1']);

  collect(tree, (n) => n.type === 'button' && /最近更新/.test(textOf(n)))[0].props.onClick();
  tree = h.render(mod.SpaceSettingsDialog, props, keep);
  assert.match(textOf(tree), /支线「栈」合并 · 新增/);
  await collect(tree, (n) => n.type === 'button' && textOf(n) === '撤销')[0].props.onClick();
  assert.deepEqual(revoked, [['subj-1', 'smem-1']]);
});

test('通用 · 模型：主线和支线各选一个模型，选回默认或点「使用默认」都存成 null', async () => {
  const h = createHarness({ runEffects: true });
  const mod = loadSettingsDialog(h);
  const catalog = [
    { key: 'p1:sonnet', providerId: 'p1', providerName: 'Anthropic', modelId: 'sonnet', name: 'Sonnet 5.5', tags: { reasoning: 'none' }, isDefault: true },
    { key: 'p1:opus', providerId: 'p1', providerName: 'Anthropic', modelId: 'opus', name: 'Opus 5.5', tags: { reasoning: 'medium' }, isDefault: false },
  ];
  const { props, calls } = settingsProps({ modelClient: { listSelectableModels: async () => catalog } });
  const keep = (type) => type !== SpaceAppearancePickerStub && type !== MemoryItemStub;
  h.render(mod.SpaceSettingsDialog, props, keep);
  await new Promise((resolve) => setImmediate(resolve));
  let tree = h.render(mod.SpaceSettingsDialog, props, keep);

  const select = (id) => collect(tree, (n) => n.type === 'select' && n.props?.id === id)[0];
  const firstOption = (id) => textOf(collect(select(id), (n) => n.type === 'option')[0]);
  assert.equal(firstOption('space-model-main'), '默认（Sonnet 5.5）');
  assert.equal(firstOption('space-model-thread'), '跟随主线（Sonnet 5.5）');
  const labels = collect(select('space-model-main'), (n) => n.type === 'option').map(textOf);
  assert.deepEqual(labels.slice(1), ['Sonnet 5.5', 'Opus 5.5 · 中']);

  await select('space-model-main').props.onChange({ target: { value: 'p1:opus' } });
  assert.deepEqual(calls.mainModel, ['p1:opus']);
  tree = h.render(mod.SpaceSettingsDialog, props, keep);
  assert.equal(select('space-model-main').props.value, 'p1:opus');
  assert.equal(firstOption('space-model-thread'), '跟随主线（Opus 5.5）');

  // 选回全局默认的那个模型，等于「使用默认」
  await select('space-model-main').props.onChange({ target: { value: 'p1:sonnet' } });
  assert.deepEqual(calls.mainModel, ['p1:opus', null]);

  tree = h.render(mod.SpaceSettingsDialog, props, keep);
  await select('space-model-thread').props.onChange({ target: { value: 'p1:opus' } });
  assert.deepEqual(calls.update.at(-1), { id: 'subj-1', input: { threadModelKey: 'p1:opus' } });
  tree = h.render(mod.SpaceSettingsDialog, props, keep);
  const reset = collect(tree, (n) => n.type === 'button' && textOf(n) === '使用默认');
  assert.equal(reset.length, 1, '只有改过的那一行显示「使用默认」');
  await reset[0].props.onClick();
  assert.deepEqual(calls.update.at(-1), { id: 'subj-1', input: { threadModelKey: null } });
});

test('通用 · 模型：支线可以单独选全局默认模型，不会被当成「跟随主线」', async () => {
  const h = createHarness({ runEffects: true });
  const mod = loadSettingsDialog(h);
  const catalog = [
    { key: 'p1:sonnet', providerId: 'p1', providerName: 'Anthropic', modelId: 'sonnet', name: 'Sonnet 5.5', tags: { reasoning: 'none' }, isDefault: true },
    { key: 'p1:opus', providerId: 'p1', providerName: 'Anthropic', modelId: 'opus', name: 'Opus 5.5', tags: { reasoning: 'medium' }, isDefault: false },
  ];
  // 主线用 Opus；支线想用全局默认的 Sonnet
  const { props, calls } = settingsProps({ mainModelKey: 'p1:opus', modelClient: { listSelectableModels: async () => catalog } });
  const keep = (type) => type !== SpaceAppearancePickerStub && type !== MemoryItemStub;
  h.render(mod.SpaceSettingsDialog, props, keep);
  await new Promise((resolve) => setImmediate(resolve));
  let tree = h.render(mod.SpaceSettingsDialog, props, keep);
  const select = (id) => collect(tree, (n) => n.type === 'select' && n.props?.id === id)[0];
  assert.equal(textOf(collect(select('space-model-thread'), (n) => n.type === 'option')[0]), '跟随主线（Opus 5.5）');

  await select('space-model-thread').props.onChange({ target: { value: 'p1:sonnet' } });
  assert.deepEqual(calls.update.at(-1), { id: 'subj-1', input: { threadModelKey: 'p1:sonnet' } });
  tree = h.render(mod.SpaceSettingsDialog, props, keep);
  assert.equal(select('space-model-thread').props.value, 'p1:sonnet');
});

test('相对时间按小时和整天算，1 天单独说', () => {
  const h = createHarness();
  const { relativeTime } = loadSettingsDialog(h);
  const tx = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(vars[key]));
  const now = Date.parse('2026-11-27T12:00:00Z');
  const at = (hours) => new Date(now + hours * 3_600_000).toISOString();
  assert.equal(relativeTime(at(12.5), tx, now), '12 小时后');
  assert.equal(relativeTime(at(30), tx, now), '1 天后');
  assert.equal(relativeTime(at(-50), tx, now), '2 天前');
  assert.equal(relativeTime(at(-0.2), tx, now), '刚刚');
});

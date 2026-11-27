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

function createDialogHarness() {
  const states = [];
  const portals = [];
  let cursor = 0;

  const reactMock = {
    ...React,
    useState(initial) {
      const slot = cursor++;
      if (!(slot in states)) {
        states[slot] = typeof initial === 'function' ? initial() : initial;
      }
      const setState = (next) => {
        states[slot] = typeof next === 'function' ? next(states[slot]) : next;
      };
      return [states[slot], setState];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in states)) states[slot] = { current: initial };
      return states[slot];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
  };

  const spaceMod = transpile('lib/chat/space.ts');
  const cxMod = transpile('lib/cx.ts');
  const dialogMod = transpile('components/chat/CreateSpaceDialog.tsx', {
    react: reactMock,
    'react-dom': {
      createPortal(node, container) {
        portals.push({ node, container });
        return node;
      },
    },
    '@/lib/chat/attachments': { DOCUMENT_EXTENSIONS: ['.pdf'], MAX_UPLOAD_BYTES: 100 * 1024 * 1024 },
    '@/lib/materials/kinds': { kindFromFilename: () => 'pdf' },
    '@/lib/materials/uploads': { sameFile: () => false, sizeText: () => '1 KB', splitName: (n) => [n, ''] },
    '@/lib/chat/space': spaceMod,
    '@/lib/cx': cxMod,
    './SpaceIcon': {
      DEFAULT_SPACE_ICON: 'folder',
      SpaceIcon: () => null,
      filterSpaceIcons: () => [{ id: 'folder', label: '文件夹', icon: () => null }],
    },
    'lucide-react': new Proxy({}, { get: () => () => null }),
  });

  let tree = null;

  function render(props) {
    cursor = 0;
    portals.length = 0;
    tree = dialogMod.CreateSpaceDialog(props);
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

  return { render, collect, portals, computePickerPosition: dialogMod.computePickerPosition };
}

test('新建模式不显示侧栏、使用单栏 440px 样式，提交时不发送 level', async () => {
  const created = [];
  const h = createDialogHarness();
  const props = {
    subject: null,
    onClose() {},
    onCreate: async (input, files) => {
      created.push({ input, files });
      return true;
    },
    onUpdate: async () => true,
  };

  let tree = h.render(props);
  assert.equal(h.collect(tree, (n) => n.type === 'nav').length, 0);
  const dialog = h.collect(tree, (n) => n.props?.role === 'dialog')[0];
  assert.equal(dialog.props.className, 'dialog');
  const title = h.collect(tree, (n) => n.type === 'h2')[0];
  assert.equal(title.props.children, '新建学习空间');

  const nameInput = h.collect(tree, (n) => n.type === 'input' && n.props?.id === 'space-name-input')[0];
  nameInput.props.onChange({ target: { value: '编译原理' } });
  tree = h.render(props);

  const submitBtn = h.collect(tree, (n) => n.type === 'button' && n.props?.className === 'submitBtn')[0];
  await submitBtn.props.onClick();

  assert.equal(created.length, 1);
  assert.equal(created[0].input.name, '编译原理');
  assert.equal('level' in created[0].input, false);
});

test('编辑模式显示空间设置侧栏、可见截止日期标签，保存时不发送 level', async () => {
  const updated = [];
  const h = createDialogHarness();
  const subject = {
    id: 'subj-1',
    name: '数据结构',
    description: '',
    instructions: '',
    goal: '搞懂树和图',
    level: 'exam',
    deadline: '2026-12-31',
    color: '#3d6fdb',
    icon: 'folder',
    mainConversationId: 'conv-1',
    progress: { toReview: 0, improving: 0, mastered: 0, openThreads: 0, resolvedThreads: 0, lastStudiedAt: null },
    conversationCount: 1,
    memoryCount: 0,
    materialCount: 0,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
  const props = {
    subject,
    onClose() {},
    onCreate: async () => true,
    onUpdate: async (id, input) => {
      updated.push({ id, input });
      return true;
    },
  };

  const tree = h.render(props);
  const navs = h.collect(tree, (n) => n.type === 'nav');
  assert.equal(navs.length, 1);
  assert.equal(navs[0].props['aria-label'], '空间设置');

  const dialog = h.collect(tree, (n) => n.props?.role === 'dialog')[0];
  assert.match(dialog.props.className, /\bdialog\b/);
  assert.match(dialog.props.className, /\bdialogEdit\b/);

  const title = h.collect(tree, (n) => n.type === 'h2')[0];
  assert.equal(title.props.children, '空间设置');

  // 编辑模式下的截止日期有可见 label，且与输入框 id 关联
  const deadlineLabel = h.collect(tree, (n) => n.type === 'label' && n.props?.htmlFor === 'space-deadline-input')[0];
  const deadlineInput = h.collect(tree, (n) => n.type === 'input' && n.props?.id === 'space-deadline-input')[0];
  assert.ok(deadlineLabel && deadlineLabel.props.children === '截止日期（可选）');
  assert.ok(deadlineInput && deadlineInput.props.type === 'date');

  const submitBtn = h.collect(tree, (n) => n.type === 'button' && n.props?.className === 'submitBtn')[0];
  await submitBtn.props.onClick();

  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 'subj-1');
  assert.equal(updated[0].input.name, '数据结构');
  assert.equal(updated[0].input.deadline, '2026-12-31');
  assert.equal('level' in updated[0].input, false);
});

test('图标和颜色弹层坐标在宽屏、矮视口和 340px 窄屏下都不会超出视口', () => {
  const { computePickerPosition } = createDialogHarness();

  // 普通桌面视口：放在锚点下方
  const desktop = computePickerPosition({ top: 140, bottom: 166, left: 260 }, { width: 1280, height: 800 }, 310);
  assert.equal(desktop.top, 174);
  assert.equal(desktop.left, 254);
  assert.equal(desktop.width, 276);

  // 340px 窄屏且锚点偏右：左边界和右边界都保留安全边距，不超出 340px
  const narrow = computePickerPosition({ top: 120, bottom: 146, left: 96 }, { width: 340, height: 640 }, 310);
  assert.ok(narrow.left >= 12);
  assert.ok(narrow.left + narrow.width <= 340 - 12);

  // 锚点靠近底部且下方放不下：翻转到锚点上方，且不超出顶部
  const flipped = computePickerPosition({ top: 460, bottom: 486, left: 200 }, { width: 1024, height: 600 }, 310);
  assert.equal(flipped.top, 460 - 8 - 310);
  assert.ok(flipped.top >= 12);

  // 极矮视口：上下都放不下时夹在视口内并限制 maxHeight
  const short = computePickerPosition({ top: 180, bottom: 206, left: 80 }, { width: 340, height: 300 }, 320);
  assert.ok(short.top >= 12);
  assert.equal(short.maxHeight, 300 - 24);
  assert.ok(short.top + Math.min(320, short.maxHeight) <= 300 - 12);
});

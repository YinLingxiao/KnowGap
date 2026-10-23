const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../src');
const cache = new Map();

function cssModule() {
  const proxy = new Proxy({}, {
    get: (_, key) => (key === '__esModule' || key === 'default' ? proxy : String(key)),
  });
  return proxy;
}

function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const loaded = { exports: {} };
  cache.set(file, loaded);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  new Function('module', 'exports', 'require', js)(loaded, loaded.exports, (name) => {
    if (name === 'react' || name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') {
      const runtime = { jsx: () => null, jsxs: () => null, Fragment: Symbol.for('react.fragment') };
      return name === 'react'
        ? { useState: (value) => [value, () => undefined], useEffect: () => undefined, useMemo: (fn) => fn(), useRef: (value) => ({ current: value }), useCallback: (fn) => fn, useId: () => 'id' }
        : runtime;
    }
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
    if (name.endsWith('.css')) return cssModule();
    if (name.startsWith('@/')) return load(resolveSource(path.join(root, name.slice(2))));
    if (name.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), name);
      if (resolved.endsWith('.css')) return cssModule();
      return load(resolveSource(resolved));
    }
    return require(name);
  });
  return loaded.exports;
}

function resolveSource(base) {
  if (fs.existsSync(base)) return base;
  for (const ext of ['.ts', '.tsx']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  throw new Error(`missing ${base}`);
}

const picker = load(path.join(root, 'components/chat/ModelPicker.tsx'));
const deepseek = { key: 'prov-a11d5e01/deepseek-flash', providerId: 'prov-a11d5e01', providerName: 'DeepSeek', modelId: 'deepseek-flash', name: 'deepseek-flash', tags: { reasoning: 'none', vision: false, tools: true, label: null }, isDefault: true };
const reasoner = { key: 'prov-a11d5e01/deepseek-reasoner', providerId: 'prov-a11d5e01', providerName: 'DeepSeek', modelId: 'deepseek-reasoner', name: 'deepseek-reasoner', tags: { reasoning: 'high', vision: false, tools: true, label: '新' }, isDefault: false };
const gemini = { key: 'prov-c33f7003/google/gemini-3.5-flash', providerId: 'prov-c33f7003', providerName: 'Vertex', modelId: 'google/gemini-3.5-flash', name: 'gemini-3.5-flash', tags: { reasoning: 'low', vision: true, tools: true, label: null }, isDefault: false };
const catalog = [deepseek, reasoner, gemini];

test('search keeps slash model ids and groups by provider', () => {
  const found = picker.filterCatalog(catalog, 'FLASH');
  assert.deepEqual(found.map((item) => item.modelId), ['deepseek-flash', 'google/gemini-3.5-flash']);
  assert.deepEqual(picker.filterCatalog(catalog, 'vertex').map((item) => item.key), [gemini.key]);
  assert.deepEqual(picker.filterCatalog(catalog, '没有').map((item) => item.key), []);
  const groups = picker.groupCatalog(catalog);
  assert.deepEqual(groups.map((group) => group.providerName), ['DeepSeek', 'Vertex']);
  assert.equal(groups[0].models.length, 2);
});

test('default choice, reasoning and short names', () => {
  assert.equal(picker.choiceFor(deepseek, catalog), null);
  assert.equal(picker.choiceFor(reasoner, catalog), reasoner.key);
  assert.equal(picker.effectiveModel(catalog, null).key, deepseek.key);
  assert.equal(picker.effectiveModel(catalog, 'missing').key, deepseek.key);
  assert.equal(picker.effectiveModel(catalog, reasoner.key).key, reasoner.key);
  assert.equal(picker.usesDefaultModel(catalog, null), true);
  assert.equal(picker.usesDefaultModel(catalog, deepseek.key), true);
  assert.equal(picker.usesDefaultModel(catalog, reasoner.key), false);
  assert.equal(picker.supportsReasoning(deepseek), false);
  assert.equal(picker.supportsReasoning(reasoner), true);
  assert.equal(picker.supportsReasoning(gemini), true);
  assert.equal(picker.reasoningLabel('high'), '高');
  assert.equal(picker.reasoningLabel('medium'), '中');
  assert.equal(picker.reasoningLabel('low'), '低');
  assert.equal(picker.reasoningLabel('none'), null);
  assert.equal(picker.shortModelName('deepseek-flash'), 'flash');
  assert.equal(picker.shortModelName('gemini-3.5-flash'), 'flash');
  assert.equal(picker.shortModelName('超长模型名称没有分隔'), '超长模型名称没…');
  assert.equal(picker.nextIndex(0, 'ArrowUp', 3), 0);
  assert.equal(picker.nextIndex(1, 'ArrowDown', 3), 2);
  assert.equal(picker.nextIndex(2, 'ArrowDown', 3), 2);
});

test('composer wires the picker beside reasoning effort and only for the current conversation', () => {
  const composer = fs.readFileSync(path.join(root, 'components/chat/Composer.tsx'), 'utf8');
  const chat = fs.readFileSync(path.join(root, 'hooks/useChat.ts'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'lib/chat/api.ts'), 'utf8');
  assert.match(composer, /<ModelPicker/);
  assert.match(composer, /supportsReasoning\(activeModel\)/);
  assert.match(composer, /disabled=\{generating\}/);
  assert.match(composer, /disabledReason="正在生成，请等这条回复完成后再切换模型"/);
  assert.doesNotMatch(composer, /effortModel/);
  assert.match(chat, /pendingModelRef/);
  assert.match(chat, /applyPendingModel/);
  assert.match(chat, /setConversationModel/);
  assert.match(api, /modelKey: typeof data\.model_key/);
  assert.match(api, /model_key: modelKey/);
});

test('the menu flips below the trigger when the window has no room above it', () => {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').split(String.fromCharCode(13)).join('');
  const component = read('components/chat/ModelPicker.tsx');
  const css = read('components/chat/ModelPicker.module.css');
  assert.match(component, /useLayoutEffect\(\(\) => \{[\s\S]*?getBoundingClientRect\(\)[\s\S]*?setPlacement\(/);
  assert.match(component, /placement\.below && styles\.popoverBelow/);
  assert.match(css, /\.popoverBelow \{[^}]*top: calc\(100% \+ 6px\);[^}]*bottom: auto;/);
  assert.match(css, /max-height: min\(280px, var\(--picker-room, 280px\)\)/);
});


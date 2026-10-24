const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../src');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function load(file) {
  const loaded = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('module', 'exports', js)(loaded, loaded.exports);
  return loaded.exports;
}

const providers = load(path.join(root, 'lib/modelProviders.ts'));

test('tag guesses stay empty unless the model name states the capability', () => {
  assert.deepEqual(providers.suggestModelTags('deepseek-chat'), { reasoning: 'none', vision: false, tools: false, label: null });
  assert.deepEqual(providers.suggestModelTags('gemini-4-argon'), { reasoning: 'none', vision: false, tools: false, label: null });
  assert.equal(providers.suggestModelTags('deepseek-reasoner').reasoning, 'high');
  assert.equal(providers.suggestModelTags('qwen-vl-max').vision, true);
  assert.equal(providers.suggestModelTags('gpt-4o').vision, false);
  assert.equal(providers.suggestModelTags('some-tool-model').tools, true);
  assert.equal(providers.suggestModelTags('glm-4.5-pro').label, 'Pro');
  assert.deepEqual(providers.presetAuthModes('vertex'), ['api_key', 'adc']);
  assert.deepEqual(providers.presetAuthModes('chatgpt'), ['chatgpt']);
  assert.deepEqual(providers.presetAuthModes('deepseek'), ['api_key']);
});

test('model library settings keep secrets out of the page and expose the library controls', () => {
  const access = read('components/settings/ModelAccessCard.tsx');
  const editor = read('components/settings/ProviderEditor.tsx');
  const list = read('components/settings/ModelList.tsx');
  const service = read('components/settings/ServiceModelsSection.tsx');
  const page = read('app/dev/model-library/page.tsx');
  assert.match(access, /添加你的第一个模型/);
  assert.match(access, /aria-labelledby=\{`\$\{fieldId\}-default`\}/);
  assert.match(read('components/settings/ProviderList.tsx'), /aria-label=\{`启用 \$\{provider\.name\}`\}/);
  assert.match(list, /aria-label="搜索模型"/);
  assert.match(list, /aria-label=\{`启用模型 \$\{model\.name\}`\}/);
  assert.match(editor, /aria-label="认证方式"/);
  assert.match(editor, /aria-label="接口地址"/);
  assert.match(editor, /aria-label=\{showKey \? "隐藏密钥" : "显示密钥"\}/);
  assert.match(editor, /Continue with ChatGPT/);
  assert.match(editor, /Google Cloud 项目 ID/);
  assert.doesNotMatch(editor, /provider\.apiKey/);
  assert.doesNotMatch(access, /provider\.apiKey/);
  assert.match(service, /<option value="">沿用默认模型<\/option>/);
  assert.match(service, /服务商坐标格式/);
  assert.match(service, /启用视觉模型/);
  assert.doesNotMatch(service, /baseUrl/);
  assert.doesNotMatch(service, /apiKey/);
  assert.match(page, /createMockModelLibrary/);
  assert.match(page, /synthetic-library-key/);
  assert.doesNotMatch(page, /sk-[A-Za-z0-9]{20,}/);
  const css = read('components/settings/ModelLibrary.module.css');
  assert.match(css, /minmax\(min\(100%, 168px\), 1fr\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(read('components/settings/ServiceModelsSection.module.css'), /@media \(max-width: 640px\)/);
});

test('the candidate-model dialog search box keeps its own height in a column layout', () => {
  const css = read('components/settings/ModelLibrary.module.css').split('\r').join('');
  const editor = read('components/settings/ProviderEditor.tsx');
  // .search carries `flex: 1 1 160px`, a width basis for the horizontal toolbar. Stacked in a column, that
  // basis becomes its height (it rendered ~250px tall), so the dialog uses a block variant.
  assert.match(css, /\.searchBlock \{[^}]*flex: 0 0 auto;[^}]*width: 100%;/);
  assert.match(editor, /cx\(styles\.search, styles\.searchBlock\)/);
});

test('px flex bases in settings styles are only used on elements inside horizontal rows', () => {
  const dir = path.join(root, 'components/settings');
  const allowed = new Set(['.grow', '.search']);
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(dir, file), 'utf8').split('\r').join('');
    for (const match of css.matchAll(/([^{}]+)\{[^}]*?flex:\s*[\d.]+\s+[\d.]+\s+[\d.]+px[^}]*\}/g)) {
      const selector = match[1].trim().split('\n').pop().trim();
      assert.ok(allowed.has(selector), `${file}: ${selector} uses a px flex-basis; check it is not placed in a column, or add it here`);
    }
  }
});


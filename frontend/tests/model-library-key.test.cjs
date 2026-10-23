const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../src');
const cache = new Map();

function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const loaded = { exports: {} };
  cache.set(file, loaded);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('module', 'exports', 'require', js)(loaded, loaded.exports, (name) => {
    if (!name.startsWith('.')) return require(name);
    const resolved = path.resolve(path.dirname(file), name.endsWith('.ts') ? name : `${name}.ts`);
    return load(resolved);
  });
  return loaded.exports;
}

const api = load(path.join(root, 'lib/api/model-library.ts'));

test('model keys keep slashes that belong to the model id', () => {
  const key = api.modelKey('prov-abcdef12', 'google/gemini-3.5-flash');
  assert.equal(key, 'prov-abcdef12/google/gemini-3.5-flash');
  assert.deepEqual(api.parseModelKey(key), { providerId: 'prov-abcdef12', modelId: 'google/gemini-3.5-flash' });
  assert.equal(api.parseModelKey(' prov-abcdef12/a/b/c ').modelId, 'a/b/c');
  assert.equal(api.encodeModelId('google/gemini-3.5-flash'), 'google/gemini-3.5-flash');
  assert.equal(api.encodeModelId('a b/c'), 'a%20b/c');
});

test('model keys without both a provider and a model are rejected', () => {
  for (const key of ['', 'noslash', '/model', 'prov-abcdef12/', '/']) {
    assert.throws(() => api.parseModelKey(key), /模型键/);
  }
  assert.throws(() => api.modelKey('prov/id', 'model'), /服务商 ID/);
  assert.throws(() => api.modelKey('', 'google/gemini-3.5-flash'), /服务商 ID/);
  assert.throws(() => api.modelKey('prov-abcdef12', ''), /服务商 ID/);
});

test('mock catalog and provider responses keep slash model ids and hide keys', async () => {
  const library = api.createMockModelLibrary();
  const provider = await library.createProvider({
    name: 'Vertex', preset: 'vertex', baseUrl: 'https://aiplatform.googleapis.com/v1/publishers/google/models/',
    authMode: 'api_key', apiKey: 'synthetic-library-key',
  });
  assert.equal(provider.baseUrl, 'https://aiplatform.googleapis.com/v1/publishers/google/models');
  assert.equal(provider.hasApiKey, true);
  assert.equal(Object.hasOwn(provider, 'apiKey'), false);
  await library.createModel(provider.id, { id: 'google/gemini-3.5-flash', name: 'Gemini' });
  const key = api.modelKey(provider.id, 'google/gemini-3.5-flash');
  await library.setDefaultModel(key);
  await library.setServiceModels({ logic: key, vision: null, memory: null });
  const catalog = await library.listSelectableModels();
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].key, key);
  assert.equal(catalog[0].modelId, 'google/gemini-3.5-flash');
  assert.equal(catalog[0].isDefault, true);
  assert.equal(JSON.stringify(await library.listProviders()).includes('synthetic-library-key'), false);
  const removed = await library.deleteProvider(provider.id);
  assert.deepEqual(removed.affected, { defaultModel: true, serviceModels: ['logic'] });
  assert.equal((await library.getDefaultModel()).key, null);
  assert.equal((await library.getServiceModels()).logic, null);
});

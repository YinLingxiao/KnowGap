const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function('module', 'exports', 'require', js)(module, module.exports, name => {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    return require(name);
  });
  return module.exports;
}
const api = load(path.join(root, 'lib/api/search-config.ts'));
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; });

test('status maps the wire shape and carries no key', async () => {
  global.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/api/search/config'));
    assert.equal(options.cache, 'no-store');
    return new Response(JSON.stringify({ has_key: true, source: 'environment' }));
  };
  assert.deepEqual(await api.getSearchKeyStatus(), { hasKey: true, source: 'environment' });
});

test('save sends the trimmed key once and an empty string clears it', async () => {
  const bodies = [];
  global.fetch = async (_, options) => {
    assert.equal(options.method, 'PUT');
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ has_key: bodies.length === 1, source: bodies.length === 1 ? 'saved' : 'none' }));
  };
  assert.deepEqual(await api.saveSearchKey('  as_sk_synthetic \n'), { hasKey: true, source: 'saved' });
  assert.deepEqual(await api.saveSearchKey(''), { hasKey: false, source: 'none' });
  assert.deepEqual(bodies, [{ anysearch_api_key: 'as_sk_synthetic' }, { anysearch_api_key: '' }]);
});

test('test sends the typed key, or nothing to test the active one', async () => {
  const bodies = [];
  global.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/api/search/test'));
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ status: 'ok', results: 3 }));
  };
  assert.deepEqual(await api.testSearchKey(' typed-key '), { results: 3 });
  assert.deepEqual(await api.testSearchKey('   '), { results: 3 });
  assert.deepEqual(bodies, [{ anysearch_api_key: 'typed-key' }, {}]);
});

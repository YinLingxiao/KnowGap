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
const api = load(path.join(root, 'lib/api/ai-config.ts'));
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; });
const status = { base_url: 'https://api.example/v1', model: 'test', has_api_key: true, configured: true };

test('old API-key configuration stays compatible and defaults to API-key authentication', async () => {
  global.fetch = async () => new Response(JSON.stringify(status));
  const config = await api.getAIConfig();
  assert.equal(config.authMode, 'api_key');
  assert.equal(config.projectId, '');
  assert.equal(config.location, 'global');
  global.fetch = async (_, options) => {
    assert.deepEqual(JSON.parse(options.body), { base_url: status.base_url, model: 'test', api_key: 'synthetic-key' });
    return new Response(JSON.stringify(status));
  };
  await api.saveAIConfig({ baseUrl: status.base_url, model: 'test', apiKey: 'synthetic-key' });
});

test('ADC test/save sends project and region but never a typed or cached API key', async () => {
  let count = 0;
  global.fetch = async (url, options) => {
    count += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.auth_mode, 'adc');
    assert.equal(body.project_id, 'knowgap-test');
    assert.equal(body.location, 'global');
    assert.ok(!('api_key' in body));
    return new Response(JSON.stringify(String(url).endsWith('/test')
      ? { status: 'ok', model: 'gemini-4-argon', structured_output: true }
      : { ...status, base_url: body.base_url, model: body.model, auth_mode: 'adc', project_id: body.project_id, location: 'global', has_api_key: false }));
  };
  const input = { baseUrl: 'https://aiplatform.googleapis.com/v1/projects/knowgap-test/locations/global/publishers/google/models',
    model: 'gemini-4-argon', apiKey: 'must-not-send', authMode: 'adc', projectId: ' knowgap-test ', location: ' global ' };
  assert.equal((await api.testAIConfig(input)).structuredOutput, true);
  const saved = await api.saveAIConfig(input);
  assert.equal(saved.authMode, 'adc');
  assert.equal(saved.hasApiKey, false);
  assert.equal(saved.configured, true);
  assert.equal(count, 2);
});

test('ChatGPT mode maps account/plan state and never sends an API key', async () => {
  global.fetch = async (_, options) => {
    if (options?.method !== 'PUT') return new Response(JSON.stringify({
      base_url: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', has_api_key: false, configured: true,
      auth_mode: 'chatgpt', chatgpt: { connected: true, email: 'a@example.com', plan_enabled: true,
        reauth_required: false, expires_at: 1, accounts: [], error: '' },
    }));
    assert.deepEqual(JSON.parse(options.body), {
      base_url: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', auth_mode: 'chatgpt' });
    return new Response(JSON.stringify({ base_url: 'https://api.openai.com/v1', model: 'gpt-6.1-sol',
      has_api_key: false, configured: true, auth_mode: 'chatgpt' }));
  };
  const config = await api.getAIConfig();
  assert.equal(config.authMode, 'chatgpt');
  assert.equal(config.chatgpt.connected, true);
  assert.equal(config.chatgpt.email, 'a@example.com');
  await api.saveAIConfig({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol',
    apiKey: 'must-not-send', authMode: 'chatgpt' });
});

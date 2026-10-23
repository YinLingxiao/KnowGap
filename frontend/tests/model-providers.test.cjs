const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../src');
const source = fs.readFileSync(path.join(root, 'lib/modelProviders.ts'), 'utf8');
const loaded = { exports: {} };
new Function('module', 'exports', ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText)(loaded, loaded.exports);
const { MODEL_PROVIDERS, findProvider, matchProvider, checkBaseUrl, normalizeBaseUrl, vertexAdcBaseUrl, checkVertexAdc } = loaded.exports;
const globalUrl = 'https://aiplatform.googleapis.com/v1/projects/knowgap-test/locations/global/endpoints/openapi';
const regionalUrl = 'https://us-central1-aiplatform.googleapis.com/v1/projects/knowgap-test/locations/us-central1/endpoints/openapi';
const nativeUrl = 'https://aiplatform.googleapis.com/v1/publishers/google/models';

test('Vertex preset supplies the native Express endpoint, Argon model and API-key instructions', () => {
  const vertex = findProvider('vertex');
  assert.equal(vertex.name, 'Google Vertex AI');
  assert.equal(vertex.baseUrl, nativeUrl);
  assert.equal(vertex.modelHint, 'gemini-4-argon');
  assert.equal(vertex.keyLabel, 'Vertex Express API Key');
  assert.match(vertex.keyHint, /不是 OAuth Access Token 或 AI Studio API Key/);
  assert.match(vertex.keyHint, /请求头/);
  assert.equal(MODEL_PROVIDERS.at(-1).id, 'custom');
});

test('native Express URLs select Vertex; old OAuth addresses remain valid custom URLs', () => {
  for (const url of [nativeUrl, ` ${nativeUrl}/ `, nativeUrl.replace('/v1/', '/v1beta1/')]) {
    assert.equal(matchProvider(url).id, 'vertex');
    assert.equal(checkBaseUrl(url), null);
  }
  for (const url of [globalUrl, regionalUrl, regionalUrl.replace('/v1/', '/v1beta1/'), ` ${globalUrl}/ `]) {
    assert.equal(matchProvider(url).id, 'custom');
    assert.equal(checkBaseUrl(url), null);
  }
  assert.equal(normalizeBaseUrl(` ${globalUrl}/ `), globalUrl);
  for (const url of [globalUrl.replace('aiplatform.googleapis.com', 'aiplatform.googleapis.com.evil.example'),
    'https://generativelanguage.googleapis.com/v1beta/openai', 'not a URL']) {
    assert.equal(matchProvider(url).id, 'custom');
  }
});

test('native methods, key query parameters and wrong Express hosts are blocked before testing or saving', () => {
  assert.match(checkBaseUrl(nativeUrl + '/gemini-4-argon:generateContent'), /根地址/);
  assert.match(checkBaseUrl(nativeUrl + '?key=fake'), /密钥参数/);
  assert.match(checkBaseUrl(nativeUrl.replace('https:', 'http:')), /https/);
  assert.match(checkBaseUrl(nativeUrl.replace('aiplatform.', 'us-central1-aiplatform.')), /全局接口/);
  assert.match(checkBaseUrl(globalUrl.replace('knowgap-test', 'PROJECT_ID')), /PROJECT_ID/);
  for (const project of ['{project}', '<project>', '%7Bproject%7D', '%']) {
    assert.match(checkBaseUrl(globalUrl.replace('knowgap-test', project)), /项目 ID/);
  }
  assert.match(checkBaseUrl(globalUrl + '/chat/completions'), /去掉末尾/);
  assert.match(checkBaseUrl(globalUrl.replace('/endpoints/openapi', '/publishers/google/models/gemini:generateContent')), /兼容接口/);
  assert.match(checkBaseUrl(globalUrl.replace('/global/', '/us-central1/')), /区域一致/);
  assert.match(checkBaseUrl(regionalUrl.replace('/us-central1/', '/global/')), /区域一致/);
});

test('existing presets retain exact matching and URL validation', () => {
  for (const provider of MODEL_PROVIDERS.filter((item) => !['vertex', 'chatgpt', 'custom'].includes(item.id))) {
    assert.equal(matchProvider(provider.baseUrl + '/').id, provider.id);
    assert.equal(checkBaseUrl(provider.baseUrl), null);
  }
  assert.equal(matchProvider('https://api.openai.com/v1').id, 'openai');
  assert.equal(findProvider('chatgpt').baseUrl, 'https://api.openai.com/v1');
  assert.match(findProvider('chatgpt').name, /ChatGPT/);
  assert.equal(checkBaseUrl(''), null);
  assert.match(checkBaseUrl('ftp://example.com'), /http/);
});

test('the settings card uses provider auth hints and restores the saved project URL without retaining typed secrets', () => {
  const card = fs.readFileSync(path.join(root, 'components/settings/ModelAccessCard.tsx'), 'utf8');
  assert.match(card, /provider\.keyLabel \?\? "API Key"/);
  assert.match(card, /provider\.urlHint/);
  assert.match(card, /provider\.keyHint/);
  assert.match(card, /back \? config!\.baseUrl : item\.baseUrl/);
  assert.match(card, /model: back \? config!\.model : "",\s*apiKey: ""/);
  assert.match(card, /const ready = Boolean\([^;]*!urlProblem/);
});

test('ADC generates global and regional native roots without losing the Express preset', () => {
  assert.equal(findProvider('vertex').baseUrl, nativeUrl);
  for (const region of ['global', 'us-central1', 'asia-northeast1']) {
    const url = vertexAdcBaseUrl('knowgap-test', region);
    assert.equal(checkVertexAdc('knowgap-test', region), null);
    assert.equal(checkBaseUrl(url), null);
    assert.equal(matchProvider(url).id, 'vertex');
    assert.ok(url.includes(`/projects/knowgap-test/locations/${region}/publishers/google/models`));
  }
  assert.match(vertexAdcBaseUrl('knowgap-test', 'global'), /^https:\/\/aiplatform\.googleapis\.com\//);
  assert.match(vertexAdcBaseUrl('knowgap-test', 'us-central1'), /^https:\/\/us-central1-aiplatform\.googleapis\.com\//);
  assert.ok(checkVertexAdc('', 'global'));
  assert.ok(checkVertexAdc('../secret', 'global'));
  assert.ok(checkVertexAdc('knowgap-test', 'global/../evil'));
  assert.ok(checkBaseUrl(vertexAdcBaseUrl('knowgap-test', 'global') + '?key=private'));
});

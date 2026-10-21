// Service-model and vision wire adapter: mapping, secret handling and structured errors.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-vision-client-'));
fs.mkdirSync(path.join(temporary, 'lib/api'), { recursive: true });
const compiled = [];
for (const relative of ['lib/config.ts', 'lib/api/errors.ts', 'lib/api/http-client.ts', 'lib/api/vision-client.ts']) {
  const output = path.join(temporary, relative.replace(/\.ts$/, '.js'));
  fs.writeFileSync(output, ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText);
  compiled.push(output);
}
const vision = require(path.join(temporary, 'lib/api/vision-client.js'));
const originalFetch = global.fetch;
const originalCreateObjectURL = URL.createObjectURL;
after(() => {
  global.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  for (const output of compiled) fs.unlinkSync(output);
  fs.rmdirSync(path.join(temporary, 'lib/api'));
  fs.rmdirSync(path.join(temporary, 'lib'));
  fs.rmdirSync(temporary);
});

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const wireConfig = {
  logic_model: {
    base_url: '', model: 'gemini-4-argon', api_key_configured: false,
    effective: { model: 'gemini-4-argon', source: 'service_models', configured: true },
  },
  vision_model: {
    base_url: '', model: 'qwen3.5-plus', enabled: true, bbox_format: 'xyxy_1000', api_key_configured: false,
    effective: { model: 'qwen3.5-plus', source: 'service_models', configured: true, bbox_format: 'xyxy_1000' },
  },
  memory_model: { model: '', enabled: false, effective: { model: 'gemini-4-argon', source: 'logic' } },
  suggest_reply_enabled: true,
  dual_model_relay: true,
  circuit_confirm_first: true,
};

test('service-model GET maps public status without exposing a key', async () => {
  global.fetch = async (url, options) => {
    assert.match(String(url), /\/api\/vision\/service-models$/);
    assert.equal(options.method, undefined);
    return json(wireConfig);
  };
  const result = await vision.getServiceModels();
  assert.equal(result.logicModel.effective.model, 'gemini-4-argon');
  assert.equal(result.visionModel.bboxFormat, 'xyxy_1000');
  assert.equal(result.visionModel.effective.source, 'service_models');
  assert.deepEqual(result.memoryModel.effective, { model: 'gemini-4-argon', source: 'logic' });
  assert.equal(JSON.stringify(result).includes('api_key'), false);
});

test('service-model PUT uses snake_case and omits blank secrets', async () => {
  global.fetch = async (url, options) => {
    assert.match(String(url), /\/api\/vision\/service-models$/);
    assert.equal(options.method, 'PUT');
    assert.deepEqual(JSON.parse(options.body), {
      logic_model: { base_url: '', model: 'gemini-4-argon' },
      vision_model: { base_url: '', model: 'qwen3.5-plus', enabled: true, bbox_format: 'xyxy_1000' },
      memory_model: { model: '', enabled: false },
      suggest_reply_enabled: false,
      dual_model_relay: true,
      circuit_confirm_first: true,
    });
    return json({ ...wireConfig, suggest_reply_enabled: false });
  };
  const result = await vision.saveServiceModels({
    logicModel: { baseUrl: ' ', model: ' gemini-4-argon ', apiKey: '' },
    visionModel: { baseUrl: '', model: 'qwen3.5-plus', apiKey: '', enabled: true, bboxFormat: 'xyxy_1000' },
    memoryModel: { model: '', enabled: false },
    suggestReplyEnabled: false,
    dualModelRelay: true,
    circuitConfirmFirst: true,
  });
  assert.equal(result.suggestReplyEnabled, false);
});

test('analyze maps relay result and never sends client-side model settings', async () => {
  global.fetch = async (url, options) => {
    assert.match(String(url), /\/api\/vision\/analyze$/);
    assert.deepEqual(JSON.parse(options.body), { image_id: 'img_abcdefghijklmnopqrstuvwx', prompt: '哪里错了？', mode: 'auto' });
    return json({
      scene: 'handwriting', mode: 'annotate', structured_problem: 'x=2', recommended_effort: 'high',
      route: { effort: 'high', reason: '多步', source: 'auto' }, relay_effort: 'high',
      widget: { type: 'image_annotator' }, widget_markdown: '```knowgap-widget\n{}\n```',
      relay_prompt: 'relay', summary: '一处错误',
      image: { image_id: 'img_abcdefghijklmnopqrstuvwx', width: 100, height: 200, marker: '[[kg-image:img_abcdefghijklmnopqrstuvwx]]' },
      models: { vision: 'qwen3.5-plus', judge: 'logic', logic: 'gemini-4-argon' }, cached: true,
    });
  };
  const result = await vision.analyzeImage(
    { imageId: 'img_abcdefghijklmnopqrstuvwx' },
    { prompt: ' 哪里错了？ ', mode: 'auto' },
  );
  assert.equal(result.structuredProblem, 'x=2');
  assert.equal(result.image.width, 100);
  assert.deepEqual(result.models, { vision: 'qwen3.5-plus', judge: 'logic', logic: 'gemini-4-argon' });
  assert.equal(result.cached, true);
});

test('netlist confirmation keeps structured issues on a validation error', async () => {
  global.fetch = async () => json({ detail: {
    message: '网表仍有连接错误。',
    issues: [{ level: 'error', code: 'self_loop', message: 'R1 两端相同', ref: 'R1' }],
  } }, 422);
  await assert.rejects(
    vision.confirmNetlist('net_abcdefghijklmnopqrstuvwx', 2, null),
    (error) => error.kind === 'validation' && error.issues[0].code === 'self_loop' && error.issues[0].ref === 'R1',
  );
});

test('image constants and authenticated blob loading are stable', async () => {
  assert.equal(vision.MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.deepEqual(vision.ACCEPTED_IMAGE_TYPES, ['image/png', 'image/jpeg', 'image/webp']);
  let calls = 0;
  URL.createObjectURL = () => 'blob:test-image';
  global.fetch = async (url) => {
    calls += 1;
    assert.match(String(url), /\/api\/vision\/images\/img_abcdefghijklmnopqrstuvwx$/);
    return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
  };
  assert.equal(await vision.loadImageUrl('img_abcdefghijklmnopqrstuvwx'), 'blob:test-image');
  assert.equal(await vision.loadImageUrl('img_abcdefghijklmnopqrstuvwx'), 'blob:test-image');
  assert.equal(calls, 1, 'the shared blob URL promise is cached');
});

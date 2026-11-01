// Compile only the API request layer into an isolated temp folder; no new test framework or network.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-adapter-'));
fs.mkdirSync(path.join(temporary, 'lib/api'), { recursive: true });
const compiled = [];
for (const relative of ['lib/config.ts', 'lib/api/errors.ts', 'lib/api/http-client.ts', 'lib/api/material-client.ts']) {
  const output = path.join(temporary, relative.replace(/\.ts$/, '.js'));
  fs.writeFileSync(output, ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText);
  compiled.push(output);
}
const { request } = require(path.join(temporary, 'lib/api/http-client.js'));
const { createMaterialClient } = require(path.join(temporary, 'lib/api/material-client.js'));
const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
  for (const output of compiled) fs.unlinkSync(output);
  fs.rmdirSync(path.join(temporary, 'lib/api'));
  fs.rmdirSync(path.join(temporary, 'lib'));
  fs.rmdirSync(temporary);
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
for (const [status, kind] of [[409, 'conflict'], [422, 'validation'], [502, 'model_unavailable'], [503, 'model_unavailable'], [504, 'timeout']]) {
  test(`HTTP ${status} has a readable, correctly classified error`, async () => {
    global.fetch = async () => json({ detail: status === 422 ? [{ msg: '至少一个字符' }] : '可读错误' }, status);
    await assert.rejects(request('http://backend.example', '/api/ai/config'), error =>
      error.kind === kind && error.message === (status === 422 ? '至少一个字符' : '可读错误'));
  });
}

test('request timeout covers reading the response body, not just receiving headers', async () => {
  global.fetch = async (_url, options) => ({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  await assert.rejects(request('http://backend.example', '/health', { timeoutMs: 5 }), error => error.kind === 'timeout');
});

const source = { id: 'source-1', document_id: 'doc-1', title: 'Lecture.pdf', label: '资料1',
  page: 2, start_line: null, end_line: null, excerpt: 'Stack follows LIFO.' };

test('course upload sends FormData with browser-generated boundary and maps document metadata', async () => {
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://backend.example/api/materials');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], undefined);
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('file').name, 'lecture.md');
    return json({ id: 'doc1', title: 'lecture.md', kind: 'md', page_count: 0, chunk_count: 1, created_at: 't1' }, 201);
  };
  const uploaded = await createMaterialClient('http://backend.example').upload(new File(['栈'], 'lecture.md'));
  assert.equal(uploaded.chunkCount, 1);
});

test('course search encodes query, keeps location, and accepts DELETE 204', async () => {
  const client = createMaterialClient('http://backend.example');
  global.fetch = async (url) => { assert.ok(url.includes(encodeURIComponent('栈 LIFO'))); return json([source]); };
  assert.equal((await client.search('栈 LIFO'))[0].page, 2);
  global.fetch = async () => new Response(null, { status: 204 });
  await client.remove('doc-1');
  global.fetch = async () => json({detail: '单份资料不能超过 5 MB。'}, 413);
  await assert.rejects(client.upload(new File(['x'], 'large.txt')), error => error.kind === 'validation');
});

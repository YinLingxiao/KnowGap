const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Load the real read-only contract and HTTP adapter without creating build artifacts.
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
    if (name.startsWith('@/')) return load(path.join(root, name.slice(2) + '.ts'));
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    return require(name);
  });
  return module.exports;
}
const contract = load(path.join(root, 'lib/chat/attachments.ts'));
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; });

test('all document extensions and image formats use the shared accept list', () => {
  for (const extension of contract.DOCUMENT_EXTENSIONS) {
    assert.ok(contract.ATTACHMENT_ACCEPT.includes(extension));
    assert.ok(contract.isDocumentFile(`文件${extension.toUpperCase()}`));
  }
  assert.equal(contract.isDocumentFile('旧课件.ppt'), false);
  assert.equal(contract.isDocumentFile('图片.png'), false);
  assert.ok(contract.ATTACHMENT_ACCEPT.includes('image/webp'));
  assert.equal(contract.MAX_FILE_MARKERS, 5);
});

test('roundtrip keeps multiple markers before the body, including attachment-only messages', () => {
  const files = [{ id: 'doc-one', name: '第3章.pptx' }, { id: 'doc_two', name: '实验数据.xlsx' }];
  const markers = files.map(contract.formatFileMarker).join('\n');
  assert.deepEqual(contract.parseFileMarkers(markers + '\n\n精读\n第二行'), { files, body: '精读\n第二行' });
  assert.deepEqual(contract.parseFileMarkers(markers), { files, body: '' });
});

test('sanitizes marker delimiters; ordinary text, image markers and mid-body markers stay intact', () => {
  const marker = contract.formatFileMarker({ id: 'doc-1', name: 'a|b]\nc.pdf' });
  assert.deepEqual(contract.parseFileMarkers(marker).files, [{ id: 'doc-1', name: 'a b  c.pdf' }]);
  const body = '解释这张图\n[[kg-image:example]]\n[[file:doc-1|不是开头.pdf]]';
  assert.deepEqual(contract.parseFileMarkers(body), { files: [], body });
  assert.equal(contract.parseFileMarkers('[[file:bad/id|文档.pdf]]').files.length, 0);
});

test('recognizes at most five markers and stops at the first body line', () => {
  const text = Array.from({ length: 6 }, (_, index) => contract.formatFileMarker({ id: `doc-${index}`, name: `${index}.pdf` })).join('\n');
  const result = contract.parseFileMarkers(text);
  assert.equal(result.files.length, 5);
  assert.equal(result.body, '[[file:doc-5|5.pdf]]');
});

test('table intents differ from document intents and include a prompt without sending', () => {
  assert.equal(contract.intentsFor('xlsx', '实验.xlsx').length, 2);
  assert.equal(contract.intentsFor('text', '实验.CSV')[0].id, 'file_data_explain');
  assert.equal(contract.intentsFor('pptx', '课件.pptx').length, 3);
  assert.ok(contract.intentsFor('pdf', '作业.pdf').every(intent => intent.prompt.length > 0));
});

test('upload uses conversation-scoped multipart endpoint and maps parsing scale', async () => {
  global.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/api/conversations/chat%2Fone/attachments'));
    assert.equal(options.method, 'POST');
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('file').name, '第3章.pptx');
    return new Response(JSON.stringify({ id: 'doc-one', name: '第3章.pptx', kind: 'pptx', units: 24,
      unit_label: '张幻灯片', chars: 18342, outline: ['调度时机'], subject_id: 'space-one' }), { status: 201 });
  };
  const result = await contract.attachmentApi.upload('chat/one', new File(['slides'], '第3章.pptx'));
  assert.equal(result.units, 24);
  assert.equal(result.unitLabel, '张幻灯片');
  assert.equal(result.subjectId, 'space-one');
});

test('415 / 413 / 422 retain exact backend Chinese explanations', async () => {
  for (const [status, detail] of [[415, '请另存为 .docx/.pptx/.xlsx'], [413, '单文件不能超过 20 MB'],
    [422, '这份 PDF 是扫描图片，暂不支持识别文字']]) {
    global.fetch = async () => new Response(JSON.stringify({ detail }), { status });
    await assert.rejects(contract.attachmentApi.upload('chat-one', new File(['data'], '文件.pdf')),
      error => error.status === status && error.message === detail);
  }
});

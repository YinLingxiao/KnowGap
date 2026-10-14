// Compile only the API adapter into an isolated temp folder; no new test framework or network.
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
const { createHttpClient, request } = require(path.join(temporary, 'lib/api/http-client.js'));
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
const memory = {
  id: 'memory-1', student_id: 'demo-student-001', topic_key: 'stack.lifo', issue_key: 'lifo_order',
  summary: '需要检查栈顶', status: 'suspected', confidence: 0.7, evidence_count: 1, updated_at: '2026-10-14T01:00:00+00:00',
  evidence_refs: [{ message_id: 'message-1', session_id: 'session-1', problem_id: 'stack-sequence-001',
    quote: '合法', assessment: 'incorrect', phase: 'initial', created_at: '2026-10-14T01:00:00+00:00' }],
};
const diagnosis = { topic_key: 'stack.lifo', assessment: 'incorrect', issue: '栈顶顺序问题', confidence: 0.7, evidence: '合法' };
const turn = { session_id: 'session-1', turn: 1, diagnosis, reply: '当前栈顶是什么？', used_memory_ids: ['memory-0'],
  memory_changes: [{ action: 'created', memory }] };

test('actual wire request combines answer and reasoning; response preserves diagnosis and memory evidence', async () => {
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://backend.example/api/diagnosis');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {
      student_id: 'demo-student-001', problem_id: 'stack-sequence-001', answer: '合法\n\n解题思路：\n数字相同',
    });
    return json(turn);
  };
  const result = await createHttpClient('http://backend.example/').startSession({
    studentId: 'demo-student-001', problemId: 'stack-sequence-001', answer: ' 合法 ', reasoning: ' 数字相同 ',
  });
  assert.equal(result.diagnosis.assessment, 'incorrect');
  assert.equal(result.reply.content, turn.reply);
  assert.equal(result.reply.role, 'tutor');
  assert.equal(result.reply.phase, undefined);
  assert.deepEqual(result.usedMemoryIds, ['memory-0']);
  assert.deepEqual(result.memoryChanges[0], { memoryId: 'memory-1', action: 'created', summary: memory.summary, toStatus: 'suspected' });
});

test('followup keeps uncertain distinct from correct and propagates updated turn/memory context', async () => {
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://backend.example/api/sessions/session-1/messages');
    assert.deepEqual(JSON.parse(options.body), { content: '不太确定' });
    return json({ ...turn, turn: 2, diagnosis: { ...diagnosis, assessment: 'uncertain', issue: null }, memory_changes: [] });
  };
  const result = await createHttpClient('http://backend.example').sendMessage('session-1', ' 不太确定 ');
  assert.equal(result.diagnosis.assessment, 'uncertain');
  assert.equal(result.diagnosis.confidence, 0.7);
  assert.equal(result.turn, 2);
  assert.deepEqual(result.usedMemoryIds, ['memory-0']);
});

test('session recovery uses persisted IDs/times, latest observation, and separate original submission', async () => {
  global.fetch = async () => json({ id: 'session-1', student_id: 'demo-student-001', problem_id: 'stack-sequence-001', turn: 2,
    created_at: '2026-10-14T01:00:00+00:00', messages: [
      { id: 'u1', role: 'user', content: '合法\n\n解题思路：\n数字相同', created_at: 't1', diagnosis, used_memory_ids: [] },
      { id: 'a1', role: 'assistant', content: '栈顶是什么？', created_at: 't1', diagnosis: null, used_memory_ids: [] },
      { id: 'u2', role: 'user', content: '栈顶是2', created_at: 't2', diagnosis: { ...diagnosis, assessment: 'correct', issue: null }, used_memory_ids: [] },
      { id: 'a2', role: 'assistant', content: '下一步呢？', created_at: 't2', diagnosis: null, used_memory_ids: ['memory-1'] },
    ] });
  const result = await createHttpClient('http://backend.example').getSession('session-1');
  assert.deepEqual(result.submission, { answer: '合法', reasoning: '数字相同' });
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[1].role, 'student');
  assert.equal(result.messages[1].id, 'u2');
  assert.equal(result.messages[1].createdAt, 't2');
  assert.equal(result.diagnosis.assessment, 'correct');
  assert.deepEqual(result.usedMemoryIds, ['memory-1']);
});

test('memory mapping preserves source references and DELETE accepts empty 204 body', async () => {
  global.fetch = async (url, options) => options.method === 'DELETE' ? new Response(null, { status: 204 }) : json([memory]);
  const client = createHttpClient('http://backend.example');
  const [mapped] = await client.listMemories('demo-student-001');
  assert.equal(mapped.evidenceRefs[0].messageId, 'message-1');
  assert.equal(mapped.evidenceRefs[0].sessionId, 'session-1');
  assert.equal(mapped.evidenceRefs[0].excerpt, '合法');
  assert.equal(mapped.evidenceCount, 1);
  assert.equal(await client.deleteMemory('memory-1'), undefined);
});

for (const [status, kind] of [[409, 'conflict'], [422, 'validation'], [502, 'model_unavailable'], [503, 'model_unavailable'], [504, 'timeout']]) {
  test(`HTTP ${status} has a readable, correctly classified error`, async () => {
    global.fetch = async () => json({ detail: status === 422 ? [{ msg: '至少一个字符' }] : '可读错误' }, status);
    await assert.rejects(request('http://backend.example', '/api/diagnosis'), error =>
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

test('teaching citations survive turn mapping and session recovery', async () => {
  global.fetch = async () => json({ ...turn, sources: [source] });
  const client = createHttpClient('http://backend.example');
  const result = await client.startSession({ studentId: 'demo-student-001', problemId: 'stack-sequence-001', answer: '合法', reasoning: '' });
  assert.equal(result.reply.sources[0].page, 2);
  assert.equal(result.reply.sources[0].documentId, 'doc-1');
  global.fetch = async () => json({ id: 's1', problem_id: 'stack-sequence-001', turn: 1, messages: [
    { id: 'u1', role: 'user', content: '合法', diagnosis, created_at: 't1', sources: [] },
    { id: 'a1', role: 'assistant', content: '检查栈顶。[资料1]', diagnosis: null, created_at: 't1', sources: [source] },
  ] });
  assert.equal((await client.getSession('s1')).messages[0].sources[0].excerpt, source.excerpt);
});

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

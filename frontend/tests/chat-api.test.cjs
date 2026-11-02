// Exercise the real chat adapter without a network server or additional test dependencies.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-chat-'));
for (const name of ['lib/config.ts', 'lib/api/errors.ts', 'lib/api/http-client.ts', 'lib/chat/plan.ts', 'lib/chat/api.ts']) {
  const output = path.join(temp, name.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  let js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  js = js.replace(/require\("@\/([^\"]+)"\)/g, (_, specifier) => {
    const relative = path.relative(path.dirname(output), path.join(temp, specifier + '.js')).replace(/\\/g, '/');
    return `require("./${relative}")`;
  });
  fs.writeFileSync(output, js);
}
const { chatApi } = require(path.join(temp, 'lib/chat/api.js'));
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; fs.rmSync(temp, { recursive: true, force: true }); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('SSE survives CRLF and multibyte characters split across network chunks', async () => {
  const previousWindow = global.window;
  global.window = { setTimeout, clearTimeout };
  const bytes = new TextEncoder().encode('event: delta\r\ndata: {"text":"你好😀"}\r\n\r\nevent: done\r\ndata: {"message":null}\r\n\r\n');
  global.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }));
  const events = [];
  try {
    assert.equal(await chatApi.sendMessage('c1', '问题', 'split-request', (event) => events.push(event), new AbortController().signal), 'ended');
    assert.deepEqual(events.map((event) => event.type), ['delta', 'done']);
    assert.equal(events[0].text, '你好😀');
  } finally { global.window = previousWindow; }
});

test('connection loss attaches after the last received event without posting the question twice', async () => {
  const previousWindow = global.window;
  global.window = { setTimeout, clearTimeout };
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, method: options.method });
    const text = requests.length === 1
      ? 'event: start\ndata: {"discarded_ids":[]}\nid: reply-123:1\n\nevent: delta\ndata: {"text":"前半"}\nid: reply-123:2\n\n'
      : 'event: delta\ndata: {"text":"后半"}\nid: reply-123:3\n\nevent: done\ndata: {"message":null}\nid: reply-123:4\n\n';
    return new Response(text);
  };
  const events = [];
  try {
    assert.equal(await chatApi.sendMessage('c/1', '问题', 'resume-request', (event) => events.push(event), new AbortController().signal), 'ended');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[1].method, 'GET');
    assert.ok(requests[1].url.endsWith('/conversations/c%2F1/runs/reply-123/events?after=2'));
    assert.equal(events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), '前半后半');
    assert.deepEqual(events.filter((event) => event.type === 'connection').map((event) => event.reconnecting), [true, false]);
  } finally { global.window = previousWindow; }
});

test('queue editing and targeted Stop use the owning conversation and run identifiers', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    return json(options.method === 'POST' && url.endsWith('/stop') ? { stopped: true } : { paused: true, items: [] });
  };
  await chatApi.editQueued('c/1', 'q/1', '改成例子');
  await chatApi.removeQueued('c/1', 'q/1');
  await chatApi.resumeQueue('c/1');
  await chatApi.stop('c/1', 'run-1');
  assert.ok(calls[0].url.endsWith('/c%2F1/outbox/q%2F1'));
  assert.deepEqual(calls[0].body, { content: '改成例子' });
  assert.equal(calls[1].method, 'DELETE');
  assert.deepEqual(calls[3].body, { run_id: 'run-1' });
});

const wire = {
  id: 'thread-1', title: '基础', messages: [{ id: 'm1', role: 'assistant', content: '请选择', status: 'complete',
    thread_proposals: [{ id: 'p1', title: '概念', task: '讲解基础', reason: '先熟悉术语', thread_id: 't1' }],
    checkpoint_available: true, checkpoint_blocked_reason: null }],
};

test('persisted proposal and checkpoint metadata survive chat message mapping', async () => {
  global.fetch = async () => json(wire);
  const conversation = await chatApi.getConversation('thread-1');
  assert.deepEqual(conversation.messages[0].threadProposals, [
    { id: 'p1', title: '概念', task: '讲解基础', reason: '先熟悉术语', threadId: 't1' },
  ]);
  assert.equal(conversation.messages[0].checkpointAvailable, true);
  assert.equal(conversation.messages[0].checkpointBlockedReason, null);
});

test('confirmation sends only persisted proposal identifiers, never client-authored tasks', async () => {
  global.fetch = async (url, options) => {
    assert.ok(url.endsWith('/api/conversations/main%2F1/confirm-proposal'));
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { message_id: 'm1', proposal_id: 'p1' });
    return json({ thread_id: 't1', status: 'queued' });
  };
  assert.equal(await chatApi.confirmProposal('main/1', 'm1', 'p1'), 't1');
});

test('usage mapping preserves unknown cache and missing provider requests', async () => {
  const total = { requests: 4, reported_requests: 3, input_tokens: 300, output_tokens: 40, cached_tokens: null };
  global.fetch = async () => json({ total, conversations: { t1: total } });
  const usage = await chatApi.spaceUsage('s1');
  assert.deepEqual(usage.total, { requests: 4, reportedRequests: 3, inputTokens: 300, outputTokens: 40, cachedTokens: null });
  assert.deepEqual(usage.conversations.t1, usage.total);
});

test('unsafe checkpoint resume surfaces the backend conflict reason', async () => {
  global.fetch = async (url, options) => {
    assert.ok(url.endsWith('/api/conversations/t1/messages/m1/resume'));
    assert.equal(options.method, 'POST');
    return json({ detail: '写操作结果未知，请先核查。' }, 409);
  };
  await assert.rejects(chatApi.resumeThread('t1', 'm1'), /写操作结果未知/);
});

test('interview status preserves skip, draft evidence and server progress', async () => {
  const draft = { background: { value: '学历史', quote: '我学历史', declined: false } };
  global.fetch = async () => json({ status: 'skipped', onboarded: false, conversation_id: 'c1', has_user_profile: false,
    stage: 'explanation', ready: false, version: 3, draft });
  const state = await chatApi.onboardingStatus();
  assert.equal(state.status, 'skipped');
  assert.equal(state.conversationId, 'c1');
  assert.equal(state.stage, 'explanation');
  assert.deepEqual(state.draft, draft);
});

test('conversation summaries keep model_key and model updates send it back', async () => {
  global.fetch = async () => json({
    id: 'c1', title: '基础', title_source: 'auto', model_key: 'prov-a11d5e01/google/gemini-3.5-flash', messages: [],
  });
  assert.equal((await chatApi.getConversation('c1')).modelKey, 'prov-a11d5e01/google/gemini-3.5-flash');
  global.fetch = async () => json({ id: 'c2', title: '未设置', title_source: 'auto', messages: [] });
  assert.equal((await chatApi.getConversation('c2')).modelKey, null);
  global.fetch = async (url, options) => {
    assert.equal(url.endsWith('/api/conversations/c%2F1/model'), true);
    assert.equal(options.method, 'PUT');
    assert.deepEqual(JSON.parse(options.body), { model_key: null });
    return json({ model_key: null });
  };
  assert.deepEqual(await chatApi.setConversationModel('c/1', null), { modelKey: null });
});

test('a deleted model announces the fallback before the reply', async () => {
  const previousWindow = global.window;
  global.window = { setTimeout, clearTimeout };
  const events = [];
  const body = [
    'event: start',
    'data: {"model_notice":"原模型不可用，已改用默认模型","discarded_ids":[]}',
    '',
    'event: model_notice',
    'data: {"detail":"原模型不可用，已改用默认模型"}',
    '',
    'event: done',
    'data: {"message":null}',
    '',
  ].join('\n');
  const encoded = new TextEncoder().encode(body);
  global.fetch = async () => new Response(encoded, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await chatApi.sendMessage('c1', '继续', 'req-00000009', (event) => events.push(event), new AbortController().signal);
    assert.equal(events[0].type, 'start');
    assert.equal(events[0].modelNotice, '原模型不可用，已改用默认模型');
    assert.deepEqual(events.find((event) => event.type === 'model_notice'), {
      type: 'model_notice', detail: '原模型不可用，已改用默认模型',
    });
  } finally {
    global.window = previousWindow;
  }
});

test('skip is separate from completion and confirmation failures propagate', async () => {
  global.fetch = async (url) => {
    assert.ok(url.endsWith('/api/onboarding/skip'));
    return json({ status: 'skipped' });
  };
  await chatApi.skipOnboarding();
});

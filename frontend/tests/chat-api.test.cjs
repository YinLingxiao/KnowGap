// Exercise the real chat adapter without a network server or additional test dependencies.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowgap-chat-'));
for (const name of ['lib/config.ts', 'lib/api/errors.ts', 'lib/api/http-client.ts', 'lib/chat/api.ts']) {
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

test('profile confirmation sends revision and user-edited entries', async () => {
  global.fetch = async (url, options) => {
    assert.ok(url.endsWith('/api/onboarding/complete'));
    assert.deepEqual(JSON.parse(options.body), { version: 4, entries: { explanation: '先举例' } });
    return json({ onboarded: true });
  };
  assert.deepEqual(await chatApi.completeOnboarding(4, { explanation: '先举例' }), { onboarded: true });
});

test('skip is separate from completion and confirmation failures propagate', async () => {
  global.fetch = async (url) => {
    assert.ok(url.endsWith('/api/onboarding/skip'));
    return json({ status: 'skipped' });
  };
  await chatApi.skipOnboarding();
  global.fetch = async () => json({ detail: '画像版本已变化' }, 409);
  await assert.rejects(chatApi.completeOnboarding(1, {}), /画像版本已变化/);
});

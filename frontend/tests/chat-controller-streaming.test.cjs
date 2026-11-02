const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function controllerHarness() {
  const states = [];
  const timers = new Map();
  const requests = [];
  const queued = [];
  let cursor = 0, timerId = 0;
  const react = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [states[slot], (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next; }];
    },
    useRef(initial) { const slot = cursor++; states[slot] ??= { current: initial }; return states[slot]; },
    useCallback: (fn) => fn, useMemo: (fn) => fn(), useEffect: () => {},
  };
  const api = {
    sendMessage(id, content, requestId, onEvent) {
      return new Promise((resolve) => requests.push({ id, content, requestId, onEvent, resolve }));
    },
    async enqueue(id, content, requestId) { queued.push({ id, content, requestId }); return { id: 'queued-1' }; },
    async listConversations() { return []; }, async listMemories() { return []; },
  };
  const box = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/hooks/useChat.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function('module', 'exports', 'require', js)(box, box.exports, (name) => {
    if (name === 'react') return react;
    if (name === '@/components/LanguageProvider') return { useI18n: () => ({ lang: 'zh', t: (key) => key }) };
    if (name === '@/lib/chat/api') return { chatApi: api };
    if (name === '@/lib/config') return { API_BASE_URL: 'http://example.test' };
    if (name === '@/lib/api/errors') return { toApiError: (error) => error };
    if (name === '@/lib/chat/attachments') return { parseFileMarkers: (text) => ({ files: [], body: text }) };
    return {};
  });
  const previousWindow = global.window;
  global.window = { setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id), dispatchEvent() {} };
  return {
    render() { cursor = 0; return box.exports.useChat(() => {}, 'test-user'); },
    requests, queued, timers, api,
    flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    close() { global.window = previousWindow; },
  };
}

function start(request, id) {
  request.onEvent({ type: 'start', conversation: null, userMessage: null, discardedIds: [],
    assistantMessage: { id, conversationId: 'c1', seq: id === 'reply-1' ? 2 : 4, role: 'assistant',
      status: 'streaming', content: '', reasoning: '', toolCalls: [] } });
}

test('token bursts publish one batched update, and final text flushes before completion', async () => {
  const h = controllerHarness();
  try {
    const sent = h.render().sendTo('c1', '第一问');
    const request = h.requests[0];
    start(request, 'reply-1');
    for (let index = 0; index < 100; index++) request.onEvent({ type: 'delta', text: '字' });
    request.onEvent({ type: 'reasoning', text: '思考' });
    assert.equal(h.timers.size, 1);
    assert.equal(h.render().messagesFor('c1').messages[0].content, '');
    h.flush();
    assert.equal(h.render().messagesFor('c1').messages[0].content, '字'.repeat(100));
    assert.equal(h.render().messagesFor('c1').messages[0].reasoning, '思考');
    request.onEvent({ type: 'delta', text: '尾部' });
    request.resolve('interrupted'); // Simulate an ended connection before a terminal snapshot.
    h.api.getConversation = async () => ({ id: 'c1', messages: [
      { id: 'reply-1', seq: 2, role: 'assistant', status: 'complete', content: '字'.repeat(100) + '尾部' },
    ] });
    assert.equal(await sent, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.render().messagesFor('c1').messages[0].content, '字'.repeat(100) + '尾部');
  } finally { h.close(); }
});

test('a follow-up while generating is saved to the server queue instead of being dropped', async () => {
  const h = controllerHarness();
  try {
    const first = h.render().sendTo('c1', '第一问');
    start(h.requests[0], 'reply-1');
    assert.equal(await h.render().sendTo('c1', '用生活例子解释'), true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.queued[0].content, '用生活例子解释');
    h.requests[0].resolve('ended');
    await first;
  } finally { h.close(); }
});

test('late analysis from an older reply cannot replace the next active stream', async () => {
  const h = controllerHarness();
  try {
    const first = h.render().sendTo('c1', '第一问');
    start(h.requests[0], 'reply-1');
    h.requests[0].onEvent({ type: 'done', message: { id: 'reply-1', seq: 2, role: 'assistant', status: 'complete', content: '已完成' } });
    const second = h.render().sendTo('c1', '第二问');
    start(h.requests[1], 'reply-2');
    h.requests[0].onEvent({ type: 'analysis', assistantMessage: { id: 'reply-1', seq: 2, content: '不应覆盖' }, userMessage: null });
    h.requests[0].resolve('ended');
    await first;
    assert.equal(h.render().streamFor('c1').phase, 'streaming');
    assert.equal(h.render().messagesFor('c1').messages[0].content, '已完成');
    h.requests[1].resolve('ended');
    await second;
  } finally { h.close(); }
});

test('stop and revise starts immediately even before React has rendered the stopped snapshot', async () => {
  const h = controllerHarness();
  try {
    const first = h.render().sendTo('c1', '第一问');
    start(h.requests[0], 'reply-1');
    h.render();
    const stopped = [];
    h.api.stop = async (cid, runId) => { stopped.push({ cid, runId }); return true; };
    h.api.getConversation = async () => ({ id: 'c1', messages: [
      { id: 'reply-1', seq: 2, role: 'assistant', status: 'cancelled', content: '原回复部分' },
    ] });
    const revision = h.render().reviseTo('c1', '新要求');
    for (let tick = 0; tick < 12 && h.requests.length < 2; tick++) await Promise.resolve();
    assert.deepEqual(stopped, [{ cid: 'c1', runId: 'reply-1' }]);
    assert.equal(h.queued.length, 0);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].content, '新要求');
    start(h.requests[1], 'reply-2');
    h.requests[0].resolve('ended'); h.requests[1].resolve('ended');
    await Promise.all([first, revision]);
  } finally { h.close(); }
});

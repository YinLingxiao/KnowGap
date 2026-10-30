const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { resolveI18n } = require('./i18n-support.cjs');

// Render the real message branch: a dispatched Thread owns exactly one card under its user message.
const source = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/MessageList.tsx'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', js)(loaded, loaded.exports, (name) => {
  if (resolveI18n(name)) return resolveI18n(name);
  if (name === 'react') return {
    ...React,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (current) => ({ current }),
    useCallback: (callback) => callback,
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
  if (name === 'react/jsx-runtime' || name === 'lucide-react') return require(name);
  if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => key }) };
  if (name === '@/lib/cx') return { cx: (...values) => values.filter(Boolean).join(' ') };
  if (name === '@/lib/chat/attachments') return { parseFileMarkers: (text) => ({ files: [], body: text }) };
  if (name === './FileCard') return {
    FileCard: () => null, kindFromName: () => 'md', openFileLibrary: () => {},
    recalledFile: () => null, rememberFile: () => {}, scaleOf: () => 0,
  };
  if (name === './Markdown') return { CopyButton: () => null, Markdown: () => null };
  if (name === './widgets/ImageMarker') return { hasVisionMarker: () => false, VisionMarkedText: () => null };
  if (name === './widgets/visionData') return { hasVisionMarker: () => false };
  if (name === '@/hooks/useSmoothText') return { useSmoothText: (text) => text };
  if (name === './SelectionToolbar') return { SelectionToolbar: () => null, SELECTABLE_ATTR: 'data-selectable' };
  if (name === './WorkingIndicator') return { WorkingIndicator: () => null };
  if (name === './ReasoningBlock') return { ReasoningBlock: () => null };
  if (name === './GeneratedFiles') return { GeneratedFiles: () => null };
  if (name === './ThreadProposals') return { ThreadProposals: () => null };
  return {};
});

function userMessage(threadIds = ['thread-linked']) {
  return {
    id: 'main-user-1', conversationId: 'main', seq: 1, role: 'user', kind: 'text', content: '带我复习链表',
    status: 'complete', error: null, replyTo: null, problemId: null, attempt: null, memoryChanges: [],
    usedMemoryIds: [], suggestedProblemId: null, sources: [], truncated: false, toolCalls: [],
    pendingApproval: null, preferencePrompt: null, nextActions: [], threadSummary: null,
    dispatchedThreads: threadIds.map((threadId) => ({ threadId })),
    createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z',
  };
}

function render(message, threadStates, onOpenSummary) {
  return loaded.exports.MessageList({
    conversationId: 'main', messages: [message], problems: {}, memoriesById: {},
    conversationSubjectId: 'subject-one', subjectNames: {}, phase: null, followNonce: 0,
    threadStates, onRegenerate() {}, onStartExercise() {}, onOpenMemories() {}, onOpenSummary,
  });
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!React.isValidElement(node)) return undefined;
  return predicate(node) ? node : find(node.props.children, predicate);
}

function cards(tree) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!React.isValidElement(node)) return;
    if (node.type === 'button' && node.props.className === 'threadPill') found.push(node);
    walk(node.props.children);
  };
  walk(tree);
  return found;
}

const STATES = {
  'thread-linked': { title: '链表：指针与边界', executionStatus: 'working', threadStatus: 'open' },
};

test('a dispatched Thread renders one card with its live title and status under the user message', () => {
  const tree = render(userMessage(), STATES);
  const [card] = cards(tree);
  assert.equal(card.props.type, 'button');
  assert.equal(card.props.title, '链表：指针与边界');
  assert.equal(card.props['aria-label'], '查看支线：链表：指针与边界');
  const html = renderToStaticMarkup(tree);
  assert.match(html, /链表：指针与边界/);
  assert.match(html, /进行中/);
  assert.match(html, /dot_working/);
  // 用户行仍然带有滚动定位锚点
  assert.ok(find(tree, (node) => node.props['data-msg-id'] === 'main-user-1'));
});

test('clicking the card opens that Thread through the existing summary callback', () => {
  let opened = null;
  const [card] = cards(render(userMessage(), STATES, (id) => { opened = id; }));
  card.props.onClick();
  assert.equal(opened, 'thread-linked');
  // 没有导航回调也不能报错
  const [again] = cards(render(userMessage(), STATES));
  assert.doesNotThrow(() => again.props.onClick());
});

test('a Thread missing from threadStates renders no broken card', () => {
  const html = renderToStaticMarkup(render(userMessage(['thread-missing']), STATES));
  assert.doesNotMatch(html, /threadPill/);
  assert.match(html, /带我复习链表/);
});

test('several dispatched Threads each get their own card', () => {
  const states = {
    'thread-linked': { title: '链表：指针与边界', executionStatus: 'idle', threadStatus: 'open' },
    'thread-recursion': { title: '递归：栈帧', executionStatus: 'queued', threadStatus: 'open' },
  };
  const html = renderToStaticMarkup(render(userMessage(['thread-linked', 'thread-recursion']), states));
  assert.equal(cards(render(userMessage(['thread-linked', 'thread-recursion']), states)).length, 2);
  assert.match(html, /链表：指针与边界/);
  assert.match(html, /递归：栈帧/);
});

test('a resolved Thread shows the resolved state on the card', () => {
  const states = { 'thread-linked': { title: '链表：指针与边界', executionStatus: 'idle', threadStatus: 'resolved' } };
  const html = renderToStaticMarkup(render(userMessage(), states));
  assert.match(html, /已解决/);
  assert.match(html, /dot_resolved/);
  assert.doesNotMatch(html, /dot_hollow/);
});

test('the main line no longer counts Thread updates next to the user message', () => {
  const html = renderToStaticMarkup(render(userMessage(), STATES));
  assert.doesNotMatch(html, /replyCount/);
  assert.doesNotMatch(html, /\breplies\b/);
  const css = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/MessageList.module.css'), 'utf8');
  assert.doesNotMatch(css, /\.replyCount\s*\{/);
  assert.doesNotMatch(css, /\.pillSummary\s*\{/);
});

test('the card sits under the user bubble: no align-self override, but a gap above', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../src/components/chat/MessageList.module.css'), 'utf8');
  assert.match(css, /\.threadPill\s*\{[^}]*margin-top: 8px/);
  assert.doesNotMatch(css, /\.threadPill\s*\{[^}]*align-self:/);
});

test('messages without dispatched Threads render exactly as before', () => {
  const html = renderToStaticMarkup(render(userMessage([]), STATES));
  assert.match(html, /带我复习链表/);
  assert.doesNotMatch(html, /threadPill/);
});

function systemEvent() {
  return {
    id: 'event-1', conversationId: 'main', seq: 2, role: 'user', kind: 'text',
    content: '【系统事件 · 支线汇报】以下内容不是学习者说的话。\n- 支线「链表」：已完成',
    status: 'complete', error: null, replyTo: null, problemId: null, attempt: null, memoryChanges: [],
    usedMemoryIds: [], suggestedProblemId: null, sources: [], truncated: false, toolCalls: [],
    pendingApproval: null, preferencePrompt: null, nextActions: [], threadSummary: null,
    systemEvent: { type: 'thread_report', reportIds: ['report-1'], threadIds: ['thread-linked'] },
    createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z',
  };
}

function assistantReply(replyTo, patch = {}) {
  return {
    id: 'reply-1', conversationId: 'main', seq: 3, role: 'assistant', kind: 'text', content: '',
    status: 'streaming', error: null, replyTo, problemId: null, attempt: null, memoryChanges: [],
    usedMemoryIds: [], suggestedProblemId: null, sources: [], truncated: false, toolCalls: [],
    pendingApproval: null, preferencePrompt: null, nextActions: [], threadSummary: null,
    createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', ...patch,
  };
}

function renderMessages(messages) {
  return loaded.exports.MessageList({
    conversationId: 'main', messages, problems: {}, memoriesById: {},
    conversationSubjectId: 'subject-one', subjectNames: {}, phase: null, followNonce: 0,
    onRegenerate() {}, onStartExercise() {}, onOpenMemories() {},
  });
}

test('hidden system events are not rendered and never become the last user message', () => {
  const event = systemEvent();
  const reply = assistantReply(event.id, { status: 'complete', content: '支线执行失败了，可以稍后重试。' });
  const tree = renderMessages([event, reply]);
  const html = renderToStaticMarkup(tree);
  assert.doesNotMatch(html, /系统事件/);
  assert.doesNotMatch(html, /不是学习者说的话/);
  assert.ok(find(tree, (node) => node.props['data-msg-id'] === 'reply-1'));
  assert.equal(find(tree, (node) => node.props['data-msg-id'] === 'event-1'), undefined);
});

test('an empty streaming reply to a system event stays invisible until it has content', () => {
  const event = systemEvent();
  const html = renderToStaticMarkup(renderMessages([event, assistantReply(event.id)]));
  assert.doesNotMatch(html, /data-msg-id="reply-1"/);
  const withText = renderToStaticMarkup(renderMessages([
    event, assistantReply(event.id, { content: '这次没成功，要不要换个例子？' }),
  ]));
  assert.match(withText, /data-msg-id="reply-1"/);
});

test('a normal streaming placeholder still renders', () => {
  const user = userMessage([]);
  const html = renderToStaticMarkup(renderMessages([user, assistantReply(user.id)]));
  assert.match(html, /data-msg-id="reply-1"/);
});

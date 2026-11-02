const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { resolveI18n } = require('./i18n-support.cjs');

function loadTs(relativePath, jsx) {
  const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: jsx ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
    },
  }).outputText;
  const box = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(box, box.exports, (name) => {
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
    if (name === '@/lib/chat/wakeEvents') return wakeEvents;
    if (name === './FileCard') return {
      FileCard: () => null, kindFromName: () => 'md', openFileLibrary: () => {},
      recalledFile: () => null, rememberFile: () => {}, scaleOf: () => 0,
    };
    if (name === './Markdown') return { CopyButton: () => null, Markdown: () => null };
    if (name === './widgets/ImageMarker') return { hasVisionMarker: () => false, VisionMarkedText: () => null };
    if (name === './widgets/visionData') return { hasVisionMarker: () => false };
    if (name === '@/hooks/useSmoothText') return { useSmoothText: (text) => text };
    if (name === './SelectionToolbar') return { SelectionToolbar: () => null, SELECTABLE_ATTR: 'data-selectable' };
    if (name === './widgets/widgetEvents') return { WidgetScopeContext: { Provider: ({ children }) => children } };
    if (name === './widgets/memoryContext') return { MemoriesByIdContext: { Provider: ({ children }) => children } };
    if (name === './WorkingIndicator') return { WorkingIndicator: () => null };
    if (name === './ReasoningBlock') return { ReasoningBlock: () => null };
    if (name === './GeneratedFiles') return { GeneratedFiles: () => null };
    if (name === './ThreadProposals') return { ThreadProposals: () => null };
    return {};
  });
  return box.exports;
}

const wakeEvents = loadTs('../src/lib/chat/wakeEvents.ts');
const { MessageList } = loadTs('../src/components/chat/MessageList.tsx', true);

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) return textOf(node.props.children);
  return '';
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!React.isValidElement(node)) return undefined;
  return predicate(node) ? node : find(node.props.children, predicate);
}

function buttons(node, found = []) {
  if (Array.isArray(node)) { node.forEach((child) => buttons(child, found)); return found; }
  if (!React.isValidElement(node)) return found;
  if (node.type === 'button') found.push(node);
  buttons(node.props.children, found);
  return found;
}

function base(patch) {
  return {
    conversationId: 'main', kind: 'text', error: null, problemId: null, attempt: null,
    memoryChanges: [], usedMemoryIds: [], suggestedProblemId: null, sources: [], truncated: false,
    toolCalls: [], pendingApproval: null, preferencePrompt: null, nextActions: [], threadSummary: null,
    createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', ...patch,
  };
}

test('a finished reply keeps regenerate and next actions while a wake placeholder follows it', () => {
  const tree = MessageList({
    conversationId: 'main',
    messages: [
      base({ id: 'user-1', seq: 1, role: 'user', content: '带我复习链表', status: 'complete', replyTo: null }),
      base({
        id: 'reply-real', seq: 2, role: 'assistant', content: '链表的指针指向下一个节点。',
        status: 'complete', replyTo: 'user-1', nextActions: ['quiz'],
      }),
      base({
        id: 'event-1', seq: 3, role: 'user', content: '【系统事件 · 支线汇报】以下内容不是学习者说的话。',
        status: 'complete', replyTo: null,
        systemEvent: { type: 'thread_report', reportIds: ['report-1'], threadIds: ['thread-linked'] },
      }),
      base({ id: 'reply-wake', seq: 4, role: 'assistant', content: '', status: 'streaming', replyTo: 'event-1' }),
    ],
    problems: {}, memoriesById: {}, conversationSubjectId: 'subject-one', subjectNames: {},
    phase: null, followNonce: 0,
    onRegenerate() {}, onStartExercise() {}, onOpenMemories() {}, onSendText() {},
  });
  const row = find(tree, (node) => node.props['data-msg-id'] === 'reply-real');
  assert.ok(row);
  const labels = buttons(row).map((button) => textOf(button));
  assert.ok(labels.some((label) => label.includes('重新生成')));
  assert.ok(labels.some((label) => label.includes('考考我')));
  assert.equal(find(tree, (node) => node.props['data-msg-id'] === 'event-1'), undefined);
  assert.equal(find(tree, (node) => node.props['data-msg-id'] === 'reply-wake'), undefined);
});

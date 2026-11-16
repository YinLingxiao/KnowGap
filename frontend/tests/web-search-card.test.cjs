const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { resolveI18n } = require('./i18n-support.cjs');

function loadComponent(name) {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/chat', name + '.tsx'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (resolveI18n(id)) return resolveI18n(id);
    if (id.endsWith('.css')) return new Proxy({}, { get: (_, key) => key });
    if (id === '@/lib/chat/types') return {};
    return require(id);
  };
  new Function('require', 'module', 'exports', js)(localRequire, module, module.exports);
  return module.exports;
}

const { WebSearchCard, parseWebSearch, hostOf, queryFromArguments } = loadComponent('WebSearchCard');

const okOutput = JSON.stringify({
  status: 'ok',
  query: '栈的应用',
  results: [
    { label: '网1', title: '栈的应用举例', url: 'https://example.com/1', snippet: '函数调用与表达式求值' },
    { label: '网2', title: 'Stack applications', url: 'https://example.org/2', snippet: 'LIFO' },
  ],
  note: '',
});

const errorOutput = JSON.stringify({ status: 'error', query: '栈的应用', results: [], note: '搜索服务暂时不可用' });

function call(overrides) {
  return { id: 'c1', name: 'web_search', arguments: '{"query":"栈的应用","limit":5}', output: '', ok: true, ...overrides };
}

test('parseWebSearch returns the ok example with both results', () => {
  const data = parseWebSearch(okOutput);
  assert.ok(data && typeof data === 'object');
  assert.equal(data.status, 'ok');
  assert.equal(data.results.length, 2);
  assert.equal(data.results[0].title, '栈的应用举例');
  assert.equal(data.results[1].url, 'https://example.org/2');
});

test('parseWebSearch drops javascript: and ftp: urls and keeps https', () => {
  const output = JSON.stringify({
    status: 'ok',
    query: 'x',
    results: [
      { label: '网1', title: 'bad js', url: 'javascript:alert(1)', snippet: '' },
      { label: '网2', title: 'bad ftp', url: 'ftp://x', snippet: '' },
      { label: '网3', title: 'good', url: 'https://example.com/a', snippet: '' },
    ],
    note: '',
  });
  const data = parseWebSearch(output);
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].url, 'https://example.com/a');
});

test('parseWebSearch returns null for non-JSON, empty object and unknown status', () => {
  assert.equal(parseWebSearch('not json'), null);
  assert.equal(parseWebSearch('{}'), null);
  assert.equal(parseWebSearch('{"status":"weird"}'), null);
});

test('hostOf strips www.', () => {
  assert.equal(hostOf('https://www.example.com/a'), 'example.com');
});

test('queryFromArguments reads the query or returns empty for partial JSON', () => {
  assert.equal(queryFromArguments('{"query":"栈的应用"}'), '栈的应用');
  assert.equal(queryFromArguments('{"que'), '');
});

test('a running call shows the searching state with its query', () => {
  const html = renderToStaticMarkup(React.createElement(WebSearchCard, {
    call: call({ output: '', arguments: '{"query":"栈的应用"}' }),
  }));
  assert.ok(html.includes('正在联网搜索'));
  assert.ok(html.includes('栈的应用'));
});

test('an ok result lists every source as a safe external link', () => {
  const html = renderToStaticMarkup(React.createElement(WebSearchCard, { call: call({ output: okOutput }) }));
  assert.ok(html.includes('栈的应用举例'));
  assert.ok(html.includes('Stack applications'));
  assert.ok(html.includes('href="https://example.com/1"'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('rel="noreferrer noopener"'));
  assert.ok(html.includes('2 条结果'));
});

test('an error result shows its note and no result list', () => {
  const html = renderToStaticMarkup(React.createElement(WebSearchCard, { call: call({ output: errorOutput }) }));
  assert.ok(html.includes('搜索服务暂时不可用'));
  assert.doesNotMatch(html, /<ol/);
});

test('unparseable output renders nothing so the generic list takes over', () => {
  const html = renderToStaticMarkup(React.createElement(WebSearchCard, { call: call({ output: 'not json' }) }));
  assert.equal(html, '');
});

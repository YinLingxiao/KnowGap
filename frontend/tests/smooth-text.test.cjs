const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Run the hook with controlled state and effects; no real-time animation waits.
function harness() {
  let state;
  let ref;
  let effects = [];
  const box = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/hooks/useSmoothText.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function('module', 'exports', 'require', js)(box, box.exports, () => ({
    useState: (initial) => { state ??= initial; return [state, (next) => { state = typeof next === 'function' ? next(state) : next; }]; },
    useRef: (initial) => { ref ??= { current: initial }; return ref; },
    useEffect: (effect) => { effects.push(effect); },
  }));
  return (text, live, paused = false) => {
    effects = [];
    const result = box.exports.useSmoothText(text, live, paused);
    // Only exercise state-sync effects for a snap; no timer is scheduled in these cases.
    if (!live || paused || text.length > 800) effects.forEach((effect) => effect());
    return result;
  };
}

test('a completed long answer appears immediately instead of typing for several more seconds', () => {
  const render = harness();
  render('', true);
  assert.equal(render('完整回复'.repeat(3000), false), '完整回复'.repeat(3000));
});

test('large bursts do not accumulate an unbounded animation backlog', () => {
  const render = harness();
  render('', true);
  assert.equal(render('大段回复'.repeat(3000), true).length, 12000);
});

test('selecting text freezes the displayed body until selection is released, including final corrections', () => {
  const render = harness();
  assert.equal(render('正在读的句子', true), '正在读的句子');
  assert.equal(render('正在读的句子，后面又生成了内容', true, true), '正在读的句子');
  assert.equal(render('最终核对后的全文', false, true), '正在读的句子');
  assert.equal(render('最终核对后的全文', false, false), '最终核对后的全文');
});

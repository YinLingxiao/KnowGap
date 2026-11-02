const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// 事件常量与派发函数在 widgetEvents.ts 里；用最小的 react / window 模拟编译加载
const source = fs.readFileSync(path.join(__dirname, "../src/components/chat/widgets/widgetEvents.ts"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });

function load() {
  const listeners = new Map();
  global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  global.window = {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    dispatchEvent: (event) => { (listeners.get(event.type) ?? []).forEach((fn) => fn(event)); return true; },
  };
  const mod = { exports: {} };
  const fakeReact = { createContext: (v) => ({ v }), useContext: (c) => c.v };
  new Function("exports", "require", "module", outputText)(mod.exports, () => fakeReact, mod);
  return { api: mod.exports, window: global.window };
}

test("askInComposer / sendNow 的事件 detail 带 conversationId", () => {
  const { api, window } = load();
  const seen = [];
  window.addEventListener(api.WIDGET_ASK_EVENT, (e) => seen.push(e.detail));
  window.addEventListener(api.WIDGET_AUTOSEND_EVENT, (e) => seen.push(e.detail));
  api.askInComposer("c1", "问");
  assert.equal(api.sendNow(null, "发"), "prefilled");
  assert.deepEqual(seen[0], { conversationId: "c1", prompt: "问" });
  assert.equal(seen[1].conversationId, null);
  assert.equal(seen[2].conversationId, null);
});

test("两个监听者只有匹配会话的那个处理", () => {
  const { api, window } = load();
  const make = (id, acceptUnscoped) => {
    const got = [];
    window.addEventListener(api.WIDGET_AUTOSEND_EVENT, (e) => {
      const d = e.detail;
      if (!(d.conversationId ? d.conversationId === id : acceptUnscoped) || d.handled) return;
      got.push(d.text);
      d.handled = true;
    });
    return got;
  };
  const main = make("main", true);
  const side = make("side", false);
  assert.equal(api.sendNow("side", "a"), "sent");
  assert.equal(api.sendNow(null, "b"), "sent");
  assert.deepEqual(main, ["b"]);
  assert.deepEqual(side, ["a"]);
});

test("useWidgetScope 默认 null", () => {
  const { api } = load();
  assert.equal(api.useWidgetScope(), null);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/chat/insights.ts"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
new Function("exports", "require", "module", outputText)(mod.exports, () => new Proxy({}, { get: () => () => ({}) }), mod);
const { mapInsights } = mod.exports;

const memory = {
  id: "m1", kind: "misconception", topic: "边界", topic_key: null, summary: "循环上界容易少一次",
  status: "suspected", confidence: 0.4, user_corrected: false, tags: [], created_at: "t", updated_at: "t",
  evidence: [
    { quote: "我总把 i<=n 写成 i<n", reason: "原话", signal: "supports", conversation_id: "c1", message_id: "a", source_available: true, created_at: "t", source: "message_quote" },
    { quote: "连续两次把上界写小", reason: "依据", signal: "supports", conversation_id: "c1", message_id: "b", source_available: true, created_at: "t", source: "inferred" },
    { quote: "没有来源字段", reason: "旧数据", signal: "supports", conversation_id: null, message_id: null, source_available: false, created_at: "t" },
  ],
};

test("insights 证据透传 source，缺省不补成原话", () => {
  const result = mapInsights({
    schema_version: 1,
    subject: { id: "s", name: "n", description: "", goal: "", level: null, deadline: null, color: "", main_conversation_id: null },
    stats: {},
    misconceptions: [memory],
    mastered: [],
    threads: [],
    materials: [],
  });
  const evidence = result.misconceptions[0].evidence;
  assert.equal(evidence[0].source, "message_quote");
  assert.equal(evidence[1].source, "inferred");
  assert.equal(evidence[1].quote, "连续两次把上界写小");
  assert.equal(evidence[2].source, undefined);
});

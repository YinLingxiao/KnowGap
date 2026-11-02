const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// api.ts 依赖网络层；这里只取纯映射函数，其余 import 一律用空对象代替
const source = fs.readFileSync(path.join(__dirname, "../src/lib/chat/api.ts"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
new Function("exports", "require", "module", outputText)(mod.exports, () => new Proxy({}, { get: () => () => ({}) }), mod);
const { mapQuizAttempt } = mod.exports;

const base = { quiz_id: "q1", attempt_id: "a1", option_index: 1, correct: false, answer_index: 2, explanation: "解析", repeated: false };
const memory = {
  id: "m1", kind: "misconception", topic: "指针", topic_key: "ptr", summary: "混淆", status: "needs_review", user_corrected: false,
  origin: "chat", subject_id: null, tags: [], created_at: "t", updated_at: "t",
  evidence: [{ conversation_id: "c1", message_id: "x", quote: "q", reason: "r", signal: "supports", created_at: "t", source_available: true, source: "quiz_attempt" }],
};

test("mapQuizAttempt 映射 memory_changes 与 plan_step", () => {
  const result = mapQuizAttempt({ ...base, memory_changes: [{ action: "created", memory }], plan_step: { id: "s1", title: "指针练习" } });
  assert.equal(result.memoryChanges.length, 1);
  assert.equal(result.memoryChanges[0].action, "created");
  assert.equal(result.memoryChanges[0].memory.topic, "指针");
  assert.equal(result.memoryChanges[0].memory.evidence[0].source, "quiz_attempt");
  assert.deepEqual(result.planStep, { id: "s1", title: "指针练习" });
});

test("mapQuizAttempt 缺字段时给空数组和 null", () => {
  const result = mapQuizAttempt(base);
  assert.deepEqual(result.memoryChanges, []);
  assert.equal(result.planStep, null);
  assert.equal(mapQuizAttempt({ ...base, plan_step: null, memory_changes: [] }).planStep, null);
});

test("证据没有 source 时按原话处理", () => {
  const legacy = { ...memory, evidence: [{ ...memory.evidence[0], source: undefined }] };
  const result = mapQuizAttempt({ ...base, memory_changes: [{ action: "updated", memory: legacy }] });
  assert.equal(result.memoryChanges[0].memory.evidence[0].source, "message_quote");
});

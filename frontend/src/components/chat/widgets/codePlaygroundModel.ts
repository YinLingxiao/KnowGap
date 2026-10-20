/**
 * 代码实验台的纯函数：容错解析模型下发的微件 JSON、统计 TODO、拼装「让 AI 诊断」的提示词。
 * 不依赖 React 和 DOM，便于用 node --test 直接验证。
 */
import type { SandboxResult } from "@/lib/api/sandbox-client";

export type PlaygroundLanguage = "python" | "javascript" | "c" | "cpp";
export type PlaygroundMode = "scaffold" | "free";

export interface PlaygroundCase {
  name: string;
  input: string;
  expected: string | null;
}

export interface PlaygroundSpec {
  title: string;
  language: PlaygroundLanguage;
  mode: PlaygroundMode;
  instructions: string;
  starterCode: string;
  testCases: PlaygroundCase[];
}

export type ParseResult = { ok: true; spec: PlaygroundSpec } | { ok: false; reason: string };

/** 与后端 code_sandbox/schemas.py 的上限保持一致 */
export const LIMITS = { code: 20_000, io: 10_000, cases: 10, title: 80, instructions: 600 } as const;

/** 聊天输入框上限是 12000 字，提示词必须留在这个范围内 */
export const MAX_PROMPT_CHARS = 11_000;

export const LANGUAGE_LABELS: Record<PlaygroundLanguage, string> = {
  python: "Python", javascript: "JavaScript", c: "C", cpp: "C++",
};

const LANGUAGE_ALIASES: Record<string, PlaygroundLanguage> = {
  python: "python", py: "python", python3: "python",
  javascript: "javascript", js: "javascript", node: "javascript", nodejs: "javascript",
  c: "c",
  cpp: "cpp", "c++": "cpp", cplusplus: "cpp",
};

export function normalizeLanguage(value: unknown): PlaygroundLanguage | null {
  if (typeof value !== "string") return null;
  return LANGUAGE_ALIASES[value.trim().toLowerCase()] ?? null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function firstText(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(data[key]);
    if (value !== null) return value;
  }
  return null;
}

export function parseCodePlaygroundSpec(data: Record<string, unknown>): ParseResult {
  const language = normalizeLanguage(data.language);
  if (!language) {
    const shown = typeof data.language === "string" && data.language.trim() ? `「${clip(data.language.trim(), 20)}」` : "";
    return { ok: false, reason: `不支持的语言${shown}，代码实验台目前只支持 Python、JavaScript、C、C++。` };
  }
  // `starter` / `scaffold` 是 main 上内联的模拟版微件用过的字段名，一并接受，方便替换时不改模型输出。
  const starterCode = (firstText(data, ["starter_code", "starterCode", "code", "starter", "scaffold"]) ?? "")
    .replace(/\r\n?/g, "\n");
  if (starterCode.length > LIMITS.code) {
    return { ok: false, reason: `脚手架代码太长（超过 ${LIMITS.code} 字），无法载入。` };
  }
  // 没给脚手架就退化成自由编写，而不是把整个微件丢掉。
  const mode: PlaygroundMode = data.mode === "free" || !starterCode.trim() ? "free" : "scaffold";

  const rawCases = Array.isArray(data.test_cases) ? data.test_cases
    : Array.isArray(data.testCases) ? data.testCases
      : Array.isArray(data.tests) ? data.tests : [];
  const testCases: PlaygroundCase[] = [];
  for (const raw of rawCases) {
    if (testCases.length >= LIMITS.cases) break;
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const input = firstText(item, ["input", "stdin"]) ?? "";
    const expected = firstText(item, ["expected", "expected_output", "expectedOutput", "output"]);
    testCases.push({
      name: clip(firstText(item, ["name", "title"]) ?? `用例 ${testCases.length + 1}`, 60),
      input: clip(input, LIMITS.io),
      expected: expected === null ? null : clip(expected, LIMITS.io),
    });
  }

  return {
    ok: true,
    spec: {
      title: clip((firstText(data, ["title"]) ?? "").trim() || "代码实验台", LIMITS.title),
      language,
      mode,
      instructions: clip((firstText(data, ["instructions", "description", "prompt"]) ?? "").trim(), LIMITS.instructions),
      starterCode,
      testCases,
    },
  };
}

const TODO_RE = /(?:#|\/\/)[ \t]*TODO\b/g;

/** 统计还没补全的 `# TODO` / `// TODO` 数量 */
export function countTodos(code: string): number {
  return (code.match(TODO_RE) ?? []).length;
}

// ------------------------------------------------------------ 让 AI 诊断

export interface DiagnosisInput {
  title: string;
  language: PlaygroundLanguage;
  instructions?: string;
  code: string;
  result: SandboxResult;
}

function fenceFor(content: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function fenced(content: string, info = ""): string {
  const fence = fenceFor(content);
  return `${fence}${info}\n${content}\n${fence}`;
}

function clipMarked(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max))}\n…（已截断）`;
}

function errorSection(result: SandboxResult, language: PlaygroundLanguage, budget: number): string[] {
  const parts: string[] = [];
  if (result.blocked.length > 0) {
    parts.push("代码被安全黑名单拦截，没有执行：");
    parts.push(...result.blocked.slice(0, 5).map(
      (rule) => `- ${rule.ruleId}（第 ${rule.line} 行）${rule.description} 命中：${clipMarked(rule.excerpt, 120)}`,
    ));
    return parts;
  }
  if (result.compile && !result.compile.ok) {
    const label = language === "c" || language === "cpp" ? "编译器报错" : "语法检查报错";
    const output = (result.compile.stderr || result.compile.stdout).trim();
    parts.push(`${label}：`, fenced(clipMarked(output || "（没有输出）", budget)));
    return parts;
  }
  const failing = result.testResults.find((item) => item.status !== "passed" && item.status !== "ok");
  if (failing) {
    const small = Math.max(200, Math.floor(budget / 4));
    parts.push(`测试用例「${failing.name}」没有通过（${failing.status}）：`);
    if (failing.input) parts.push("输入：", fenced(clipMarked(failing.input, small)));
    if (failing.expected !== null) parts.push("期望输出：", fenced(clipMarked(failing.expected, small)));
    if (failing.stdout) parts.push("实际输出：", fenced(clipMarked(failing.stdout, small)));
    if (failing.stderr.trim()) parts.push("程序报错：", fenced(clipMarked(failing.stderr.trim(), budget)));
    const code = failing.exitCode === null ? "" : `退出码 ${failing.exitCode}`;
    const note = failing.exitNote ? `（${failing.exitNote}）` : "";
    if (code) parts.push(`${code}${note}`);
  } else if (result.stderr.trim()) {
    parts.push("程序报错：", fenced(clipMarked(result.stderr.trim(), budget)));
  }
  return parts;
}

function assemble(input: DiagnosisInput, codeBudget: number, errorBudget: number): string {
  const { title, language, instructions, code, result } = input;
  const lines = [
    `我在做代码实验台「${clipMarked(title, LIMITS.title)}」（${LANGUAGE_LABELS[language]}），运行没有通过。` +
    "请针对下面的报错帮我定位原因：先指出对应的原理和行号，再给最小的提示，先不要直接给完整答案。",
  ];
  if (instructions?.trim()) lines.push("", `题目要求：${clipMarked(instructions.trim(), 300)}`);
  lines.push("", "我的代码：", fenced(clipMarked(code, codeBudget), language));
  lines.push("", `运行结果：${clipMarked(result.message, 200)}`, ...errorSection(result, language, errorBudget));
  return lines.join("\n");
}

/**
 * 拼出发给 AI 的诊断提示词：代码 + 真实报错。
 * 围栏长度取内容里最长反引号串 +1，代码里带三个反引号也不会破坏格式；
 * 总长保证不超过聊天输入框的上限。
 */
export function buildDiagnosisPrompt(input: DiagnosisInput): string {
  let codeBudget = 5_500;
  let errorBudget = 2_500;
  let prompt = assemble(input, codeBudget, errorBudget);
  // 极端情况（比如大量反引号撑长围栏）下逐步收紧，直到放得进输入框。
  for (let round = 0; round < 8 && prompt.length > MAX_PROMPT_CHARS; round += 1) {
    codeBudget = Math.floor(codeBudget / 2);
    errorBudget = Math.floor(errorBudget / 2);
    prompt = assemble(input, codeBudget, errorBudget);
  }
  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
}

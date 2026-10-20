/** 代码沙盒接口（POST /api/sandbox/run）。snake_case 的接口字段只在这里出现。 */
import { request } from "@/lib/api/http-client";
import { API_BASE_URL } from "@/lib/config";

export type SandboxLanguage = "python" | "javascript" | "c" | "cpp";

export interface SandboxCaseInput {
  name?: string;
  input: string;
  /** 为 null 或缺省时只运行、不比对输出 */
  expected?: string | null;
}

export interface SandboxRunInput {
  language: SandboxLanguage;
  code: string;
  stdin?: string;
  testCases?: SandboxCaseInput[];
}

export interface SandboxDiagnostic {
  line: number | null;
  column: number | null;
  severity: "error" | "warning";
  message: string;
}

export interface SandboxBlockedRule {
  ruleId: string;
  category: string;
  description: string;
  line: number;
  excerpt: string;
}

export interface SandboxCompile {
  ok: boolean;
  stdout: string;
  stderr: string;
  diagnostics: SandboxDiagnostic[];
  durationMs: number;
}

export type SandboxCaseStatus = "passed" | "failed" | "ok" | "runtime_error" | "timeout" | "output_limit" | "skipped";

export interface SandboxCaseResult {
  index: number;
  name: string;
  input: string;
  expected: string | null;
  status: SandboxCaseStatus;
  passed: boolean | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitNote: string | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  diagnostics: SandboxDiagnostic[];
}

export type SandboxStatus = "blocked" | "compile_error" | "timeout" | "runtime_error" | "failed" | "passed" | "ok";

export interface SandboxResult {
  ok: boolean;
  status: SandboxStatus;
  message: string;
  language: SandboxLanguage;
  stdout: string;
  stderr: string;
  /** 被拦截或没有执行时为 -1 */
  exitCode: number;
  blocked: SandboxBlockedRule[];
  compile: SandboxCompile | null;
  testResults: SandboxCaseResult[];
  passed: number;
  total: number;
  diagnostics: SandboxDiagnostic[];
  timeLimitSeconds: number;
}

/** 后端每个用例 3 秒、整体最多约 25 秒，留出余量，别让浏览器比后端先放弃。 */
export const SANDBOX_TIMEOUT_MS = 35_000;

/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are mapped field by field below */
type Wire = any;

const list = (value: unknown): Wire[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function mapDiagnostic(data: Wire): SandboxDiagnostic {
  return {
    line: num(data?.line), column: num(data?.column),
    severity: data?.severity === "warning" ? "warning" : "error", message: str(data?.message),
  };
}

function mapCase(data: Wire): SandboxCaseResult {
  return {
    index: num(data?.index) ?? 0, name: str(data?.name), input: str(data?.input),
    expected: typeof data?.expected === "string" ? data.expected : null,
    status: data?.status, passed: typeof data?.passed === "boolean" ? data.passed : null,
    stdout: str(data?.stdout), stderr: str(data?.stderr), exitCode: num(data?.exit_code),
    exitNote: typeof data?.exit_note === "string" ? data.exit_note : null,
    durationMs: num(data?.duration_ms) ?? 0, truncated: Boolean(data?.truncated), timedOut: Boolean(data?.timed_out),
    diagnostics: list(data?.diagnostics).map(mapDiagnostic),
  };
}

export function mapSandboxResult(data: Wire): SandboxResult {
  const compile = data?.compile;
  return {
    ok: Boolean(data?.ok), status: data?.status, message: str(data?.message), language: data?.language,
    stdout: str(data?.stdout), stderr: str(data?.stderr), exitCode: num(data?.exit_code) ?? -1,
    blocked: list(data?.blocked).map((rule: Wire): SandboxBlockedRule => ({
      ruleId: str(rule?.rule_id), category: str(rule?.category), description: str(rule?.description),
      line: num(rule?.line) ?? 0, excerpt: str(rule?.excerpt),
    })),
    compile: compile ? {
      ok: Boolean(compile.ok), stdout: str(compile.stdout), stderr: str(compile.stderr),
      diagnostics: list(compile.diagnostics).map(mapDiagnostic), durationMs: num(compile.duration_ms) ?? 0,
    } : null,
    testResults: list(data?.test_results).map(mapCase),
    passed: num(data?.passed) ?? 0, total: num(data?.total) ?? 0,
    diagnostics: list(data?.diagnostics).map(mapDiagnostic),
    timeLimitSeconds: num(data?.time_limit_seconds) ?? 3,
  };
}

/**
 * 在本机沙盒里编译 / 运行代码。
 * 不接收 AbortSignal：`request()` 会用自己的 signal 覆盖调用方传入的，取消不可靠；
 * 调用方用「运行序号」丢弃过期响应。错误是 ApiError，message 已是后端给的中文说明。
 */
export async function runSandbox(input: SandboxRunInput): Promise<SandboxResult> {
  const wire = await request<Wire>(API_BASE_URL, "/api/sandbox/run", {
    method: "POST",
    timeoutMs: SANDBOX_TIMEOUT_MS,
    body: JSON.stringify({
      language: input.language,
      code: input.code,
      stdin: input.stdin ?? "",
      test_cases: (input.testCases ?? []).map((item) => ({
        name: item.name, input: item.input, expected: item.expected ?? null,
      })),
    }),
  });
  return mapSandboxResult(wire);
}

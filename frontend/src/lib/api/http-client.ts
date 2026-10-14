/** FastAPI adapter: the wire contract stays here, separate from the page view models. */
import { ApiError, type ApiErrorKind } from "./errors";
import { DEMO_STUDENT_ID, REQUEST_TIMEOUT_MS } from "../config";
import type {
  AnswerSubmission, ChatMessage, Diagnosis, KnowGapClient, LearningMemory,
  MemoryChange, MemoryStatus, SessionSnapshot,
} from "../types";

interface WireDiagnosis {
  topic_key: string;
  assessment: "correct" | "incorrect" | "uncertain";
  issue: string | null;
  confidence: number;
  evidence: string;
}
interface WireMemory {
  id: string;
  student_id: string;
  topic_key: string;
  issue_key: string;
  summary: string;
  status: MemoryStatus;
  confidence: number;
  evidence_count: number;
  evidence_refs: Array<{
    message_id: string; session_id: string; problem_id: string; quote: string;
    assessment: string; phase: "initial" | "tutoring"; created_at: string;
  }>;
  updated_at: string;
}
interface WireTurn {
  session_id: string;
  turn: number;
  diagnosis: WireDiagnosis;
  reply: string;
  used_memory_ids: string[];
  memory_changes: Array<{ action: "created" | "updated"; memory: WireMemory }>;
}
interface WireSession {
  id: string;
  student_id: string;
  problem_id: string;
  turn: number;
  created_at: string;
  messages: Array<{
    id: string; role: "user" | "assistant"; content: string; created_at: string;
    diagnosis: WireDiagnosis | null; used_memory_ids: string[];
  }>;
}

const REASONING_SEPARATOR = "\n\n解题思路：\n";

function mapDiagnosis(data: WireDiagnosis): Diagnosis {
  return { topicKey: data.topic_key, assessment: data.assessment, issue: data.issue,
    confidence: data.confidence, evidence: data.evidence };
}

function mapMemory(data: WireMemory): LearningMemory {
  return {
    id: data.id, studentId: data.student_id, topicKey: data.topic_key, issueKey: data.issue_key,
    summary: data.summary, status: data.status, confidence: data.confidence,
    evidenceCount: data.evidence_count, updatedAt: data.updated_at,
    evidenceRefs: data.evidence_refs.map((ref) => ({
      label: `${ref.problem_id} · ${ref.phase === "initial" ? "首次作答" : "引导后作答"}`,
      sessionId: ref.session_id, messageId: ref.message_id, excerpt: ref.quote,
    })),
  };
}

function mapTurn(data: WireTurn) {
  const reply: ChatMessage = {
    id: `${data.session_id}-tutor-${data.turn}`, role: "tutor", content: data.reply,
    createdAt: new Date().toISOString(),
    // The API does not report a hint/answer phase. Do not invent one.
  };
  const memoryChanges: MemoryChange[] = data.memory_changes.map(({ action, memory }) => ({
    memoryId: memory.id, action, summary: memory.summary, toStatus: memory.status,
  }));
  return { sessionId: data.session_id, turn: data.turn, diagnosis: mapDiagnosis(data.diagnosis),
    reply, usedMemoryIds: data.used_memory_ids, memoryChanges };
}

function mapSession(data: WireSession): SessionSnapshot {
  const initial = data.messages.find((message) => message.role === "user");
  const latest = [...data.messages].reverse().find((message) => message.diagnosis);
  const tutor = [...data.messages].reverse().find((message) => message.role === "assistant");
  if (!initial || !latest?.diagnosis) throw new ApiError("server", "会话缺少作答记录，暂时无法恢复");
  const separator = initial.content.indexOf(REASONING_SEPARATOR);
  return {
    id: data.id, problemId: data.problem_id, turn: data.turn,
    submission: separator < 0 ? { answer: initial.content, reasoning: "" } : {
      answer: initial.content.slice(0, separator),
      reasoning: initial.content.slice(separator + REASONING_SEPARATOR.length),
    },
    submissionDiagnosis: initial.diagnosis ? mapDiagnosis(initial.diagnosis) : undefined,
    diagnosis: mapDiagnosis(latest.diagnosis), usedMemoryIds: tutor?.used_memory_ids ?? [],
    messages: data.messages.filter((message) => message.id !== initial.id).map((message) => ({
      id: message.id, role: message.role === "user" ? "student" : "tutor",
      content: message.content, createdAt: message.created_at,
      diagnosis: message.role === "user" && message.diagnosis ? mapDiagnosis(message.diagnosis) : undefined,
    })),
  };
}

export function createHttpClient(baseUrl: string): KnowGapClient {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    source: "api",
    async checkHealth() {
      const data = await request<{ status: string }>(root, "/health");
      if (data.status !== "ok") throw new ApiError("server", "后端健康检查未通过");
    },
    async listProblems() {
      const data = await request<Array<{ id: string; title: string; topic_key: string; prompt: string;
        input_sequence?: number[]; output_sequence?: number[] }>>(root, "/api/problems");
      return data.map((problem) => ({ id: problem.id, title: problem.title,
        topicKey: problem.topic_key, statement: problem.prompt,
        inputSequence: problem.input_sequence, outputSequence: problem.output_sequence }));
    },
    async startSession(input: AnswerSubmission) {
      const reasoning = input.reasoning.trim();
      const answer = input.answer.trim() + (reasoning ? REASONING_SEPARATOR + reasoning : "");
      return mapTurn(await request<WireTurn>(root, "/api/diagnosis", {
        method: "POST", body: JSON.stringify({ student_id: input.studentId, problem_id: input.problemId, answer }),
      }));
    },
    async sendMessage(sessionId, content) {
      return mapTurn(await request<WireTurn>(root, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST", body: JSON.stringify({ content: content.trim() }),
      }));
    },
    async getSession(sessionId) {
      return mapSession(await request<WireSession>(root, `/api/sessions/${encodeURIComponent(sessionId)}?student_id=${encodeURIComponent(DEMO_STUDENT_ID)}`));
    },
    async listMemories(studentId) {
      return (await request<WireMemory[]>(root, `/api/memories?student_id=${encodeURIComponent(studentId)}`)).map(mapMemory);
    },
    async deleteMemory(memoryId) {
      await request(root, `/api/memories/${encodeURIComponent(memoryId)}?student_id=${encodeURIComponent(DEMO_STUDENT_ID)}`, { method: "DELETE" });
    },
  };
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

export async function request<T = unknown>(
  baseUrl: string, path: string,
  { timeoutMs = REQUEST_TIMEOUT_MS, headers, ...init }: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await readDetail(response);
      throw new ApiError(statusToKind(response.status), detail ?? `请求失败（HTTP ${response.status}）`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError("timeout", "请求超时，输入已保留。继续发送前请先刷新会话，核对是否已保存。");
    if (error instanceof SyntaxError) throw new ApiError("server", "后端返回了无法读取的数据，请稍后重试");
    throw new ApiError("network", "无法连接到后端服务");
  } finally {
    clearTimeout(timer);
  }
}

async function readDetail(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("detail" in body)) return null;
    const { detail } = body as { detail: unknown };
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.map((item) =>
      item && typeof item === "object" && "msg" in item ? String(item.msg) : "").filter(Boolean).join("；");
    return null;
  } catch {
    return null;
  }
}

function statusToKind(status: number): ApiErrorKind {
  if (status === 409) return "conflict";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "validation";
  if (status === 408 || status === 504) return "timeout";
  if (status === 502 || status === 503) return "model_unavailable";
  if (status >= 500) return "server";
  return "unknown";
}

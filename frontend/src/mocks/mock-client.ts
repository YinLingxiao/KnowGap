/**
 * ⚠️ MOCK —— 前端演示用的模拟客户端，不是后端实现。
 *
 * - 诊断、追问和记忆变化全部来自 mock-data.ts 中的预设脚本 + 关键词判断，
 *   不调用任何模型，结果不代表真实诊断能力；
 * - 这里的「记忆治理」只是为了让页面能走通
 *   「作答 → 诊断 → 对话 → 查看记忆 → 新会话参考历史」的演示，真实规则以后端为准；
 * - 数据保存在浏览器 localStorage（刷新后仍在），可在 Mock 控制台重置。
 */

import { ApiError } from "@/lib/api/errors";
import { STATUS_META } from "@/lib/labels";
import type {
  AnswerSubmission,
  ChatMessage,
  Diagnosis,
  EvidenceRef,
  KnowGapClient,
  LearningMemory,
  MemoryChange,
  MemoryStatus,
  TutorPhase,
} from "@/lib/types";
import { consumeFault, getMockControls, type MockOperation } from "@/mocks/mock-controls";
import { MOCK_SCRIPTS, excerpt, findScript, quoteFrom, type MockProblemScript } from "@/mocks/mock-data";

const STORAGE_KEY = "knowgap.mock.v1";

type SessionStage = "unclear" | "guiding" | "confirmed" | "answered" | "correct";

interface MockSessionRecord {
  id: string;
  studentId: string;
  problemId: string;
  stage: SessionStage;
  hintIndex: number;
  usesMemory: boolean;
  issueMemoryId: string | null;
  reinforced: boolean;
  unclearCount: number;
}

interface MockDb {
  memories: LearningMemory[];
  sessions: Record<string, MockSessionRecord>;
}

const LATENCY_MS: Record<MockOperation, number> = {
  health: 200,
  problems: 350,
  diagnosis: 1600,
  message: 1100,
  memories: 300,
  delete: 350,
};

const ASK_FOR_ANSWER = /(看答案|完整解答|直接告诉|告诉我答案|不会做|不知道|放弃|讲解一下)/;
const ASK_FOR_HINT = /(提示|不确定|没思路|没有思路)/;
const WRAP_UP =
  "这道题我们已经讨论完了。你可以点击右上角「新会话」重新作答，或在左侧换一道同知识点的题目，看看导师会如何参考这次留下的学习记忆。";

const STATUS_PRIORITY: Record<MemoryStatus, number> = {
  needs_review: 0,
  suspected: 1,
  improving: 2,
  resolved: 3,
};

/* ---------- 存储 ---------- */

let fallbackDb: MockDb | null = null;

const emptyDb = (): MockDb => ({ memories: [], sessions: {} });

function loadDb(): MockDb {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MockDb;
      if (Array.isArray(parsed.memories) && parsed.sessions) return parsed;
    }
  } catch {
    // localStorage 不可用（隐私模式等），退回内存存储
  }
  return fallbackDb ?? emptyDb();
}

function saveDb(db: MockDb): void {
  fallbackDb = db;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // 忽略：内存中的 fallbackDb 仍然可用
  }
}

export function resetMockDb(): void {
  fallbackDb = emptyDb();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}

/* ---------- 工具 ---------- */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const clampConfidence = (value: number) => Math.round(Math.min(0.95, Math.max(0.05, value)) * 100) / 100;

function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

async function simulate(operation: MockOperation): Promise<void> {
  const { latency } = getMockControls();
  const fault = consumeFault(operation);
  const instant = latency === "instant";

  if (fault === "timeout") {
    await sleep(instant ? 300 : 2400);
    throw new ApiError("timeout", "模型响应超时（Mock 模拟）");
  }
  await sleep(instant ? 60 : LATENCY_MS[operation] + Math.random() * 300);
  if (fault === "network") throw new ApiError("network", "无法连接到后端服务（Mock 模拟）");
  if (fault === "model_unavailable") throw new ApiError("model_unavailable", "模型服务不可用（Mock 模拟）", 503);
  if (fault === "session_not_found") throw new ApiError("not_found", "会话不存在或已失效（Mock 模拟）", 404);
}

function tutorMessage(content: string, phase?: TutorPhase): ChatMessage {
  return { id: newId("mock-msg"), role: "tutor", content, createdAt: nowIso(), phase };
}

function describeSubmission({ answer, reasoning }: AnswerSubmission): string {
  return reasoning ? `答案「${excerpt(answer, 30)}」；思路「${excerpt(reasoning, 60)}」` : `答案「${excerpt(answer, 30)}」`;
}

/* ---------- 模拟的记忆治理 ---------- */

function findIssueMemory(db: MockDb, studentId: string, script: MockProblemScript) {
  return db.memories.find(
    (memory) =>
      memory.studentId === studentId &&
      memory.topicKey === script.problem.topicKey &&
      memory.issueKey === script.issueKey,
  );
}

/** 检索同知识点的记忆，最多 3 条（MVP_SPEC §6.2 第 5 条） */
function retrieveRelated(db: MockDb, studentId: string, topicKey: string): LearningMemory[] {
  return db.memories
    .filter((memory) => memory.studentId === studentId && memory.topicKey === topicKey)
    .sort(
      (a, b) =>
        STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, 3);
}

/** 记录一次误区证据：新建为「待确认」，已有则合并并升级为「需要巩固」 */
function recordMisconception(
  db: MockDb,
  studentId: string,
  script: MockProblemScript,
  ref: EvidenceRef,
): MemoryChange {
  const existing = findIssueMemory(db, studentId, script);
  if (existing) {
    const fromStatus = existing.status;
    existing.status = "needs_review";
    existing.evidenceCount += 1;
    existing.evidenceRefs.push(ref);
    existing.confidence = clampConfidence((existing.confidence ?? 0.6) + 0.08);
    existing.updatedAt = nowIso();
    return { memoryId: existing.id, action: "updated", summary: existing.summary, fromStatus, toStatus: "needs_review" };
  }

  const memory: LearningMemory = {
    id: newId("mock-mem"),
    studentId,
    topicKey: script.problem.topicKey,
    topicLabel: script.problem.topicLabel,
    issueKey: script.issueKey,
    summary: script.memorySummary,
    status: "suspected",
    confidence: 0.6,
    evidenceCount: 1,
    evidenceRefs: [ref],
    updatedAt: nowIso(),
  };
  db.memories.push(memory);
  return { memoryId: memory.id, action: "created", summary: memory.summary, toStatus: "suspected" };
}

/** 同一会话中经引导确认了误区：补充证据，「待确认」升级为「需要巩固」 */
function reinforce(db: MockDb, record: MockSessionRecord, ref: EvidenceRef): MemoryChange | null {
  if (!record.issueMemoryId || record.reinforced) return null;
  const memory = db.memories.find((item) => item.id === record.issueMemoryId);
  if (!memory) return null;

  record.reinforced = true;
  const fromStatus = memory.status;
  const toStatus: MemoryStatus = fromStatus === "suspected" ? "needs_review" : fromStatus;
  memory.status = toStatus;
  memory.evidenceCount += 1;
  memory.evidenceRefs.push(ref);
  memory.confidence = clampConfidence((memory.confidence ?? 0.6) + 0.06);
  memory.updatedAt = nowIso();
  return { memoryId: memory.id, action: "updated", summary: memory.summary, fromStatus, toStatus };
}

/** 新会话中独立答对同类题：改善中 → 已解决，不直接抹除历史 */
function recordImprovement(memory: LearningMemory, ref: EvidenceRef): MemoryChange & { toStatus: MemoryStatus } {
  const fromStatus = memory.status;
  const toStatus: MemoryStatus = fromStatus === "improving" ? "resolved" : "improving";
  memory.status = toStatus;
  memory.evidenceCount += 1;
  memory.evidenceRefs.push(ref);
  memory.updatedAt = nowIso();
  return { memoryId: memory.id, action: "updated", summary: memory.summary, fromStatus, toStatus };
}

/* ---------- 客户端 ---------- */

export function createMockClient(): KnowGapClient {
  return {
    source: "mock",

    async checkHealth() {
      await simulate("health");
    },

    async listProblems() {
      await simulate("problems");
      return MOCK_SCRIPTS.map((script) => script.problem);
    },

    async startSession(input) {
      await simulate("diagnosis");
      const script = findScript(input.problemId);
      if (!script) throw new ApiError("not_found", "题目不存在", 404);

      const { problem } = script;
      const db = loadDb();
      const sessionId = newId("mock-session");
      // 先检索，再根据本次作答更新：本次表现优先于历史标签
      const related = retrieveRelated(db, input.studentId, problem.topicKey);
      const issueMemory = findIssueMemory(db, input.studentId, script);
      const usesMemory = Boolean(issueMemory && issueMemory.status !== "resolved");
      const verdict = script.judge(input.answer);

      const record: MockSessionRecord = {
        id: sessionId,
        studentId: input.studentId,
        problemId: problem.id,
        stage: "guiding",
        hintIndex: 1,
        usesMemory,
        issueMemoryId: null,
        reinforced: false,
        unclearCount: 0,
      };
      const memoryChanges: MemoryChange[] = [];
      const base = { topicKey: problem.topicKey, topicLabel: problem.topicLabel };
      let diagnosis: Diagnosis;
      let reply: ChatMessage;

      if (verdict === "incorrect") {
        const change = recordMisconception(db, input.studentId, script, {
          label: `首次作答 · ${problem.title}`,
          sessionId,
          excerpt: describeSubmission(input),
        });
        memoryChanges.push(change);
        record.issueMemoryId = change.memoryId;
        diagnosis = {
          ...base,
          assessment: "incorrect",
          issue: script.issue,
          evidence: script.incorrectEvidence(input.answer, input.reasoning),
          confidence: usesMemory ? 0.78 : 0.64,
        };
        reply = tutorMessage((usesMemory ? script.memoryHints : script.hints)[0], "hint");
      } else if (verdict === "correct") {
        record.stage = "correct";
        diagnosis = {
          ...base,
          assessment: "correct",
          issue: null,
          evidence: script.correctEvidence(input.answer, input.reasoning),
          confidence: 0.82,
        };
        if (issueMemory && issueMemory.status !== "resolved") {
          const change = recordImprovement(issueMemory, {
            label: `独立答对同类题 · ${problem.title}`,
            sessionId,
            excerpt: describeSubmission(input),
          });
          memoryChanges.push(change);
          reply = tutorMessage(
            `判断正确！你之前在这个知识点上遇到过困难，这次能独立做对，进步很明显——相关学习记忆已调整为「${STATUS_META[change.toStatus].label}」。\n\n${script.correctFollowUp}`,
          );
        } else {
          reply = tutorMessage(`${script.correctPraise}${script.correctFollowUp}`);
        }
      } else {
        record.stage = "unclear";
        diagnosis = {
          ...base,
          assessment: "uncertain",
          issue: null,
          evidence: quoteFrom(input.answer) ?? input.answer.trim(),
          confidence: 0.3,
        };
        reply = tutorMessage(script.unclearReply, "hint");
      }

      db.sessions[sessionId] = record;
      saveDb(db);
      return {
        sessionId,
        diagnosis,
        reply,
        usedMemoryIds: related.map((memory) => memory.id),
        memoryChanges,
      };
    },

    async sendMessage(sessionId, content) {
      await simulate("message");
      const db = loadDb();
      const record = db.sessions[sessionId];
      if (!record) throw new ApiError("not_found", "会话不存在或已失效", 404);
      const script = findScript(record.problemId);
      if (!script) throw new ApiError("not_found", "题目不存在", 404);

      const text = content.trim();
      const hints = record.usesMemory ? script.memoryHints : script.hints;
      const memoryChanges: MemoryChange[] = [];
      let reply: string;
      let phase: TutorPhase | undefined = "hint";
      // 只有能判断的回答才给出本轮诊断；中间步骤的回答不做评价
      let turnDiagnosis: Diagnosis | undefined;
      const judged = (assessment: "correct" | "incorrect" | "uncertain", confidence: number): Diagnosis => ({
        topicKey: script.problem.topicKey,
        topicLabel: script.problem.topicLabel,
        assessment,
        issue: assessment === "incorrect" ? script.issue : null,
        evidence: quoteFrom(text) ?? text,
        confidence,
      });

      const startGuiding = (prefix: string) => {
        record.stage = "guiding";
        record.hintIndex = 1;
        return `${prefix}\n\n${hints[0]}`;
      };
      const giveExplanation = (label: string) => {
        record.stage = "answered";
        phase = "answer";
        const change = reinforce(db, record, { label, sessionId, excerpt: excerpt(text) });
        if (change) memoryChanges.push(change);
        return script.explanation;
      };

      switch (record.stage) {
        case "unclear": {
          const verdict = script.judge(text);
          if (ASK_FOR_ANSWER.test(text)) {
            reply = giveExplanation("请求查看完整讲解");
          } else if (verdict === "incorrect") {
            const change = recordMisconception(db, record.studentId, script, {
              label: `补充作答 · ${script.problem.title}`,
              sessionId,
              excerpt: excerpt(text),
            });
            memoryChanges.push(change);
            record.issueMemoryId = change.memoryId;
            turnDiagnosis = judged("incorrect", 0.62);
            reply = startGuiding(`明白了，你的结论是「${excerpt(text, 24)}」。我们一起来验证一下。`);
          } else if (verdict === "correct") {
            record.stage = "correct";
            phase = undefined;
            turnDiagnosis = judged("correct", 0.8);
            reply = `${script.correctPraise}${script.correctFollowUp}`;
          } else if (ASK_FOR_HINT.test(text) || record.unclearCount >= 1) {
            reply = startGuiding("没关系，我们先不下结论，从第一步开始模拟。");
          } else {
            record.unclearCount += 1;
            reply = "我还是没能确定你的结论。可以直接给出你的判断，或者说「我需要一点提示」，我们从第一步开始。";
          }
          break;
        }
        case "guiding": {
          if (script.reachedInsight(text)) {
            record.stage = "confirmed";
            phase = undefined;
            turnDiagnosis = judged("correct", 0.8);
            reply = script.confirmation;
            const change = reinforce(db, record, { label: "经引导后自行纠正", sessionId, excerpt: excerpt(text) });
            if (change) memoryChanges.push(change);
          } else if (ASK_FOR_ANSWER.test(text) || record.hintIndex >= hints.length) {
            reply = giveExplanation("多轮提示后查看了完整讲解");
          } else {
            reply = hints[record.hintIndex];
            record.hintIndex += 1;
          }
          break;
        }
        default:
          phase = undefined;
          reply = WRAP_UP;
      }

      saveDb(db);
      return { reply: tutorMessage(reply, phase), memoryChanges, diagnosis: turnDiagnosis };
    },

    async listMemories(studentId) {
      await simulate("memories");
      return loadDb()
        .memories.filter((memory) => memory.studentId === studentId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async deleteMemory(memoryId) {
      await simulate("delete");
      const db = loadDb();
      const remaining = db.memories.filter((memory) => memory.id !== memoryId);
      if (remaining.length === db.memories.length) {
        throw new ApiError("not_found", "记忆不存在或已被删除", 404);
      }
      db.memories = remaining;
      Object.values(db.sessions).forEach((record) => {
        if (record.issueMemoryId === memoryId) record.issueMemoryId = null;
      });
      saveDb(db);
    },
  };
}

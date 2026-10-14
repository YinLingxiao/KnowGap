/**
 * 前端视图模型（View Model）
 *
 * ⚠️ 这些类型只描述「页面需要展示什么」，不是前后端接口契约。
 * 字段含义参考 MVP_SPEC v0.1 草案；后端契约确定后，请在
 * src/lib/api/http-client.ts 中把接口响应映射为这些类型，
 * 页面组件就不需要随接口字段改名而改动。
 */

import type { DataSource } from "@/lib/config";

/** 学习记忆状态（MVP_SPEC §6.2 建议的四种状态） */
export type MemoryStatus = "suspected" | "needs_review" | "improving" | "resolved";

export interface Problem {
  id: string;
  title: string;
  topicKey: string;
  topicLabel?: string;
  difficulty?: string;
  /** 题干，可用反引号标记 `代码片段` */
  statement: string;
  /** 入栈顺序与待判断序列（后端题目提供时用于排版，不含参考答案） */
  inputSequence?: number[];
  outputSequence?: number[];
}

export interface AnswerSubmission {
  studentId: string;
  problemId: string;
  answer: string;
  reasoning: string;
  webSearch?: boolean;
}

export interface Diagnosis {
  assessment?: "correct" | "incorrect" | "uncertain";
  topicKey: string;
  topicLabel?: string;
  /** 允许为 null：没有发现明显误区时不强行制造漏洞 */
  issue: string | null;
  evidence: string | null;
  /** 启发式可信度，未经校准，不是概率 */
  confidence: number | null;
}

export type MessageRole = "student" | "tutor";

/** 区分「提示阶段」与「答案阶段」（MVP_SPEC §7） */
export type TutorPhase = "hint" | "answer";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  phase?: TutorPhase;
  /** 学生消息：后端对这条回答的诊断（每轮评价当前回答） */
  diagnosis?: Diagnosis;
  webSources?: WebSource[];
  sources?: SourceReference[];
}

export interface WebSource {
  id: string; label: string; title: string; url: string; snippet: string;
}
export interface WebSearchResponse {
  provider: "anysearch"; query: string; results: WebSource[]; request_id: string | null;
}

export interface CourseMaterial {
  id: string; title: string; kind: "pdf" | "txt" | "md";
  pageCount: number; chunkCount: number; createdAt: string;
}

export interface SourceReference {
  id: string; documentId: string; title: string; label: string;
  page?: number | null; startLine?: number | null; endLine?: number | null; excerpt: string;
}

export interface MemoryChange {
  memoryId: string;
  action: "created" | "updated" | "deleted";
  summary?: string;
  fromStatus?: MemoryStatus;
  toStatus?: MemoryStatus;
}

export interface EvidenceRef {
  label: string;
  sessionId?: string;
  messageId?: string;
  excerpt?: string;
}

export interface LearningMemory {
  id: string;
  studentId: string;
  topicKey: string;
  topicLabel?: string;
  issueKey: string;
  summary: string;
  status: MemoryStatus;
  confidence: number | null;
  evidenceCount: number;
  evidenceRefs: EvidenceRef[];
  updatedAt: string;
}

export interface SessionStart {
  turn?: number;
  sessionId: string;
  diagnosis: Diagnosis;
  reply: ChatMessage;
  usedMemoryIds: string[];
  memoryChanges: MemoryChange[];
}

export interface TutorTurn {
  turn?: number;
  diagnosis?: Diagnosis;
  usedMemoryIds?: string[];
  reply: ChatMessage;
  memoryChanges: MemoryChange[];
}

/** Persisted server state, recovered by API mode; Mock mode keeps its existing script. */
export interface SessionSnapshot {
  id: string;
  problemId: string;
  turn: number;
  submission: { answer: string; reasoning: string };
  /** 首次作答的诊断；diagnosis 为最新一轮 */
  submissionDiagnosis?: Diagnosis;
  diagnosis: Diagnosis;
  usedMemoryIds: string[];
  messages: ChatMessage[];
}

/** 页面依赖的数据访问接口；Mock 与真实后端各有一个实现。 */
export interface KnowGapClient {
  readonly source: DataSource;
  checkHealth(): Promise<void>;
  listProblems(): Promise<Problem[]>;
  startSession(input: AnswerSubmission): Promise<SessionStart>;
  sendMessage(sessionId: string, content: string, webSearch?: boolean): Promise<TutorTurn>;
  getSession?(sessionId: string): Promise<SessionSnapshot>;
  listMemories(studentId: string): Promise<LearningMemory[]>;
  deleteMemory(memoryId: string): Promise<void>;
}

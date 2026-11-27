/** 自由对话的视图模型；接口字段映射见 ./api.ts */
import type { SourceReference } from "@/lib/types";
import type { LearningPlan, PlanChange } from "./plan";

export type MessageStatus = "complete" | "streaming" | "failed" | "cancelled";
export type MemoryKind = "misconception" | "mastery" | "preference";
export type LearnerMemoryStatus = "suspected" | "needs_review" | "improving" | "resolved" | "observed" | "uncertain";
export type Level = "beginner" | "some" | "fluent" | "exam";
export type ConversationKind = "chat" | "main" | "thread";
export type ThreadStatus = "open" | "resolved";

export interface ExerciseAttempt {
  problemId: string;
  assessment: "correct" | "incorrect" | "uncertain";
  issue: string | null;
  evidence: string;
}

export interface MemoryEvidence {
  conversationId: string | null;
  messageId: string | null;
  quote: string;
  reason: string;
  signal: "supports" | "contradicts";
  createdAt: string;
  sourceAvailable: boolean;
  /** message_quote：对话原话；quiz_attempt：随堂微测作答；inferred：依据（不是原话） */
  source: "message_quote" | "quiz_attempt" | "inferred";
}

export interface SpaceProgress {
  toReview: number;
  improving: number;
  mastered: number;
  openThreads: number;
  resolvedThreads: number;
  lastStudiedAt: string | null;
}

/** 学习空间：一条主线、若干支线、说明、资料和记忆 */
export interface Subject {
  id: string;
  name: string;
  description: string;
  instructions: string;
  goal: string;
  level: Level | null;
  color: string;
  icon?: string;
  mainConversationId: string | null;
  /** 主线对话的模型；null 表示用全局默认。 */
  mainModelKey: string | null;
  /** 本空间支线的默认模型；null 表示跟随主线。 */
  threadModelKey: string | null;
  progress: SpaceProgress;
  conversationCount: number;
  memoryCount: number;
  materialCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceInput {
  name?: string;
  goal?: string;
  level?: Level | null;
  color?: string;
  icon?: string;
  description?: string;
  instructions?: string;
  /** 本空间支线的默认模型；null 表示跟随主线。 */
  threadModelKey?: string | null;
}

export interface LearnerMemory {
  id: string;
  kind: MemoryKind;
  topic: string;
  topicKey: string | null;
  summary: string;
  status: LearnerMemoryStatus;
  userCorrected: boolean;
  origin: "chat" | "diagnosis";
  /** null：通用记忆，在所有 Subject 中都可参考 */
  subjectId: string | null;
  tags: string[];
  evidence: MemoryEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryChange {
  action: "created" | "updated";
  memory: LearnerMemory;
}

/** 通用用户记忆（USER / MEMORY）的一次写入；只用于「已写入用户记忆」提示 */
export interface MemoryWriteItem {
  id: string;
  layer: "USER" | "MEMORY";
  content: string;
}

export interface TokenUsage {
  requests: number;
  reportedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number | null;
}

export interface SpaceUsage {
  total: TokenUsage;
  conversations: Record<string, TokenUsage>;
}

/** 学习空间记忆汇总进总记忆（USER 笔记）的状态。 */
export interface SpaceMemorySync {
  syncedAt: string | null;
  nextSyncAt: string | null;
  /** 当前写在总记忆里的那条摘要；还没同步过或空间没有可汇总的记忆时为 null。 */
  entry: string | null;
  intervalDays: number;
}

export type SpaceMemorySyncStatus = "synced" | "unchanged" | "not_due" | "error";

/** 本空间 Memory.md 的一次写入：来自支线合并、主线整理或用户手动编辑。 */
export interface SpaceMemoryNoteWrite {
  id: string;
  action: "add" | "patch" | "remove" | "replace";
  content: string;
  oldText: string;
  source: "thread" | "main" | "user";
  sourceId: string | null;
  sourceTitle: string | null;
  createdAt: string;
  revoked: boolean;
}

/** 学习空间的 Memory.md：主线整理的学习记录，主线和支线每轮都会读取。 */
export interface SpaceMemoryNotes {
  entries: string[];
  /** 当前字数（每条一行）。 */
  size: number;
  updatedAt: string | null;
  limit: number;
  history: SpaceMemoryNoteWrite[];
}

/** 已合并支线的小结卡，也就是每条支线的记忆。 */
export interface SpaceThreadNote {
  threadId: string;
  messageId: string;
  title: string;
  summary: string;
  takeaways: string[];
  mergedAt: string;
  status: string;
}

export interface ThreadProposal {
  id: string;
  title: string;
  task: string;
  reason: string;
  threadId: string | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: "user" | "assistant";
  kind: "text" | "exercise";
  content: string;
  status: MessageStatus;
  error: string | null;
  replyTo: string | null;
  problemId: string | null;
  attempt: ExerciseAttempt | null;
  memoryChanges: MemoryChange[];
  /** 该条回复触发的通用记忆写入；历史消息可能没有此字段 */
  memoryWrites?: MemoryWriteItem[];
  usedMemoryIds: string[];
  suggestedProblemId: string | null;
  sources: SourceReference[];
  truncated: boolean;
  /** 模型返回的思考过程（服务商不提供时为空）；只用于展示，不会再发给模型 */
  reasoning?: string;
  files?: GeneratedFile[];
  toolCalls: ToolCallView[];
  pendingApproval: ToolApproval | null;
  preferencePrompt: { id: string; text: string; content: string } | null;
  nextActions: Array<"quiz" | "schedule" | "save_note" | "weak_points">;
  threadSummary: ThreadSummary | null;
  checkpointAvailable?: boolean;
  checkpointBlockedReason?: string | null;
  threadProposals?: ThreadProposal[];
  /** 主线用户消息下要展示的支线卡；标题与状态按 id 从支线列表实时取 */
  dispatchedThreads?: Array<{ threadId: string }>;
  /** 隐藏的系统事件消息（如支线汇报唤醒协调者），学习者看不到 */
  systemEvent?: SystemEvent | null;
  planChanges?: PlanChange[];
  createdAt: string;
}

/** AI 生成或修改出来的文件（docx / pptx / xlsx / pdf / md），可以下载 */
export interface GeneratedFile {
  id: string;
  name: string;
  kind: string;
  size: number;
}

export interface ToolCallView {
  id: string;
  name: string;
  arguments: string;
  output: string;
  ok: boolean;
}

export interface ToolApproval {
  id: string;
  name: string;
  arguments: string;
}

export interface ThreadSummary {
  threadId: string;
  title: string;
  summary: string;
  takeaways: string[];
  memoryIds: string[];
}

/** 服务端写入的隐藏系统事件；目前只有支线汇报唤醒协调者一种 */
export interface SystemEvent {
  type: string;
  reportIds: string[];
  threadIds: string[];
}

export interface MessageAnchor {
  messageId: string;
  role: "user" | "assistant";
  excerpt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  titleSource: "pending" | "auto" | "user";
  subjectId: string | null;
  kind: ConversationKind;
  parentId: string | null;
  threadStatus: ThreadStatus | null;
  executionStatus?: ExecutionStatus | null;
  anchor: MessageAnchor | null;
  activeProblemId: string | null;
  legacySessionId: string | null;
  messageCount: number;
  preview: string;
  modelKey: string | null;
  generating: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
}

/** 微测作答结果；answerIndex / explanation 只在作答后由服务端给出 */
export interface QuizAttemptResult {
  quizId: string;
  attemptId: string;
  optionIndex: number;
  correct: boolean;
  answerIndex: number;
  explanation: string;
  /** 该题此前已作答，返回的是首次结果 */
  repeated: boolean;
  /** 本次提交写入的记忆变化；重放和刷新恢复时为空 */
  memoryChanges: MemoryChange[];
  /** 本次提交推进完成的计划步骤 */
  planStep: { id: string; title: string } | null;
}

export type ExecutionStatus = "queued" | "working" | "waiting" | "idle" | "failed" | "cancelled";

/** 一次发送 / 重新生成的流式事件，已映射为视图模型 */
export type StreamEvent =
  | { type: "connection"; reconnecting: boolean }
  | { type: "thread_dispatched"; threadId: string }
  | { type: "start"; conversation: ConversationSummary | null; userMessage: ChatMessage | null;
      assistantMessage: ChatMessage | null; discardedIds: string[]; replayed: boolean; modelNotice: string | null }
  | { type: "model_notice"; detail: string }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "file"; file: GeneratedFile }
  | { type: "done"; message: ChatMessage | null }
  | { type: "cancelled"; message: ChatMessage | null }
  | { type: "error"; detail: string; statusCode: number; message: ChatMessage | null }
  | { type: "analysis"; userMessage: ChatMessage | null; assistantMessage: ChatMessage | null; skipped: boolean }
  | { type: "memory_write"; items: MemoryWriteItem[] }
  | { type: "tool_start"; id: string; name: string; arguments: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; output: string }
  | { type: "tool_approval"; id: string; name: string; arguments: string }
  | { type: "plan"; plan: LearningPlan };

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
}

export interface SpaceProgress {
  toReview: number;
  improving: number;
  mastered: number;
  openThreads: number;
  resolvedThreads: number;
  lastStudiedAt: string | null;
}

/** 学习空间：一条主对话、若干 Thread、说明、资料和记忆 */
export interface Subject {
  id: string;
  name: string;
  description: string;
  instructions: string;
  goal: string;
  level: Level | null;
  deadline: string | null;
  color: string;
  mainConversationId: string | null;
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
  deadline?: string | null;
  color?: string;
  description?: string;
  instructions?: string;
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
  usedMemoryIds: string[];
  suggestedProblemId: string | null;
  sources: SourceReference[];
  truncated: boolean;
  toolCalls: ToolCallView[];
  pendingApproval: ToolApproval | null;
  preferencePrompt: { id: string; text: string; content: string } | null;
  nextActions: Array<"quiz" | "schedule" | "save_note" | "weak_points">;
  threadSummary: ThreadSummary | null;
  checkpointAvailable?: boolean;
  checkpointBlockedReason?: string | null;
  threadProposals?: ThreadProposal[];
  threadUpdate?: { threadId: string; title: string; status: ExecutionStatus; summary: string } | null;
  planChanges?: PlanChange[];
  createdAt: string;
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
  generating: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
}

export type ExecutionStatus = "queued" | "working" | "waiting" | "idle" | "failed" | "cancelled";

/** 一次发送 / 重新生成的流式事件，已映射为视图模型 */
export type StreamEvent =
  | { type: "thread_dispatched"; threadId: string }
  | { type: "start"; conversation: ConversationSummary | null; userMessage: ChatMessage | null;
      assistantMessage: ChatMessage | null; discardedIds: string[]; replayed: boolean }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage | null }
  | { type: "cancelled"; message: ChatMessage | null }
  | { type: "error"; detail: string; statusCode: number; message: ChatMessage | null }
  | { type: "analysis"; userMessage: ChatMessage | null; assistantMessage: ChatMessage | null; skipped: boolean }
  | { type: "tool_start"; id: string; name: string; arguments: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; output: string }
  | { type: "tool_approval"; id: string; name: string; arguments: string }
  | { type: "plan"; plan: LearningPlan };

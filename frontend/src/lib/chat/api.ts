/** 自由对话接口：REST + Server-Sent Events。接口字段（snake_case）只在这里出现。 */
import { ApiError } from "@/lib/api/errors";
import { mapSource, request, type WireSource } from "@/lib/api/http-client";
import { API_BASE_URL } from "@/lib/config";
import type { Problem } from "@/lib/types";
import type {
  ChatMessage, Conversation, ConversationSummary, LearnerMemory, LearnerMemoryStatus, MemoryChange, SpaceInput,
  StreamEvent, Subject,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are mapped field by field below */
type Wire = any;

function mapMemory(data: Wire): LearnerMemory {
  return {
    id: data.id, kind: data.kind, topic: data.topic, topicKey: data.topic_key, summary: data.summary,
    status: data.status, userCorrected: data.user_corrected, origin: data.origin,
    subjectId: data.subject_id ?? null, tags: data.tags ?? [],
    createdAt: data.created_at, updatedAt: data.updated_at,
    evidence: (data.evidence ?? []).map((item: Wire) => ({
      conversationId: item.conversation_id, messageId: item.message_id, quote: item.quote, reason: item.reason,
      signal: item.signal, createdAt: item.created_at, sourceAvailable: item.source_available,
    })),
  };
}

function mapMessage(data: Wire): ChatMessage {
  return {
    id: data.id, conversationId: data.conversation_id, seq: data.seq, role: data.role, kind: data.kind,
    content: data.content, status: data.status, error: data.error ?? null, replyTo: data.reply_to ?? null,
    problemId: data.problem_id ?? null,
    attempt: data.attempt ? {
      problemId: data.attempt.problem_id, assessment: data.attempt.assessment,
      issue: data.attempt.issue ?? null, evidence: data.attempt.evidence,
    } : null,
    memoryChanges: (data.memory_changes ?? []).map((change: Wire): MemoryChange => ({
      action: change.action, memory: mapMemory(change.memory),
    })),
    usedMemoryIds: data.used_memory_ids ?? [],
    suggestedProblemId: data.suggested_problem_id ?? null,
    sources: (data.sources ?? []).map((source: WireSource) => mapSource(source)),
    truncated: Boolean(data.truncated),
    toolCalls: (data.tool_calls ?? []).map((call: Wire) => ({
      id: String(call.id), name: String(call.name), arguments: String(call.arguments ?? ""),
      output: String(call.output ?? ""), ok: call.ok !== false,
    })),
    pendingApproval: data.pending_approval ? {
      id: String(data.pending_approval.id), name: String(data.pending_approval.name),
      arguments: String(data.pending_approval.arguments ?? ""),
    } : null,
    threadUpdate: data.thread_update ? {
      threadId: data.thread_update.thread_id, title: data.thread_update.title,
      status: data.thread_update.status, summary: data.thread_update.summary,
    } : null,
    threadSummary: data.thread_summary ? {
      threadId: data.thread_summary.thread_id, title: data.thread_summary.title, summary: data.thread_summary.summary,
      takeaways: data.thread_summary.takeaways ?? [], memoryIds: data.thread_summary.memory_ids ?? [],
    } : null,
    createdAt: data.created_at,
  };
}

function mapSummary(data: Wire): ConversationSummary {
  return {
    id: data.id, title: data.title, titleSource: data.title_source, subjectId: data.subject_id ?? null,
    kind: data.kind ?? "chat", parentId: data.parent_id ?? null, threadStatus: data.thread_status ?? null,
    executionStatus: data.execution_status ?? null,
    anchor: data.anchor ? { messageId: data.anchor.message_id, role: data.anchor.role, excerpt: data.anchor.excerpt } : null,
    activeProblemId: data.active_problem_id,
    legacySessionId: data.legacy_session_id, messageCount: data.message_count, preview: data.preview,
    generating: Boolean(data.generating), createdAt: data.created_at, updatedAt: data.updated_at,
  };
}

function mapSubject(data: Wire): Subject {
  return {
    id: data.id, name: data.name, description: data.description, instructions: data.instructions,
    goal: data.goal ?? "", level: data.level ?? null, deadline: data.deadline ?? null, color: data.color ?? "#3d6fdb",
    mainConversationId: data.main_conversation_id ?? null,
    progress: {
      toReview: data.progress?.to_review ?? 0, improving: data.progress?.improving ?? 0,
      mastered: data.progress?.mastered ?? 0, openThreads: data.progress?.open_threads ?? 0,
      resolvedThreads: data.progress?.resolved_threads ?? 0, lastStudiedAt: data.progress?.last_studied_at ?? null,
    },
    conversationCount: data.conversation_count, memoryCount: data.memory_count, materialCount: data.material_count,
    createdAt: data.created_at, updatedAt: data.updated_at,
  };
}

function spaceBody(input: SpaceInput): Wire {
  const body: Wire = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.goal !== undefined) body.goal = input.goal;
  if (input.level !== undefined) body.level = input.level;
  if (input.deadline !== undefined) body.deadline = input.deadline;
  if (input.color !== undefined) body.color = input.color;
  if (input.description !== undefined) body.description = input.description;
  if (input.instructions !== undefined) body.instructions = input.instructions;
  return body;
}

function mapConversation(data: Wire): Conversation {
  return { ...mapSummary(data), messages: (data.messages ?? []).map(mapMessage) };
}

const maybe = <T,>(value: Wire, map: (data: Wire) => T): T | null => (value ? map(value) : null);

function mapEvent(type: string, data: Wire): StreamEvent | null {
  switch (type) {
    case "thread_dispatched":
      return { type, threadId: String(data.thread_id) };
    case "start":
      return { type, conversation: maybe(data.conversation, mapSummary), userMessage: maybe(data.user_message, mapMessage),
        assistantMessage: maybe(data.assistant_message, mapMessage), discardedIds: data.discarded_ids ?? [],
        replayed: Boolean(data.replayed) };
    case "delta":
      return { type, text: String(data.text ?? "") };
    case "done":
    case "cancelled":
      return { type, message: maybe(data.message, mapMessage) };
    case "error":
      return { type, detail: String(data.detail ?? "生成失败"), statusCode: Number(data.status_code ?? 500),
        message: maybe(data.message, mapMessage) };
    case "analysis":
      return { type, userMessage: maybe(data.user_message, mapMessage),
        assistantMessage: maybe(data.assistant_message, mapMessage), skipped: Boolean(data.skipped) };
    case "tool_start":
      return { type: "tool_start", id: String(data.id), name: String(data.name ?? ""), arguments: String(data.arguments ?? "") };
    case "tool_approval":
      return { type: "tool_approval", id: String(data.id), name: String(data.name ?? ""), arguments: String(data.arguments ?? "") };
    case "tool_end":
      return { type: "tool_end", id: String(data.id), name: String(data.name ?? ""), ok: Boolean(data.ok), output: String(data.output ?? "") };
    default:
      return null;
  }
}

const root = API_BASE_URL;
const path = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;

export const chatApi = {
  async listConversations(): Promise<ConversationSummary[]> {
    return (await request<Wire[]>(root, "/api/conversations", { cache: "no-store" })).map(mapSummary);
  },
  async getConversation(id: string): Promise<Conversation> {
    return mapConversation(await request(root, path(id), { cache: "no-store" }));
  },
  async createConversation(input: { problemId?: string; clientRequestId?: string; subjectId?: string | null }): Promise<Conversation> {
    return mapConversation(await request(root, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        ...(input.problemId ? { problem_id: input.problemId } : {}),
        ...(input.subjectId ? { subject_id: input.subjectId } : {}),
        ...(input.clientRequestId ? { client_request_id: input.clientRequestId } : {}),
      }),
    }));
  },
  async updateConversation(id: string, patch: { title?: string; subjectId?: string | null }): Promise<Conversation> {
    return mapConversation(await request(root, path(id), {
      method: "PATCH",
      body: JSON.stringify({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.subjectId !== undefined ? { subject_id: patch.subjectId } : {}),
      }),
    }));
  },
  async listSubjects(): Promise<Subject[]> {
    return (await request<Wire[]>(root, "/api/subjects", { cache: "no-store" })).map(mapSubject);
  },
  async createSubject(input: SpaceInput & { name: string }): Promise<Subject> {
    return mapSubject(await request(root, "/api/subjects", { method: "POST", body: JSON.stringify(spaceBody(input)) }));
  },
  async updateSubject(id: string, patch: SpaceInput): Promise<Subject> {
    return mapSubject(await request(root, `/api/subjects/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify(spaceBody(patch)),
    }));
  },
  async listThreads(subjectId: string): Promise<ConversationSummary[]> {
    return (await request<Wire[]>(root, `/api/subjects/${encodeURIComponent(subjectId)}/threads`, { cache: "no-store" })).map(mapSummary);
  },
  async createThread(subjectId: string, input: { title?: string; anchorMessageId?: string; clientRequestId: string }): Promise<Conversation> {
    return mapConversation(await request(root, `/api/subjects/${encodeURIComponent(subjectId)}/threads`, {
      method: "POST",
      body: JSON.stringify({
        ...(input.title ? { title: input.title } : {}),
        ...(input.anchorMessageId ? { anchor_message_id: input.anchorMessageId } : {}),
        client_request_id: input.clientRequestId,
      }),
    }));
  },
  async draftResolution(id: string): Promise<{ title: string; summary: string; takeaways: string[] }> {
    const data = await request<Wire>(root, `${path(id)}/resolve/draft`, { method: "POST" });
    return { title: data.title, summary: data.summary, takeaways: data.takeaways ?? [] };
  },
  async resolveThread(id: string, body: { title: string; summary: string; takeaways: string[] }): Promise<{ messageId: string | null }> {
    const data = await request<Wire>(root, `${path(id)}/resolve`, { method: "POST", body: JSON.stringify(body) });
    return { messageId: data.message_id ?? null };
  },
  async reopenThread(id: string): Promise<Conversation> {
    return mapConversation(await request(root, `${path(id)}/reopen`, { method: "POST" }));
  },
  async deleteSubject(id: string): Promise<void> {
    await request(root, `/api/subjects/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async deleteConversation(id: string): Promise<void> {
    await request(root, path(id), { method: "DELETE" });
  },
  async startExercise(id: string, problemId: string): Promise<Conversation> {
    return mapConversation(await request(root, `${path(id)}/exercises`, {
      method: "POST", body: JSON.stringify({ problem_id: problemId }),
    }));
  },
  async stop(id: string): Promise<boolean> {
    return (await request<{ stopped: boolean }>(root, `${path(id)}/stop`, { method: "POST" })).stopped;
  },
  async listProblems(): Promise<Problem[]> {
    const data = await request<Wire[]>(root, "/api/problems");
    return data.map((problem) => ({ id: problem.id, title: problem.title, topicKey: problem.topic_key,
      statement: problem.prompt, inputSequence: problem.input_sequence, outputSequence: problem.output_sequence }));
  },
  async listMemories(): Promise<LearnerMemory[]> {
    return (await request<Wire[]>(root, "/api/learner-memories", { cache: "no-store" })).map(mapMemory);
  },
  async updateMemory(
    id: string, patch: { summary?: string; status?: LearnerMemoryStatus; subjectId?: string | null },
  ): Promise<LearnerMemory> {
    const { subjectId, ...rest } = patch;
    return mapMemory(await request(root, `/api/learner-memories/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify({ ...rest, ...(subjectId !== undefined ? { subject_id: subjectId } : {}) }),
    }));
  },
  async deleteMemory(id: string): Promise<void> {
    await request(root, `/api/learner-memories/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async agentNotes(): Promise<{ user: string; memory: string; limits: { user: number; memory: number } }> {
    const data = await request<Wire>(root, "/api/agent-memory", { cache: "no-store" });
    return { user: data.user ?? "", memory: data.memory ?? "", limits: { user: data.limits?.user ?? 1375, memory: data.limits?.memory ?? 2200 } };
  },
  async saveAgentNote(target: "user" | "memory", content: string): Promise<{ user: string; memory: string; limits: { user: number; memory: number } }> {
    const data = await request<Wire>(root, "/api/agent-memory", {
      method: "PUT", body: JSON.stringify({ target, content }),
    });
    return { user: data.user ?? "", memory: data.memory ?? "", limits: { user: data.limits?.user ?? 1375, memory: data.limits?.memory ?? 2200 } };
  },
  async pendingNotes(): Promise<Array<{ id: string; action: string; target: string; content: string; oldText: string }>> {
    const data = await request<Wire[]>(root, "/api/agent-memory/pending", { cache: "no-store" });
    return data.map((item) => ({
      id: item.id, action: item.action, target: item.target, content: item.content ?? "", oldText: item.old_text ?? "",
    }));
  },
  async decidePending(id: string, allow: boolean): Promise<void> {
    await request(root, `/api/agent-memory/pending/${encodeURIComponent(id)}`, {
      method: "POST", body: JSON.stringify({ allow }),
    });
  },
  async agentSettings(): Promise<{ workspace: string; autoApprove: boolean; memoryWriteApproval: boolean }> {
    const data = await request<Wire>(root, "/api/agent/settings", { cache: "no-store" });
    return { workspace: data.workspace ?? "", autoApprove: Boolean(data.auto_approve), memoryWriteApproval: Boolean(data.memory_write_approval) };
  },
  async saveAgentSettings(input: { workspace: string; autoApprove: boolean; memoryWriteApproval: boolean }): Promise<{ workspace: string; autoApprove: boolean; memoryWriteApproval: boolean }> {
    const data = await request<Wire>(root, "/api/agent/settings", {
      method: "PUT", body: JSON.stringify({
        workspace: input.workspace, auto_approve: input.autoApprove, memory_write_approval: input.memoryWriteApproval,
      }),
    });
    return { workspace: data.workspace ?? "", autoApprove: Boolean(data.auto_approve), memoryWriteApproval: Boolean(data.memory_write_approval) };
  },
  async decideTool(approvalId: string, allow: boolean): Promise<void> {
    await request(root, `/api/chat/tool-approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST", body: JSON.stringify({ allow }),
    });
  },
  sendMessage(id: string, content: string, clientRequestId: string, onEvent: (event: StreamEvent) => void, signal: AbortSignal) {
    return stream(`${path(id)}/messages`, JSON.stringify({ content, client_request_id: clientRequestId }), onEvent, signal);
  },
  regenerate(id: string, onEvent: (event: StreamEvent) => void, signal: AbortSignal) {
    return stream(`${path(id)}/regenerate`, undefined, onEvent, signal);
  },
};

/** 连接建立前失败会抛出 ApiError（此时服务端可能尚未保存消息）；建立后的问题通过事件或 "interrupted" 返回 */
async function stream(
  url: string, body: string | undefined, onEvent: (event: StreamEvent) => void, signal: AbortSignal,
): Promise<"ended" | "interrupted"> {
  let response: Response;
  // Only the connection phase has a deadline; a long answer may legitimately stream for minutes.
  const connectTimeout = new AbortController();
  const timer = window.setTimeout(() => connectTimeout.abort(), 30_000);
  const abort = () => connectTimeout.abort();
  signal.addEventListener("abort", abort);
  try {
    response = await fetch(`${root}${url}`, {
      method: "POST", body, signal: connectTimeout.signal,
      headers: { Accept: "text/event-stream", ...(body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) throw new ApiError("unknown", "已取消发送");
    if (connectTimeout.signal.aborted) throw new ApiError("timeout", "连接后端超时，输入已保留，可以重试。");
    throw new ApiError("network", "无法连接到后端服务，输入已保留，可以重试。");
  } finally {
    window.clearTimeout(timer);
  }
  if (!response.ok || !response.body) {
    signal.removeEventListener("abort", abort);
    let detail = `请求失败（HTTP ${response.status}）`;
    try {
      const data = await response.json();
      if (typeof data?.detail === "string") detail = data.detail;
    } catch { /* keep the generic message */ }
    const kind = response.status === 409 ? "conflict" : response.status === 404 ? "not_found"
      : response.status === 422 ? "validation" : "server";
    throw new ApiError(kind, detail, response.status);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let terminal = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value.replace(/\r\n/g, "\n");
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let type = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        const event = mapEvent(type, JSON.parse(data.join("\n")));
        if (!event) continue;
        if (event.type === "done" || event.type === "cancelled" || event.type === "error") terminal = true;
        onEvent(event);
      }
    }
    return terminal ? "ended" : "interrupted";
  } catch {
    return terminal ? "ended" : "interrupted";
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

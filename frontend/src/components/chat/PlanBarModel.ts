/** 学习计划条的纯逻辑：版本过滤、进度、当前步骤、乐观更新、时间线标记、小结文本。不依赖 React，便于单测。 */
import type { LearningPlan, PlanChange, PlanStep, PlanStepStatus } from "@/lib/chat/plan";

export const QUIZ_PROMPT = "请就我们刚完成的这几个步骤出一道随堂测验";
export const AGENDA_PROMPT = "请把这次学的内容按第 1/3/7 天排进日程复习";

/** Optional translator so the pure helpers stay renderer-free; defaults to the Chinese source text. */
export type PhraseTranslator = (text: string, vars?: Record<string, string | number>) => string;
const sourceText: PhraseTranslator = (text) => text;

export function isFinished(status: PlanStepStatus): boolean {
  return status === "done" || status === "skipped";
}

/** 只接受同一对话、且 version 比当前更大的计划事件；返回规范化后的计划，不接受时返回 null */
export function acceptPlanEvent(
  current: LearningPlan | null,
  detail: { conversationId?: string; plan?: LearningPlan } | null | undefined,
  conversationId: string | null,
): LearningPlan | null {
  if (!conversationId || !detail?.plan || detail.conversationId !== conversationId) return null;
  if (current && detail.plan.version <= current.version) return null;
  return { ...detail.plan, conversationId };
}

export function progressOf(plan: LearningPlan) {
  const total = plan.steps.length;
  const finished = plan.steps.filter((step) => isFinished(step.status)).length;
  return { finished, total, ratio: total ? finished / total : 0, label: `${finished}/${total}` };
}

export type CurrentKind = "awaiting" | "active" | "next";

export interface CurrentStep {
  step: PlanStep;
  kind: CurrentKind;
}

/** 折叠态展示的那一步：等待作答优先，其次进行中，最后是下一个待办 */
export function currentStep(plan: LearningPlan): CurrentStep | null {
  const awaiting = plan.steps.find((step) => step.status === "awaiting_learner");
  if (awaiting) return { step: awaiting, kind: "awaiting" };
  const active = plan.steps.find((step) => step.status === "in_progress");
  if (active) return { step: active, kind: "active" };
  const next = plan.steps.find((step) => step.status === "pending");
  return next ? { step: next, kind: "next" } : null;
}

export function currentLabel(current: CurrentStep, tr: PhraseTranslator = sourceText): string {
  if (current.kind === "awaiting") return tr("等你回答：{title}", { title: current.step.note || current.step.title });
  if (current.kind === "next") return tr("下一步：{title}", { title: current.step.title });
  return current.step.title;
}

/** 用户操作的乐观结果。completedAt 由服务端写入，这里只在出现未完成步骤时清空 */
export function applyStepPatch(
  plan: LearningPlan, stepId: string, patch: { status?: "done" | "skipped" | "pending"; title?: string },
): LearningPlan {
  const steps = plan.steps.map((step) => (step.id === stepId ? {
    ...step,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
  } : step));
  return { ...plan, steps, completedAt: steps.every((step) => isFinished(step.status)) ? plan.completedAt : null };
}

/** 状态发生变化的已有步骤（新增的步骤不算） */
export function changedSteps(previous: LearningPlan | null, next: LearningPlan | null): PlanStep[] {
  if (!previous || !next) return [];
  return next.steps.filter((step) => {
    const before = previous.steps.find((item) => item.id === step.id);
    return before !== undefined && before.status !== step.status;
  });
}

export type MarkKind = "done" | "start" | "await" | "skip" | "restore";

export interface PlanMark {
  kind: MarkKind;
  glyph: string;
  verb: string;
  title: string;
}

/** 助手消息顶部的时间线标记；新增步骤（pending）不产生标记，避免首次列计划时刷屏 */
export function describeChange(change: PlanChange, tr: PhraseTranslator = sourceText): PlanMark | null {
  const title = change.title.trim();
  if (!title) return null;
  switch (change.to) {
    case "done": return { kind: "done", glyph: "✓", verb: tr("完成"), title };
    case "in_progress": return { kind: "start", glyph: "→", verb: tr("开始"), title };
    case "awaiting_learner": return { kind: "await", glyph: "?", verb: tr("等你回答"), title };
    case "skipped": return { kind: "skip", glyph: "–", verb: tr("跳过"), title };
    case "pending": return change.from && change.from !== "pending" ? { kind: "restore", glyph: "↺", verb: tr("恢复"), title } : null;
    default: return null;
  }
}

/** 同一步在一条消息里多次变化时只保留最后一次（开始 → 完成 只显示「完成」） */
export function describeChanges(changes: PlanChange[] | undefined, tr: PhraseTranslator = sourceText): PlanMark[] {
  const last = new Map<string, PlanChange>();
  (changes ?? []).forEach((change, index) => last.set(change.stepId || `#${index}`, change));
  return [...last.values()].map((change) => describeChange(change, tr)).filter((mark): mark is PlanMark => mark !== null);
}

export function summaryTitle(plan: LearningPlan, tr: PhraseTranslator = sourceText): string {
  const { total } = progressOf(plan);
  const skipped = plan.steps.filter((step) => step.status === "skipped").length;
  return skipped > 0
    ? tr("这段学习的 {total} 个步骤都走完了（跳过 {skipped} 步）", { total, skipped })
    : tr("这段学习的 {total} 个步骤都完成了", { total });
}

export function summaryMarkdown(plan: LearningPlan, now: Date = new Date(), tr: PhraseTranslator = sourceText): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const lines = plan.steps.map((step) => {
    if (step.status === "done") return `- [x] ${step.title}`;
    if (step.status === "skipped") return tr("- [ ] ~~{title}~~（已跳过）", { title: step.title });
    return `- [ ] ${step.title}`;
  });
  return [tr("## 学习小结"), "", tr("{date} · 共 {count} 步", { date, count: plan.steps.length }), "", ...lines].join("\n");
}

export function dismissKey(conversationId: string, version: number): string {
  return `knowgap.plan.summary-dismissed.v1:${conversationId}:${version}`;
}

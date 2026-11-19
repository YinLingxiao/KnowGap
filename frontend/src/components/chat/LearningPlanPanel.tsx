"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, CheckCircle2, CircleAlert, LoaderCircle, Sparkles } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { toApiError } from "@/lib/api/errors";
import { AGENDA_CHANGED_EVENT } from "@/lib/agenda/types";
import {
  learningPlanApi, type LearningPlanDraft, type PlanAgent, type PlanAgentName, type PlanTaskDraft,
} from "@/lib/chat/learningPlan";
import type { MessageKey } from "@/lib/i18n";
import { cx } from "@/lib/cx";
import styles from "./LearningPlanPanel.module.css";

const AGENT_LABEL: Record<PlanAgentName, MessageKey> = {
  diagnose: "learningPlan.agent.diagnose",
  plan: "learningPlan.agent.plan",
  review: "learningPlan.agent.review",
};

function AgentCard({ agent }: { agent: PlanAgent }) {
  const { t } = useI18n();
  const output = agent.output;
  return (
    <article className={styles.agent} data-agent={agent.agent}>
      <header className={styles.agentHead}>
        <Sparkles size={13} aria-hidden />
        <h3>{t(AGENT_LABEL[agent.agent])}</h3>
      </header>
      {output.kind === "diagnose" && (
        output.weakPoints.length ? (
          <ul className={styles.agentList}>
            {output.weakPoints.map((point, index) => (
              <li key={`${point.memoryId ?? point.topic ?? "weak"}-${index}`}>
                <span className={styles.agentItemTitle}>{point.topic ?? point.memoryId ?? "—"}</span>
                {point.summary && <span className={styles.agentItemText}>{point.summary}</span>}
                {(point.due || point.priority !== undefined) && (
                  <span className={styles.agentItemMeta}>
                    {point.due ?? ""}
                    {point.due && point.priority !== undefined ? " · " : ""}
                    {point.priority !== undefined ? `P${point.priority}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : <p className={styles.agentEmpty}>{t("learningPlan.agentEmpty")}</p>
      )}
      {output.kind === "plan" && (
        output.tasks.length ? (
          <ul className={styles.agentList}>
            {output.tasks.map((task) => (
              <li key={task.draftTaskId}>
                <span className={styles.agentItemTitle}>{task.title}</span>
                {task.durationMinutes != null && (
                  <span className={styles.agentItemMeta}>{task.durationMinutes} min</span>
                )}
              </li>
            ))}
          </ul>
        ) : <p className={styles.agentEmpty}>{t("learningPlan.agentEmpty")}</p>
      )}
      {output.kind === "review" && (
        <div className={styles.review}>
          <p>
            <CheckCircle2 size={12} aria-hidden />
            {t("learningPlan.reviewApproved", { count: output.approved.length })}
          </p>
          {output.rejected.length > 0 && (
            <ul className={styles.rejected}>
              {output.rejected.map((item, index) => (
                <li key={`${item.draftTaskId ?? "rejected"}-${index}`}>
                  <CircleAlert size={12} aria-hidden />
                  <span>{item.message ?? item.code ?? item.draftTaskId ?? "—"}</span>
                </li>
              ))}
            </ul>
          )}
          {output.totalMinutes != null && (
            <p className={styles.total}>
              {t("learningPlan.totalMinutes", { count: output.totalMinutes })}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function TaskRow({ task, checked, confirmed, onToggle }: {
  task: PlanTaskDraft;
  checked: boolean;
  confirmed: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <label className={cx(styles.task, confirmed && styles.taskConfirmed)}>
      <input type="checkbox" checked={checked || confirmed} disabled={confirmed} onChange={onToggle} />
      <span className={styles.taskBody}>
        <strong className={styles.taskTitle}>{task.title}</strong>
        <span className={styles.taskMeta}>
          <span>
            {t("learningPlan.evidence", { evidence: task.evidence ?? task.memoryId ?? t("learningPlan.noEvidence") })}
          </span>
          <span>
            {t("learningPlan.suggestedTime", {
              date: task.scheduledDate ?? "—",
              minutes: task.durationMinutes ?? "—",
            })}
          </span>
        </span>
      </span>
      {confirmed && <span className={styles.confirmedTag}>{t("learningPlan.confirmedTag")}</span>}
    </label>
  );
}

export function LearningPlanPanel({ subjectId, deadline }: { subjectId: string; deadline: string | null }) {
  const { t } = useI18n();
  const [budget, setBudget] = useState(120);
  const [targetDate, setTargetDate] = useState(deadline ?? "");
  const [stage, setStage] = useState<"idle" | "generating" | "ready">("idle");
  const [draft, setDraft] = useState<LearningPlanDraft | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  const reveal = (count: number) => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
    setRevealed(Math.min(1, count));
    for (let step = 2; step <= count; step++) {
      timers.current.push(window.setTimeout(() => setRevealed(step), (step - 1) * 550));
    }
  };

  const generate = async () => {
    if (!targetDate) {
      setError(t("learningPlan.deadlineRequired"));
      return;
    }
    if (!Number.isInteger(budget) || budget < 5 || budget > 720) {
      setError(t("learningPlan.budgetInvalid"));
      return;
    }
    setError(null);
    setNotice(null);
    setStage("generating");
    setDraft(null);
    setSelected(new Set());
    setConfirmed(new Set());
    setRevealed(0);
    try {
      const next = await learningPlanApi.draft({ subjectId, budgetMinutes: budget, deadline: targetDate });
      setDraft(next);
      reveal(next.agents.length);
      setStage("ready");
    } catch (cause) {
      setError(t("learningPlan.generateFailed", { detail: toApiError(cause).message }));
      setStage("idle");
    }
  };

  const toggle = (taskId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const confirm = async () => {
    if (!draft?.draftId || !selected.size || confirming) return;
    setError(null);
    setNotice(null);
    setConfirming(true);
    const ids = [...selected];
    try {
      const result = await learningPlanApi.confirm(draft.draftId, ids);
      setConfirmed((current) => new Set([...current, ...ids]));
      setSelected(new Set());
      window.dispatchEvent(new Event(AGENDA_CHANGED_EVENT));
      setNotice(result.skipped.length
        ? t("learningPlan.confirmSkipped", { created: result.created.length, skipped: result.skipped.length })
        : t("learningPlan.confirmSuccess", { count: result.created.length }));
    } catch (cause) {
      setError(t("learningPlan.confirmFailed", { detail: toApiError(cause).message }));
    } finally {
      setConfirming(false);
    }
  };

  const ready = stage === "ready" && draft !== null;
  const agentsDone = draft !== null && (draft.agents.length === 0 || revealed >= draft.agents.length);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <h2>{t("learningPlan.title")}</h2>
          <p className={styles.subtitle}>{t("learningPlan.subtitle")}</p>
        </div>
      </header>

      <div className={styles.controls}>
        <label className={styles.field}>
          <span>{t("learningPlan.budget")}</span>
          <input
            type="number" min={5} max={720} step={5} value={budget}
            disabled={stage === "generating"}
            onChange={(event) => setBudget(Number(event.target.value))}
          />
        </label>
        <label className={styles.field}>
          <span><CalendarDays size={12} aria-hidden />{t("learningPlan.deadline")}</span>
          <input
            type="date" value={targetDate} disabled={stage === "generating"}
            onChange={(event) => setTargetDate(event.target.value)}
          />
        </label>
        <button type="button" className={styles.generate} disabled={stage === "generating"} onClick={() => void generate()}>
          {stage === "generating" ? <LoaderCircle className={styles.spin} size={14} /> : <Sparkles size={14} />}
          {ready ? t("learningPlan.regenerate") : t("learningPlan.generate")}
        </button>
      </div>

      {error && (
        <div className={styles.error} role="alert">
          <CircleAlert size={14} aria-hidden />
          <span>{error}</span>
          <button type="button" onClick={() => void generate()}>{t("common.retry")}</button>
        </div>
      )}

      {stage === "generating" && (
        <p className={styles.loading} role="status">
          <LoaderCircle className={styles.spin} size={14} aria-hidden />
          {t("learningPlan.generating")}
        </p>
      )}

      {draft && (
        <section className={styles.agents} aria-label={t("learningPlan.agentsAria")}>
          {draft.agents.slice(0, revealed).map((agent) => <AgentCard key={agent.agent} agent={agent} />)}
        </section>
      )}

      {ready && agentsDone && (
        <section className={styles.tasks}>
          <div className={styles.tasksHead}>
            <h3>{t("learningPlan.tasks")}</h3>
            <span>{t("learningPlan.selectHint")}</span>
          </div>
          {draft.tasks.length === 0 ? (
            <p className={styles.agentEmpty}>{t("learningPlan.noTasks")}</p>
          ) : (
            <div className={styles.taskList}>
              {draft.tasks.map((task) => (
                <TaskRow
                  key={task.draftTaskId}
                  task={task}
                  checked={selected.has(task.draftTaskId)}
                  confirmed={confirmed.has(task.draftTaskId)}
                  onToggle={() => toggle(task.draftTaskId)}
                />
              ))}
            </div>
          )}
          {draft.tasks.length > 0 && (
            <button
              type="button"
              className={styles.confirm}
              disabled={confirming || selected.size === 0}
              onClick={() => void confirm()}
            >
              {confirming ? t("learningPlan.confirming") : t("learningPlan.confirm", { count: selected.size })}
            </button>
          )}
        </section>
      )}

      {notice && <p className={styles.notice} role="status">{notice}</p>}
    </div>
  );
}
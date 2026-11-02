"use client";

import dynamic from "next/dynamic";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert,
  Lightbulb, LoaderCircle, MessageSquarePlus,
} from "lucide-react";
import { cx } from "@/lib/cx";
import { cachedQuizAttempt, loadQuizAttempts, submitQuizAttempt, subscribeQuizAttempts } from "@/lib/chat/quizAttempts";
import { PLAN_EVENT, planApi, type PlanEventDetail } from "@/lib/chat/plan";
import type { QuizAttemptResult } from "@/lib/chat/types";
import { parsePartialWidgetJson, parseWidgetJson } from "@/lib/chat/widgetJson";
import type { TranslatePhrase } from "@/lib/i18n";
import { useI18n } from "@/components/LanguageProvider";
import styles from "./LearningWidget.module.css";
import { MathText } from "./math";
import { CircuitNetlistWidget } from "./widgets/CircuitNetlistWidget";
import { GapCard } from "./widgets/GapCard";
import { ImageAnnotatorWidget } from "./widgets/ImageAnnotatorWidget";
import { MEMORY_CHANGED_EVENT } from "./widgets/memoryContext";
import { WIDGET_ASK_EVENT, askInComposer, useWidgetScope } from "./widgets/widgetEvents";
import { ProblemSourceBadge, type ProblemSource } from "./widgets/ProblemSourceBadge";
import { WidgetSkeleton } from "./widgets/WidgetSkeleton";

function CodeEditorLoading() {
  const { tx } = useI18n();
  return <div className={styles.skeletonCard} role="status">{tx("正在加载代码编辑器…")}</div>;
}

const CodePlaygroundWidget = dynamic(
  () => import("./widgets/CodePlaygroundWidget").then((m) => m.CodePlaygroundWidget),
  { ssr: false, loading: () => <CodeEditorLoading /> },
);

export { WIDGET_ASK_EVENT };

/** True while the message holding the widget is still being written. Markdown provides it. */
export const WidgetLiveContext = createContext(false);

const emitWidgetQuestion = askInComposer;

interface StepStateItem {
  key: string;
  value: string;
  highlight?: boolean;
}

interface SimulatorStep {
  label: string;
  detail: string;
  state?: StepStateItem[];
}

interface CompareRow {
  dimension: string;
  values: string[];
  takeaway?: string;
}

/** Types that can be previewed while streaming, with the least data that makes the preview worth showing. */
const PREVIEWABLE: Record<string, (data: Record<string, unknown>) => boolean> = {
  step_simulator: (data) => Array.isArray(data.steps) && data.steps.length > 0,
  comparison_matrix: (data) =>
    Array.isArray(data.columns) && data.columns.length > 0 && Array.isArray(data.rows) && data.rows.length > 0,
  micro_quiz: (data) => Boolean(data.question) && Array.isArray(data.options) && data.options.length > 0,
};

function renderWidget(type: string, data: Record<string, unknown>) {
  if (type === "step_simulator") return <StepSimulatorWidget data={data} />;
  if (type === "comparison_matrix") return <ComparisonMatrixWidget data={data} />;
  if (type === "micro_quiz") return <MicroQuizWidget data={data} />;
  if (type === "code_playground") return <CodePlaygroundWidget data={data} />;
  if (type === "image_annotator") return <ImageAnnotatorWidget data={data} />;
  if (type === "circuit_netlist") return <CircuitNetlistWidget data={data} />;
  if (type === "gap") return <GapCard data={data} />;
  return null;
}

const KNOWN_TYPES = new Set([
  "step_simulator", "comparison_matrix", "micro_quiz", "code_playground", "image_annotator", "circuit_netlist", "gap",
]);

/** 完成播报里的标题：优先用卡片自带的 title，再按类型回退到卡片名。 */
function widgetTitle(type: string, data: Record<string, unknown>, tx: TranslatePhrase): string {
  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (title) return title;
  if (type === "step_simulator") return tx("过程步进推演");
  if (type === "comparison_matrix") return tx("核心差异对比");
  if (type === "micro_quiz") return tx("随堂即时自测");
  if (type === "code_playground") return tx("编程代码实验台");
  if (type === "image_annotator") return tx("图片批注");
  if (type === "circuit_netlist") return tx("电路拓扑确认");
  return tx("卡片");
}

/** 完成播报前确认卡片真的有内容可画：step/comparison 缺数据时会渲染成 null。 */
function widgetHasContent(type: string, data: Record<string, unknown>): boolean {
  if (type === "step_simulator") return Array.isArray(data.steps) && data.steps.length > 0;
  if (type === "comparison_matrix") {
    return Array.isArray(data.columns) && data.columns.length > 0
      && Array.isArray(data.rows) && data.rows.length > 0;
  }
  return true;
}

/** 只在卡片从生成中变为可用时播报一次；静态卡片挂载时不播报。 */
function useCompletionAnnouncement(live: boolean, ready: boolean, title: string) {
  const { tx } = useI18n();
  const [message, setMessage] = useState("");
  const wasGenerating = useRef(false);
  const announced = useRef(false);

  useEffect(() => {
    if (live) {
      wasGenerating.current = true;
      return;
    }
    if (!ready || !wasGenerating.current || announced.current) return;
    announced.current = true;
    setMessage(tx("卡片已生成：{title}", { title }));
  }, [live, ready, title, tx]);

  return message;
}

export function LearningWidget({ rawCode }: { rawCode: string }) {
  const { tx } = useI18n();
  const live = useContext(WidgetLiveContext);
  const parsed = useMemo(() => parseWidgetJson(rawCode), [rawCode]);
  const partial = useMemo(() => (!parsed && live ? parsePartialWidgetJson(rawCode) : null), [parsed, live, rawCode]);

  const previewType = String(partial?.type || "");
  const previewing = Boolean(partial && PREVIEWABLE[previewType]?.(partial));
  const data = parsed ?? (previewing ? partial : null);
  const type = String(data?.type || "");
  const renderable = Boolean(data) && KNOWN_TYPES.has(type);
  // 已知类型也可能因为数据不足渲染成 null，这时不播报「已生成」
  const announceable = data !== null && renderable && widgetHasContent(type, data);
  const title = data && announceable ? widgetTitle(type, data, tx) : "";
  const announcement = useCompletionAnnouncement(live, announceable, title);

  let content: ReactNode;
  if (data) {
    content = renderable ? (
      // 预览和完成后是同一棵树，卡片不会因为 JSON 收尾而重新挂载；
      // inert 让半成品不能点，避免对着还没写完的选项作答。
      <div
        className={previewing ? styles.liveWrap : undefined}
        aria-busy={live || undefined}
        inert={previewing}
      >
        {renderWidget(type, data)}
      </div>
    ) : (
      <WidgetFailure rawCode={rawCode} reason={tx("这种卡片已不再支持")} />
    );
  } else if (live) {
    // 生成中且预览不可用时，用 partial 里已经解析出的 type 画出对应骨架
    content = <WidgetSkeleton type={previewType} />;
  } else {
    content = <WidgetFailure rawCode={rawCode} reason={tx("这张卡片没能生成")} />;
  }

  return (
    <>
      {/* 状态区域先挂载、等生成结束后再写入文本，读屏只会播报一次结果 */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      {content}
    </>
  );
}

function WidgetFailure({ rawCode, reason }: { rawCode: string; reason: string }) {
  const { tx } = useI18n();
  return (
    <details className={styles.failCard}>
      <summary>
        <CircleAlert size={13} aria-hidden />
        <span>{reason}</span>
        <span>· {tx("查看原文")}</span>
      </summary>
      <pre>{rawCode}</pre>
    </details>
  );
}

function StepSimulatorWidget({ data }: { data: Record<string, unknown> }) {
  const { tx } = useI18n();
  const scope = useWidgetScope();
  const title = String(data.title || tx("过程步进推演"));
  const steps = Array.isArray(data.steps) ? (data.steps as SimulatorStep[]) : [];
  const [index, setIndex] = useState(0);

  if (steps.length === 0) return null;
  const safeIdx = Math.min(index, steps.length - 1);
  const current = steps[safeIdx];
  const stateItems = Array.isArray(current?.state) ? current.state : [];

  return (
    <section
      className={styles.widgetCard}
      aria-label={title}
      onKeyDown={(event) => {
        // 焦点在卡片内时左右方向键切步骤；输入框和组合键留给控件自己处理
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select, [contenteditable='true']")) return;
        if (event.key === "ArrowLeft" && safeIdx > 0) {
          event.preventDefault();
          setIndex((value) => Math.max(0, value - 1));
        } else if (event.key === "ArrowRight" && safeIdx < steps.length - 1) {
          event.preventDefault();
          setIndex((value) => Math.min(steps.length - 1, value + 1));
        }
      }}
    >
      <header className={styles.widgetHead}>
        <div className={styles.widgetTitleWrap}>
          <strong className={styles.widgetTitle}><MathText text={title} /></strong>
        </div>
        <span className={styles.stepCounter}>
          {tx("步骤 {current} / {total}", { current: safeIdx + 1, total: steps.length })}
        </span>
      </header>

      {stateItems.length > 0 && (
        <div className={styles.stateGrid}>
          {stateItems.map((item, i) => (
            <div key={`${item.key}-${i}`} className={cx(styles.stateCell, item.highlight && styles.stateCellActive)}>
              <span className={styles.stateKey}>{item.key}</span>
              <code className={styles.stateVal}>{String(item.value)}</code>
            </div>
          ))}
        </div>
      )}

      <div className={styles.stepBody}>
        <p className={styles.stepLabel}><MathText text={String(current?.label ?? "")} /></p>
        <p className={styles.stepDetail}><MathText text={String(current?.detail ?? "")} /></p>
      </div>

      <footer className={styles.widgetFoot}>
        <div className={styles.stepControls}>
          <button
            type="button"
            className={styles.ctrlBtn}
            disabled={safeIdx === 0}
            onClick={() => setIndex((v) => Math.max(0, v - 1))}
          >
            <ChevronLeft size={14} aria-hidden />
            <span>{tx("上一步")}</span>
          </button>
          <div className={styles.stepDots} role="tablist" aria-label={tx("步骤切换")}>
            {steps.map((s, idx) => (
              <button
                key={`${s.label}-${idx}`}
                type="button"
                role="tab"
                aria-selected={idx === safeIdx}
                className={cx(styles.stepDot, idx === safeIdx && styles.stepDotOn)}
                onClick={() => setIndex(idx)}
                title={tx("第 {index} 步：{label}", { index: idx + 1, label: s.label })}
              />
            ))}
          </div>
          <button
            type="button"
            className={styles.ctrlBtn}
            disabled={safeIdx >= steps.length - 1}
            onClick={() => setIndex((v) => Math.min(steps.length - 1, v + 1))}
          >
            <span>{tx("下一步")}</span>
            <ChevronRight size={14} aria-hidden />
          </button>
        </div>

        <button
          type="button"
          className={styles.textAction}
          onClick={() =>
            emitWidgetQuestion(
              scope,
              tx("在「{title}」的第 {step} 步（{label}）中，为什么会是这个状态？请帮我再展开讲讲。", {
                title,
                step: safeIdx + 1,
                label: current?.label ?? "",
              }),
            )
          }
        >
          <MessageSquarePlus size={12} aria-hidden />
          <span>{tx("追问第 {step} 步", { step: safeIdx + 1 })}</span>
        </button>
      </footer>
    </section>
  );
}

function ComparisonMatrixWidget({ data }: { data: Record<string, unknown> }) {
  const { tx, lang } = useI18n();
  const scope = useWidgetScope();
  const title = String(data.title || tx("核心差异对比"));
  const columns = Array.isArray(data.columns) ? data.columns.map(String) : [];
  const rows = Array.isArray(data.rows) ? (data.rows as CompareRow[]) : [];
  const [activeDim, setActiveDim] = useState<string>("all");

  if (columns.length === 0 || rows.length === 0) return null;
  const shownRows = activeDim === "all" ? rows : rows.filter((r) => r.dimension === activeDim);
  // 「全部维度」下也要看得到模型写的要点：多行时在每条前面带上维度名
  const takeaways = shownRows.filter((row) => row.takeaway);

  return (
    <section className={styles.widgetCard} aria-label={title}>
      <header className={styles.widgetHead}>
        <div className={styles.widgetTitleWrap}>
          <strong className={styles.widgetTitle}><MathText text={title} /></strong>
        </div>
      </header>

      <div className={styles.dimFilterRow} role="group" aria-label={tx("聚焦维度")}>
        <button
          type="button"
          aria-pressed={activeDim === "all"}
          className={cx(styles.dimPill, activeDim === "all" && styles.dimPillOn)}
          onClick={() => setActiveDim("all")}
        >
          {tx("全部维度")}
        </button>
        {rows.map((r) => (
          <button
            key={r.dimension}
            type="button"
            aria-pressed={activeDim === r.dimension}
            className={cx(styles.dimPill, activeDim === r.dimension && styles.dimPillOn)}
            onClick={() => setActiveDim(activeDim === r.dimension ? "all" : r.dimension)}
          >
            {r.dimension}
          </button>
        ))}
      </div>

      {/* 容器窄时（支线面板）样式把每个维度堆成一块，列名由 data-label 带出；role 保证改成块级后仍是表格语义 */}
      <div className={styles.matrixScroll}>
        <table className={styles.matrixTable} role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader">{tx("对比维度")}</th>
              {columns.map((col) => (
                <th key={col} role="columnheader"><MathText text={col} /></th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {shownRows.map((row) => (
              <tr key={row.dimension} role="row">
                <td role="rowheader" className={styles.dimCell}><MathText text={row.dimension} /></td>
                {columns.map((col, idx) => (
                  <td key={`${row.dimension}-${col}`} role="cell" data-label={col.replace(/[`*$]/g, "")}>
                    <MathText text={String(row.values?.[idx] ?? "—")} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {takeaways.length > 0 && (
        <div className={styles.matrixTakeaway}>
          <Lightbulb size={14} className={styles.takeawayIcon} aria-hidden />
          <div className={styles.takeawayList}>
            {takeaways.map((row) => (
              <div key={row.dimension}>
                {shownRows.length > 1 && <strong><MathText text={row.dimension} />{lang === "en" ? ": " : "："}</strong>}
                <MathText text={String(row.takeaway)} />
              </div>
            ))}
          </div>
        </div>
      )}

      <footer className={styles.widgetFoot}>
        <span className={styles.footHint}>{tx("点击上方维度胶囊可单独聚焦对比")}</span>
        <button
          type="button"
          className={styles.askAiBtn}
          onClick={() =>
            emitWidgetQuestion(
              scope,
              tx("关于「{title}」中的「{dimension}」，能给我举一个最容易混淆的具体例子吗？", {
                title,
                dimension: activeDim === "all" ? rows[0]?.dimension ?? "" : activeDim,
              }),
            )
          }
        >
          <MessageSquarePlus size={12} aria-hidden />
          <span>{tx("举例辨析")}</span>
        </button>
      </footer>
    </section>
  );
}

function MicroQuizWidget({ data }: { data: Record<string, unknown> }) {
  const { tx } = useI18n();
  const scope = useWidgetScope();
  const live = useContext(WidgetLiveContext);
  const question = String(data.question || "");
  const options = Array.isArray(data.options) ? data.options.map(String) : [];
  // 封存过的题带 quizId、不带答案，由服务端判分；没有 quizId 的旧消息仍按本地答案判
  const quizId = typeof data.quizId === "string" ? data.quizId : null;
  // problem_drill 出的题带服务端核对过的 meta.source；其他技能的普通微测没有 meta，不显示标签
  const meta = data.meta && typeof data.meta === "object" ? (data.meta as Record<string, unknown>) : null;
  const source = meta?.source && typeof meta.source === "object" ? (meta.source as ProblemSource) : null;
  // 先选再提交：选中只是草稿，提交后才揭晓答案、锁定选项
  const [selected, setSelected] = useState<number | null>(null);
  const [localAnswered, setLocalAnswered] = useState(false);
  const [ownResult, setOwnResult] = useState<QuizAttemptResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  // 网络重试沿用同一个 actionId，服务端据此去重；换了选项就换新的
  const actionId = useRef<string | null>(null);
  const restored = useSyncExternalStore(
    subscribeQuizAttempts,
    () => (quizId ? cachedQuizAttempt(scope, quizId) : null),
    () => null,
  );
  useEffect(() => {
    if (quizId && scope) void loadQuizAttempts(scope);
  }, [quizId, scope]);

  // 刚提交且服务端写入了记忆/推进了计划：通知外层刷新记忆列表和计划条（刷新恢复的结果不带变化，不会重复触发）
  const freshResult = ownResult && (ownResult.memoryChanges.length > 0 || ownResult.planStep) ? ownResult : null;
  useEffect(() => {
    if (!freshResult) return;
    if (freshResult.memoryChanges.length > 0) window.dispatchEvent(new Event(MEMORY_CHANGED_EVENT));
    if (freshResult.planStep && scope) {
      void planApi.get(scope)
        .then((plan) => window.dispatchEvent(new CustomEvent<PlanEventDetail>(PLAN_EVENT, { detail: { conversationId: scope, plan } })))
        .catch(() => { /* 计划条下次加载时会自行同步 */ });
    }
  }, [freshResult, scope]);

  if (!question || options.length === 0) return null;
  // 回复还在生成、题目还没封存：服务端核验前不能作答
  const validating = !quizId && live;
  const attempt = quizId ? restored ?? ownResult : null;
  const answered = quizId ? Boolean(attempt) : localAnswered;
  const chosen = attempt ? attempt.optionIndex : selected;
  const answerIndex = attempt ? attempt.answerIndex : typeof data.answerIndex === "number" ? data.answerIndex : 0;
  const explanation = attempt ? attempt.explanation : String(data.explanation || "");
  const isCorrect = answered && chosen === answerIndex;

  const pick = (idx: number) => {
    if (idx !== selected) actionId.current = null;
    setSelected(idx);
    setSubmitError(false);
  };
  const submit = async () => {
    if (selected === null) return;
    if (!quizId) {
      setLocalAnswered(true);
      return;
    }
    actionId.current ??= crypto.randomUUID();
    setSubmitting(true);
    setSubmitError(false);
    try {
      setOwnResult(await submitQuizAttempt(scope, quizId, actionId.current, selected));
    } catch {
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={styles.widgetCard} aria-label={tx("随堂即时自测")}>
      <header className={styles.quizHead}>
        <div className={styles.quizQuestion}>
          <MathText text={question} />
        </div>
        <div className={styles.quizHintRow}>
          {!answered && <span className={styles.quizHint}>{validating ? tx("正在校验题目…") : tx("请选择一个答案")}</span>}
          {source && (
            <ProblemSourceBadge
              source={source}
              patternId={typeof meta?.pattern_id === "string" ? meta.pattern_id : null}
              knowledgePoint={typeof meta?.knowledge_point === "string" ? meta.knowledge_point : null}
              fingerprint={typeof meta?.fingerprint === "string" ? meta.fingerprint : null}
            />
          )}
        </div>
      </header>

      <div className={styles.quizOptions} role="radiogroup" aria-label={question}>
        {options.map((opt, idx) => {
          const picked = chosen === idx;
          const rightOption = answered && idx === answerIndex;
          const wrongPicked = answered && picked && !isCorrect;
          return (
            <button
              key={`${idx}-${opt}`}
              type="button"
              role="radio"
              aria-checked={picked}
              disabled={answered || validating || submitting}
              className={cx(
                styles.quizOptionBtn,
                picked && !answered && styles.quizOptionPicked,
                rightOption && styles.quizOptionRight,
                wrongPicked && styles.quizOptionWrong,
              )}
              onClick={() => pick(idx)}
            >
              <span className={styles.quizOptionLetter}>{String.fromCharCode(65 + idx)}</span>
              <span className={styles.quizOptionText}>
                <MathText text={opt} />
              </span>
              {rightOption ? (
                <CheckCircle2 size={18} className={styles.iconRight} aria-hidden />
              ) : wrongPicked ? (
                <CircleAlert size={18} className={styles.iconWrong} aria-hidden />
              ) : (
                <span className={cx(styles.quizRadio, picked && styles.quizRadioOn)} aria-hidden />
              )}
            </button>
          );
        })}
      </div>

      {!answered && (
        <button
          type="button"
          className={styles.quizSubmit}
          disabled={selected === null || validating || submitting}
          aria-busy={submitting || undefined}
          onClick={() => void submit()}
        >
          <span>{submitting ? tx("正在提交…") : submitError ? tx("提交失败，点此重试") : tx("提交答案")}</span>
          {submitting ? <LoaderCircle size={14} className={styles.spin} aria-hidden /> : <ArrowRight size={14} aria-hidden />}
        </button>
      )}

      {answered && chosen !== null && (
        <div className={cx(styles.quizFeedback, isCorrect ? styles.feedbackRight : styles.feedbackWrong)}>
          <strong>{isCorrect ? tx("回答正确！") : tx("这道题选 {letter}", { letter: String.fromCharCode(65 + answerIndex) })}</strong>
          {explanation && (
            <p>
              <MathText text={explanation} />
            </p>
          )}
          {freshResult?.memoryChanges.map((change) => (
            <p key={change.memory.id}>{tx("已记入学习记录：{topic}", { topic: change.memory.topic })}</p>
          ))}
          {freshResult?.planStep && <p>{tx("学习计划「{title}」已完成", { title: freshResult.planStep.title })}</p>}
          <div className={styles.quizFeedbackFoot}>
            <button
              type="button"
              className={styles.askAiBtn}
              onClick={() =>
                emitWidgetQuestion(
                  scope,
                  tx("针对刚才这道题「{question}」，我选了「{option}」，{followUp}", {
                    question,
                    option: options[chosen],
                    followUp: isCorrect ? tx("请再考我一道稍微进阶一点的变式题！") : tx("我对这个选项为什么不对还有点疑问，能再讲讲吗？"),
                  }),
                )
              }
            >
              <MessageSquarePlus size={12} aria-hidden />
              <span>{isCorrect ? tx("再来一道进阶变式") : tx("请 AI 详解我的错因")}</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

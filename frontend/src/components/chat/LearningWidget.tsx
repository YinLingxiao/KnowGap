"use client";

import dynamic from "next/dynamic";
import { Component, createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, CircleHelp, Code2, Columns3,
  Lightbulb, LoaderCircle, MessageSquarePlus, Pause, Play, RotateCcw, Route, type LucideIcon,
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
  code_playground: (data) => typeof data.starter_code === "string" && data.starter_code.trim().length > 0,
};

function renderWidget(type: string, data: Record<string, unknown>, previewing = false) {
  if (type === "step_simulator") return <StepSimulatorWidget data={data} previewing={previewing} />;
  if (type === "comparison_matrix") return <ComparisonMatrixWidget data={data} />;
  if (type === "micro_quiz") return <MicroQuizWidget data={data} />;
  // 编辑器要等代码写完才挂载：生成中先把题目和代码按到达顺序显示出来
  if (type === "code_playground" && previewing) return <CodePlaygroundPreview data={data} />;
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
        {renderWidget(type, data, previewing)}
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
      <WidgetRenderBoundary rawCode={rawCode} resetKey={live ? "streaming" : rawCode}
        reason={tx("这张卡片暂时无法显示，已保留原文")}>
        {content}
      </WidgetRenderBoundary>
    </>
  );
}

// A malformed or unfinished model card must not take down the conversation.
// Retry once streaming finishes; do not repeatedly throw for every incoming token.
class WidgetRenderBoundary extends Component<{
  rawCode: string; resetKey: string; reason: string; children: ReactNode;
}, { failed: boolean; resetKey: string }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() { return { failed: true }; }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { resetKey: string }) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  render() {
    return this.state.failed
      ? <WidgetFailure rawCode={this.props.rawCode} reason={this.props.reason} />
      : this.props.children;
  }
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

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 所有卡片共用的抬头：类型标识一行，标题和一句说明各一行。生成中的标记只在预览外层里显示。 */
function CardHead({ icon: Icon, kind, title, subtitle, aside }: {
  icon: LucideIcon; kind: string; title?: string; subtitle?: string; aside?: ReactNode;
}) {
  const { tx } = useI18n();
  return (
    <header className={styles.cardHead}>
      <div className={styles.cardKind}>
        <span className={styles.kindIcon} aria-hidden><Icon size={13} /></span>
        <span>{kind}</span>
        <span className={styles.liveTag}><span className={styles.liveDot} aria-hidden />{tx("生成中")}</span>
        {aside && <span className={styles.cardAside}>{aside}</span>}
      </div>
      {title && <strong className={styles.widgetTitle}><MathText text={title} /></strong>}
      {subtitle && <p className={styles.cardSubtitle}><MathText text={subtitle} /></p>}
    </header>
  );
}

/** 自动播放时每一步停留的时间：够读完一句 detail，又不至于干等。 */
const AUTOPLAY_STEP_MS = 1600;

function subscribeMotionPreference(onChange: () => void) {
  const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  // 应用里的「界面动效」开关改的是 <html data-motion>，系统媒体查询监听不到，要单独盯这个属性
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  query?.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    query?.removeEventListener("change", onChange);
  };
}

function readMotionAllowed() {
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    && document.documentElement.dataset.motion !== "reduced";
}

/** 能不能放「自己会动」的东西（自动播放）。服务端渲染和水合的首帧一律答 false，挂载后才读环境，
    这样减弱动效的人连一帧都看不到播放键，服务端和客户端的首帧也一致。 */
function useMotionAllowed() {
  return useSyncExternalStore(subscribeMotionPreference, readMotionAllowed, () => false);
}

function StepSimulatorWidget({ data, previewing = false }: { data: Record<string, unknown>; previewing?: boolean }) {
  const { tx } = useI18n();
  const scope = useWidgetScope();
  const title = String(data.title || tx("过程步进推演"));
  const steps = Array.isArray(data.steps) ? (data.steps as SimulatorStep[]) : [];
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const motionAllowed = useMotionAllowed();
  const lastIdx = Math.max(steps.length - 1, 0);
  const safeIdx = Math.min(index, lastIdx);
  // 生成中的预览是 inert 的半成品，不能自己翻页；只有一步没什么可播的
  const canPlay = motionAllowed && !previewing && steps.length > 1;
  const running = playing && canPlay;

  // 条件不再满足（用户在设置里调成减弱动效、卡片又回到生成中）时把播放状态一并清掉，
  // 免得条件恢复后没人点播放它却自己动起来
  useEffect(() => {
    if (!canPlay) setPlaying(false);
  }, [canPlay]);

  // 每一步各自一个定时器而不是 setInterval：手动换步、步数变化、卸载时清掉就行，不会出现半截间隔
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      const next = Math.min(safeIdx + 1, lastIdx);
      setIndex(next);
      // 播到最后一步就停，不循环；想再看一遍由用户再点播放
      if (next >= lastIdx) setPlaying(false);
    }, AUTOPLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [running, safeIdx, lastIdx]);

  if (steps.length === 0) return null;
  const current = steps[safeIdx];
  const stateItems = Array.isArray(current?.state) ? current.state : [];
  // 和上一步同名的格子比：值变了就标出来并带上旧值，不依赖模型有没有写 highlight
  const previous = new Map<string, string>();
  const earlier = safeIdx > 0 ? steps[safeIdx - 1]?.state : null;
  if (Array.isArray(earlier)) for (const item of earlier) previous.set(String(item?.key), String(item?.value));

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
          setPlaying(false);
          setIndex((value) => Math.max(0, value - 1));
        } else if (event.key === "ArrowRight" && safeIdx < steps.length - 1) {
          event.preventDefault();
          setPlaying(false);
          setIndex((value) => Math.min(steps.length - 1, value + 1));
        }
      }}
    >
      <CardHead
        icon={Route}
        kind={tx("分步推演")}
        title={textField(data.title)}
        subtitle={textField(data.subtitle)}
        aside={tx("步骤 {current} / {total}", { current: safeIdx + 1, total: steps.length })}
      />

      {/* 进度轨：一步一段，走过的、当前的、没到的三种深浅；点哪段跳哪步 */}
      <div className={styles.stepRail} role="tablist" aria-label={tx("步骤切换")}>
        {steps.map((s, idx) => (
          <button
            key={idx}
            type="button"
            role="tab"
            aria-selected={idx === safeIdx}
            className={cx(styles.railSeg, idx < safeIdx && styles.railSegDone, idx === safeIdx && styles.railSegOn)}
            onClick={() => {
              setPlaying(false);
              setIndex(idx);
            }}
            title={tx("第 {index} 步：{label}", { index: idx + 1, label: s.label })}
          />
        ))}
      </div>

      {/* key 随步骤变：切步时这一块重新入场，读的人能看出内容换了 */}
      <div key={safeIdx} className={styles.stepStage}>
        <div className={styles.stepLine}>
          <span className={styles.stepNum} aria-hidden>{safeIdx + 1}</span>
          <div className={styles.stepText}>
            <p className={styles.stepLabel}><MathText text={String(current?.label ?? "")} /></p>
            <p className={styles.stepDetail}><MathText text={String(current?.detail ?? "")} /></p>
          </div>
        </div>

        {stateItems.length > 0 && (
          <div className={styles.stateGrid}>
            {stateItems.map((item, i) => {
              const before = previous.get(String(item.key));
              const changed = before !== undefined && before !== String(item.value);
              return (
                <div key={i} className={cx(styles.stateCell, (item.highlight || changed) && styles.stateCellActive)}>
                  <span className={styles.stateKey}>{item.key}</span>
                  <span className={styles.stateValRow}>
                    {changed && <s className={styles.statePrev}>{before}</s>}
                    <code className={styles.stateVal}>{String(item.value)}</code>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className={styles.widgetFoot}>
        <div className={styles.stepControls}>
          <button
            type="button"
            className={styles.ctrlBtn}
            disabled={safeIdx === 0}
            onClick={() => {
              setPlaying(false);
              setIndex((v) => Math.max(0, v - 1));
            }}
          >
            <ChevronLeft size={14} aria-hidden />
            <span>{tx("上一步")}</span>
          </button>
          <button
            type="button"
            className={cx(styles.ctrlBtn, styles.ctrlBtnPrimary)}
            disabled={safeIdx >= steps.length - 1}
            onClick={() => {
              setPlaying(false);
              setIndex((v) => Math.min(steps.length - 1, v + 1));
            }}
          >
            <span>{tx("下一步")}</span>
            <ChevronRight size={14} aria-hidden />
          </button>
          {canPlay && (
            <button
              type="button"
              className={styles.ctrlBtn}
              onClick={() => {
                if (running) {
                  setPlaying(false);
                  return;
                }
                // 在最后一步按播放：回到第一步重放，而不是点了没反应
                if (safeIdx >= lastIdx) setIndex(0);
                setPlaying(true);
              }}
            >
              {running ? <Pause size={13} aria-hidden /> : safeIdx >= lastIdx ? <RotateCcw size={13} aria-hidden /> : <Play size={13} aria-hidden />}
              <span>{running ? tx("暂停") : safeIdx >= lastIdx ? tx("重新播放") : tx("自动播放")}</span>
            </button>
          )}
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
  // The streaming parser can expose a just-opened row as {}. Wait for its label.
  const rows = Array.isArray(data.rows) ? data.rows.filter((row): row is CompareRow =>
    row !== null && typeof row === "object" && typeof row.dimension === "string" && row.dimension.trim().length > 0) : [];
  const [activeDim, setActiveDim] = useState<string>("all");
  // 聚焦的列号：和维度胶囊是两个独立的筛选，一个管行、一个管列
  const [focusCol, setFocusCol] = useState<number | null>(null);

  if (columns.length === 0 || rows.length === 0) return null;
  const shownRows = activeDim === "all" ? rows : rows.filter((r) => r.dimension === activeDim);
  const focus = focusCol !== null && focusCol < columns.length ? focusCol : null;
  // 「全部维度」下也要看得到模型写的要点：多行时在每条前面带上维度名
  const takeaways = shownRows.filter((row) => row.takeaway);
  const summary = textField(data.summary);

  return (
    <section className={styles.widgetCard} aria-label={title}>
      <CardHead icon={Columns3} kind={tx("概念对比")} title={textField(data.title)} subtitle={textField(data.subtitle)} />

      <div className={styles.dimFilterRow} role="group" aria-label={tx("聚焦维度")}>
        <button
          type="button"
          aria-pressed={activeDim === "all"}
          className={cx(styles.dimPill, activeDim === "all" && styles.dimPillOn)}
          onClick={() => setActiveDim("all")}
        >
          {tx("全部维度")}
        </button>
        {rows.map((r, idx) => (
          <button
            key={idx}
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
              {columns.map((col, idx) => (
                <th key={idx} role="columnheader" className={cx(styles.colHead, focus === idx && styles.colHeadOn)}>
                  {/* 窄堆叠时 thead 只留给读屏，里面的按钮能被 Tab 到却看不见，所以按钮和纯文本列名各放一份，
                      由 CSS 按布局二选一：宽表显示按钮，堆叠时按钮整个去掉（连同焦点和朗读）、只剩纯文本 */}
                  <button
                    type="button"
                    className={styles.colBtn}
                    aria-pressed={focus === idx}
                    title={tx("高亮这一列，再点一次取消")}
                    onClick={() => setFocusCol((value) => (value === idx ? null : idx))}
                  >
                    <MathText text={col} />
                  </button>
                  <span className={styles.colName}>{col.replace(/[`*$]/g, "")}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {shownRows.map((row, rowIdx) => (
              <tr key={rowIdx} role="row">
                <td role="rowheader" className={styles.dimCell}><MathText text={row.dimension} /></td>
                {columns.map((col, idx) => (
                  <td
                    key={idx}
                    role="cell"
                    data-label={col.replace(/[`*$]/g, "")}
                    className={cx(styles.colCell, focus === idx && styles.colOn, focus !== null && focus !== idx && styles.colDim)}
                  >
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
            {takeaways.map((row, idx) => (
              <div key={idx}>
                {shownRows.length > 1 && <strong><MathText text={row.dimension} />{lang === "en" ? ": " : "："}</strong>}
                <MathText text={String(row.takeaway)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {summary && (
        <p className={styles.matrixSummary}>
          <span className={styles.summaryTag}>{tx("结论")}</span>
          <span><MathText text={summary} /></span>
        </p>
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
  const [hintOpen, setHintOpen] = useState(false);
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
  // 揭晓动效只给「这次挂载里亲手提交」的答案：从缓存或服务端恢复的历史作答（刷新、回看）直接静态显示
  const animateReveal = answered && (quizId ? ownResult !== null : localAnswered);
  const topic = textField(data.topic);
  const difficulty = textField(data.difficulty);
  const hint = textField(data.hint);

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
      <CardHead
        icon={CircleHelp}
        kind={tx("随堂小测")}
        aside={(topic || difficulty) ? (
          <>
            {topic && <span className={styles.metaChip}>{topic}</span>}
            {difficulty && <span className={styles.metaChip}>{difficulty}</span>}
          </>
        ) : undefined}
      />
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
              key={idx}
              type="button"
              role="radio"
              aria-checked={picked}
              disabled={answered || validating || submitting}
              className={cx(
                styles.quizOptionBtn,
                picked && !answered && styles.quizOptionPicked,
                rightOption && styles.quizOptionRight,
                wrongPicked && styles.quizOptionWrong,
                wrongPicked && animateReveal && styles.quizOptionShake,
              )}
              onClick={() => pick(idx)}
            >
              <span className={styles.quizOptionLetter}>{String.fromCharCode(65 + idx)}</span>
              <span className={styles.quizOptionText}>
                <MathText text={opt} />
              </span>
              {rightOption ? (
                // 只有答对时对勾才弹出；答错时揭晓的正确选项是静态提示，动的只有选错的那一项
                <CheckCircle2 size={18} className={cx(styles.iconRight, isCorrect && animateReveal && styles.iconPop)} aria-hidden />
              ) : wrongPicked ? (
                <CircleAlert size={18} className={styles.iconWrong} aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 提示是模型写的可选字段：想自己先想的人不会被剧透，卡住了再点开 */}
      {!answered && hint && (hintOpen ? (
        <div className={styles.quizHintBox}>
          <Lightbulb size={14} className={styles.takeawayIcon} aria-hidden />
          <span><MathText text={hint} /></span>
        </div>
      ) : (
        <button type="button" className={cx(styles.textAction, styles.hintToggle)} disabled={validating} onClick={() => setHintOpen(true)}>
          <Lightbulb size={12} aria-hidden />
          <span>{tx("看提示")}</span>
        </button>
      ))}

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
          <strong className={styles.feedbackTitle}>
            {isCorrect
              ? <CheckCircle2 size={16} className={cx(styles.iconRight, animateReveal && styles.iconPop)} aria-hidden />
              : <CircleAlert size={16} className={styles.iconWrong} aria-hidden />}
            {isCorrect ? tx("回答正确！") : tx("这道题选 {letter}", { letter: String.fromCharCode(65 + answerIndex) })}
          </strong>
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

/** 代码实验台的流式预览：标题、任务说明和代码按到达顺序出现；写完后换成真正的编辑器。 */
function CodePlaygroundPreview({ data }: { data: Record<string, unknown> }) {
  const { tx } = useI18n();
  const language = textField(data.language);
  const instructions = textField(data.instructions);
  return (
    <section className={styles.widgetCard} aria-label={tx("编程代码实验台")}>
      <CardHead
        icon={Code2}
        kind={tx("代码实验台")}
        title={textField(data.title)}
        aside={language ? <span className={styles.metaChip}>{language}</span> : undefined}
      />
      {instructions && <p className={styles.cardSubtitle}><MathText text={instructions} /></p>}
      <pre className={styles.codePreview}><code>{String(data.starter_code ?? "")}</code><span className={styles.codeCaret} aria-hidden /></pre>
    </section>
  );
}

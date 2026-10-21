"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import {
  CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, HelpCircle,
  Layers, MessageSquarePlus, Sliders, Sparkles,
} from "lucide-react";
import { cx } from "@/lib/cx";
import { parseWidgetJson } from "@/lib/chat/widgetJson";
import styles from "./LearningWidget.module.css";
import { MathText } from "./math";
import { CircuitNetlistWidget } from "./widgets/CircuitNetlistWidget";
import { ImageAnnotatorWidget } from "./widgets/ImageAnnotatorWidget";
import { ProblemSourceBadge, type ProblemSource } from "./widgets/ProblemSourceBadge";
import { VivaRadarWidget } from "./widgets/VivaRadarWidget";

const CodePlaygroundWidget = dynamic(
  () => import("./widgets/CodePlaygroundWidget").then((m) => m.CodePlaygroundWidget),
  { ssr: false, loading: () => <div className={styles.skeletonCard} role="status">正在加载代码编辑器…</div> },
);

export const WIDGET_ASK_EVENT = "knowgap:widget-ask";

function emitWidgetQuestion(prompt: string) {
  window.dispatchEvent(new CustomEvent<string>(WIDGET_ASK_EVENT, { detail: prompt }));
}

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

interface LabParam {
  id: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  default: number;
  unit?: string;
}

export function LearningWidget({ rawCode }: { rawCode: string }) {
  const parsed = useMemo(() => parseWidgetJson(rawCode), [rawCode]);

  if (!parsed) {
    return (
      <div className={styles.skeletonCard} role="status">
        <Sparkles size={14} className={styles.skeletonIcon} aria-hidden />
        <span>正在流式构建可交互学习微件…</span>
      </div>
    );
  }

  const type = String(parsed.type || "");
  if (type === "step_simulator") {
    return <StepSimulatorWidget data={parsed} />;
  }
  if (type === "comparison_matrix") {
    return <ComparisonMatrixWidget data={parsed} />;
  }
  if (type === "parameter_lab") {
    return <ParameterLabWidget data={parsed} />;
  }
  if (type === "micro_quiz") {
    return <MicroQuizWidget data={parsed} />;
  }
  if (type === "code_playground") {
    return <CodePlaygroundWidget data={parsed} />;
  }
  if (type === "image_annotator") {
    return <ImageAnnotatorWidget data={parsed} />;
  }
  if (type === "circuit_netlist") {
    return <CircuitNetlistWidget data={parsed} />;
  }
  if (type === "viva_radar") {
    return <VivaRadarWidget data={parsed} />;
  }

  return null;
}

function StepSimulatorWidget({ data }: { data: Record<string, unknown> }) {
  const title = String(data.title || "过程步进推演");
  const steps = Array.isArray(data.steps) ? (data.steps as SimulatorStep[]) : [];
  const [index, setIndex] = useState(0);

  if (steps.length === 0) return null;
  const safeIdx = Math.min(index, steps.length - 1);
  const current = steps[safeIdx];
  const stateItems = Array.isArray(current?.state) ? current.state : [];

  return (
    <section className={styles.widgetCard} aria-label={title}>
      <header className={styles.widgetHead}>
        <div className={styles.widgetTitleWrap}>
          <span className={styles.widgetBadge}>
            <Layers size={12} aria-hidden />
            交互推演
          </span>
          <strong className={styles.widgetTitle}>{title}</strong>
        </div>
        <span className={styles.stepCounter}>
          步骤 {safeIdx + 1} / {steps.length}
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
        <p className={styles.stepLabel}>{current?.label}</p>
        <p className={styles.stepDetail}>{current?.detail}</p>
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
            <span>上一步</span>
          </button>
          <div className={styles.stepDots} role="tablist" aria-label="步骤切换">
            {steps.map((s, idx) => (
              <button
                key={`${s.label}-${idx}`}
                type="button"
                role="tab"
                aria-selected={idx === safeIdx}
                className={cx(styles.stepDot, idx === safeIdx && styles.stepDotOn)}
                onClick={() => setIndex(idx)}
                title={`第 ${idx + 1} 步：${s.label}`}
              />
            ))}
          </div>
          <button
            type="button"
            className={styles.ctrlBtn}
            disabled={safeIdx >= steps.length - 1}
            onClick={() => setIndex((v) => Math.min(steps.length - 1, v + 1))}
          >
            <span>下一步</span>
            <ChevronRight size={14} aria-hidden />
          </button>
        </div>

        <button
          type="button"
          className={styles.askAiBtn}
          onClick={() =>
            emitWidgetQuestion(
              `在「${title}」的第 ${safeIdx + 1} 步（${current?.label}）中，为什么会是这个状态？请帮我再展开讲讲。`,
            )
          }
        >
          <MessageSquarePlus size={12} aria-hidden />
          <span>追问第 {safeIdx + 1} 步</span>
        </button>
      </footer>
    </section>
  );
}

function ComparisonMatrixWidget({ data }: { data: Record<string, unknown> }) {
  const title = String(data.title || "核心差异对比");
  const columns = Array.isArray(data.columns) ? data.columns.map(String) : [];
  const rows = Array.isArray(data.rows) ? (data.rows as CompareRow[]) : [];
  const [activeDim, setActiveDim] = useState<string>("all");

  if (columns.length === 0 || rows.length === 0) return null;
  const shownRows = activeDim === "all" ? rows : rows.filter((r) => r.dimension === activeDim);

  return (
    <section className={styles.widgetCard} aria-label={title}>
      <header className={styles.widgetHead}>
        <div className={styles.widgetTitleWrap}>
          <span className={styles.widgetBadge}>
            <Sparkles size={12} aria-hidden />
            交互对比
          </span>
          <strong className={styles.widgetTitle}>{title}</strong>
        </div>
      </header>

      <div className={styles.dimFilterRow}>
        <button
          type="button"
          className={cx(styles.dimPill, activeDim === "all" && styles.dimPillOn)}
          onClick={() => setActiveDim("all")}
        >
          全部维度
        </button>
        {rows.map((r) => (
          <button
            key={r.dimension}
            type="button"
            className={cx(styles.dimPill, activeDim === r.dimension && styles.dimPillOn)}
            onClick={() => setActiveDim(activeDim === r.dimension ? "all" : r.dimension)}
          >
            {r.dimension}
          </button>
        ))}
      </div>

      <div className={styles.matrixScroll}>
        <table className={styles.matrixTable}>
          <thead>
            <tr>
              <th>对比维度</th>
              {columns.map((col) => (
                <th key={col}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((row) => (
              <tr key={row.dimension}>
                <td className={styles.dimCell}>{row.dimension}</td>
                {columns.map((col, idx) => (
                  <td key={`${row.dimension}-${col}`}>{row.values?.[idx] ?? "—"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shownRows.length === 1 && shownRows[0].takeaway && (
        <p className={styles.matrixTakeaway}>💡 {shownRows[0].takeaway}</p>
      )}

      <footer className={styles.widgetFoot}>
        <span className={styles.footHint}>点击上方维度胶囊可单独聚焦对比</span>
        <button
          type="button"
          className={styles.askAiBtn}
          onClick={() =>
            emitWidgetQuestion(
              `关于「${title}」中的「${activeDim === "all" ? rows[0]?.dimension : activeDim}」，能给我举一个最容易混淆的具体例子吗？`,
            )
          }
        >
          <MessageSquarePlus size={12} aria-hidden />
          <span>举例辨析</span>
        </button>
      </footer>
    </section>
  );
}

function ParameterLabWidget({ data }: { data: Record<string, unknown> }) {
  const title = String(data.title || "参数实验室");
  const formula = String(data.formula || "");
  const insight = String(data.insight || "");
  const params = useMemo(
    () => (Array.isArray(data.params) ? (data.params as LabParam[]) : []),
    [data.params],
  );
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(params.map((p) => [p.id, Number(p.default ?? p.min ?? 1)])),
  );

  if (params.length === 0) return null;

  return (
    <section className={styles.widgetCard} aria-label={title}>
      <header className={styles.widgetHead}>
        <div className={styles.widgetTitleWrap}>
          <span className={styles.widgetBadge}>
            <Sliders size={12} aria-hidden />
            参数实验
          </span>
          <strong className={styles.widgetTitle}>{title}</strong>
        </div>
        {formula && <code className={styles.formulaBadge}>{formula}</code>}
      </header>

      <div className={styles.labGrid}>
        {params.map((p) => {
          const val = values[p.id] ?? p.default ?? p.min;
          const min = Number(p.min ?? 0);
          const max = Number(p.max ?? 100);
          const ratio = max > min ? Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100)) : 50;
          return (
            <label key={p.id} className={styles.sliderRow}>
              <div className={styles.sliderHeader}>
                <span>{p.label}</span>
                <strong>
                  {val}
                  {p.unit ?? ""}
                </strong>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={p.step ?? 1}
                value={val}
                onChange={(e) => setValues((old) => ({ ...old, [p.id]: Number(e.target.value) }))}
              />
              <div className={styles.barMeter}>
                <span style={{ width: `${ratio}%` }} />
              </div>
            </label>
          );
        })}
      </div>

      {insight && <p className={styles.matrixTakeaway}>💡 {insight}</p>}

      <footer className={styles.widgetFoot}>
        <span className={styles.footHint}>拖动滑块调整参数，或将当前参数发送给 AI 推演</span>
        <button
          type="button"
          className={styles.askAiBtn}
          onClick={() => {
            const summary = params.map((p) => `${p.label}=${values[p.id] ?? p.default}${p.unit ?? ""}`).join("，");
            emitWidgetQuestion(`当「${title}」的参数设定为（${summary}）时，结果会怎样变化？请帮我分析一下。`);
          }}
        >
          <MessageSquarePlus size={12} aria-hidden />
          <span>以此参数请 AI 分析</span>
        </button>
      </footer>
    </section>
  );
}

function MicroQuizWidget({ data }: { data: Record<string, unknown> }) {
  const question = String(data.question || "");
  const options = Array.isArray(data.options) ? data.options.map(String) : [];
  const answerIndex = typeof data.answerIndex === "number" ? data.answerIndex : 0;
  const explanation = String(data.explanation || "");
  // problem_drill 出的题带服务端核对过的 meta.source；其他技能的普通微测没有 meta，不显示标签
  const meta = data.meta && typeof data.meta === "object" ? (data.meta as Record<string, unknown>) : null;
  const source = meta?.source && typeof meta.source === "object" ? (meta.source as ProblemSource) : null;
  const [selected, setSelected] = useState<number | null>(null);

  if (!question || options.length === 0) return null;
  const answered = selected !== null;
  const isCorrect = selected === answerIndex;

  return (
    <section className={styles.widgetCard} aria-label="随堂即时自测">
      <header className={styles.widgetHead}>
        <div className={styles.widgetTitleWrap}>
          <span className={styles.widgetBadge}>
            <HelpCircle size={12} aria-hidden />
            随堂微测
          </span>
          <strong className={styles.widgetTitle}>
            <MathText text={question} />
          </strong>
        </div>
        {source && (
          <ProblemSourceBadge
            source={source}
            patternId={typeof meta?.pattern_id === "string" ? meta.pattern_id : null}
            knowledgePoint={typeof meta?.knowledge_point === "string" ? meta.knowledge_point : null}
            fingerprint={typeof meta?.fingerprint === "string" ? meta.fingerprint : null}
          />
        )}
      </header>

      <div className={styles.quizOptions}>
        {options.map((opt, idx) => {
          const picked = selected === idx;
          const rightOption = answered && idx === answerIndex;
          const wrongPicked = answered && picked && !isCorrect;
          return (
            <button
              key={`${idx}-${opt}`}
              type="button"
              className={cx(
                styles.quizOptionBtn,
                rightOption && styles.quizOptionRight,
                wrongPicked && styles.quizOptionWrong,
              )}
              onClick={() => setSelected(idx)}
            >
              <span className={styles.quizOptionLetter}>{String.fromCharCode(65 + idx)}</span>
              <span className={styles.quizOptionText}>
                <MathText text={opt} />
              </span>
              {rightOption && <CheckCircle2 size={15} className={styles.iconRight} aria-hidden />}
              {wrongPicked && <CircleAlert size={15} className={styles.iconWrong} aria-hidden />}
            </button>
          );
        })}
      </div>

      {answered && (
        <div className={cx(styles.quizFeedback, isCorrect ? styles.feedbackRight : styles.feedbackWrong)}>
          <strong>{isCorrect ? "回答正确！" : `这道题选 ${String.fromCharCode(65 + answerIndex)}`}</strong>
          {explanation && (
            <p>
              <MathText text={explanation} />
            </p>
          )}
          <div className={styles.quizFeedbackFoot}>
            <button
              type="button"
              className={styles.askAiBtn}
              onClick={() =>
                emitWidgetQuestion(
                  `针对刚才这道题「${question}」，我选了「${options[selected]}」，${
                    isCorrect ? "请再考我一道稍微进阶一点的变式题！" : "我对这个选项为什么不对还有点疑问，能再讲讲吗？"
                  }`,
                )
              }
            >
              <MessageSquarePlus size={12} aria-hidden />
              <span>{isCorrect ? "再来一道进阶变式" : "请 AI 详解我的错因"}</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

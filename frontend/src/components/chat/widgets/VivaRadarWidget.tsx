"use client";

import { useMemo, useState } from "react";
import { Gauge, MessageSquarePlus, RotateCcw } from "lucide-react";
import { cx } from "@/lib/cx";
import base from "../LearningWidget.module.css";
import { askInComposer } from "./widgetEvents";
import styles from "./VivaRadarWidget.module.css";

/** 与后端 viva_skill.DIMENSIONS 顺序一致：雷达图从正上方顺时针排布。 */
const DIMENSIONS = [
  { key: "concept", label: "概念准确度" },
  { key: "boundary", label: "边界严密性" },
  { key: "derivation", label: "推导逻辑性" },
  { key: "transfer", label: "跨学科迁移力" },
  { key: "expression", label: "表达条理性" },
] as const;

interface VivaDimension {
  key: string;
  label: string;
  score: number | null;
  quote: string;
  reason: string;
}

// SVG 坐标系（viewBox）。标签需要左右留白，所以宽比高大。
const W = 360;
const H = 290;
const CX = W / 2;
const CY = 150;
const R = 98;
const RINGS = [0.2, 0.4, 0.6, 0.8, 1];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toScore(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : null;
}

/** 流式阶段拿到的是模型原文，服务端核对后会替换；这里按 key / label / 顺序宽松认领，缺失补位。 */
function parseDimensions(raw: unknown): VivaDimension[] {
  const items = Array.isArray(raw) ? raw.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  return DIMENSIONS.map((dim, index) => {
    const item =
      items.find((x) => x.key === dim.key) ??
      items.find((x) => text(x.label) === dim.label) ??
      (items.length === DIMENSIONS.length && !text(items[index]?.key) ? items[index] : undefined);
    return {
      key: dim.key,
      label: dim.label,
      score: item ? toScore(item.score) : null,
      quote: item ? text(item.quote) : "",
      reason: item ? text(item.reason) : "",
    };
  });
}

function point(index: number, ratio: number): [number, number] {
  const angle = ((index * 72 - 90) * Math.PI) / 180;
  return [CX + Math.cos(angle) * R * ratio, CY + Math.sin(angle) * R * ratio];
}

function polygon(ratios: number[]): string {
  return ratios.map((r, i) => point(i, r).map((v) => v.toFixed(1)).join(",")).join(" ");
}

function tier(score: number | null): string {
  if (score === null) return styles.tierNone;
  if (score >= 80) return styles.tierHigh;
  if (score >= 60) return styles.tierMid;
  return styles.tierLow;
}

export function VivaRadarWidget({ data }: { data: Record<string, unknown> }) {
  const title = text(data.title) || "模拟复试 · 五维评估";
  const topic = text(data.topic);
  const verdict = text(data.verdict);
  const suggestions = useMemo(
    () => (Array.isArray(data.suggestions) ? data.suggestions.map(text).filter(Boolean).slice(0, 3) : []),
    [data.suggestions],
  );
  const dims = useMemo(() => parseDimensions(data.dimensions), [data.dimensions]);
  const scored = dims.filter((d) => d.score !== null);
  const overall =
    toScore(data.overall) ??
    (scored.length ? Math.round(scored.reduce((sum, d) => sum + (d.score ?? 0), 0) / scored.length) : null);
  const weakest = scored.length
    ? scored.reduce((low, d) => ((d.score ?? 0) < (low.score ?? 0) ? d : low))
    : null;
  const [active, setActive] = useState<number | null>(null);

  if (scored.length === 0) return null;
  const focus = active === null ? null : dims[active];
  const [fx, fy] = active === null ? [0, 0] : point(active, (dims[active].score ?? 0) / 100);

  return (
    <section className={base.widgetCard} aria-label={title}>
      <header className={base.widgetHead}>
        <div className={base.widgetTitleWrap}>
          <span className={base.widgetBadge}>
            <Gauge size={12} aria-hidden />
            模拟复试
          </span>
          <strong className={base.widgetTitle}>{title}</strong>
          {topic && <span className={styles.topic}>{topic}</span>}
        </div>
        {overall !== null && (
          <span className={cx(styles.overall, tier(overall))} title="五个维度的平均分">
            综合 <strong>{overall}</strong>
          </span>
        )}
      </header>

      <div className={styles.chartWrap} onMouseLeave={() => setActive(null)}>
        <svg
          className={styles.chart}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`五维雷达图：${dims.map((d) => `${d.label} ${d.score ?? "未评估"}`).join("，")}`}
        >
          {RINGS.map((r) => (
            <polygon key={r} points={polygon(DIMENSIONS.map(() => r))} className={r === 1 ? styles.ringOuter : styles.ring} />
          ))}
          {DIMENSIONS.map((dim, i) => {
            const [x, y] = point(i, 1);
            return <line key={dim.key} x1={CX} y1={CY} x2={x} y2={y} className={styles.axis} />;
          })}
          {[60, 100].map((v) => {
            const [, y] = point(0, v / 100);
            return (
              <text key={v} x={CX + 4} y={y + 10} className={styles.ringLabel}>
                {v}
              </text>
            );
          })}
          <polygon points={polygon(dims.map((d) => (d.score ?? 0) / 100))} className={styles.area} />
          {dims.map((d, i) => {
            const [px, py] = point(i, (d.score ?? 0) / 100);
            const [lx, ly] = point(i, 1.2);
            const anchor = Math.abs(lx - CX) < 4 ? "middle" : lx > CX ? "start" : "end";
            const on = active === i;
            return (
              <g
                key={d.key}
                className={styles.handle}
                tabIndex={0}
                role="button"
                aria-label={`${d.label}：${d.score ?? "未评估"}${d.reason ? `，${d.reason}` : ""}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                onClick={() => setActive(on ? null : i)}
              >
                <text x={lx} y={ly - 2} textAnchor={anchor} className={cx(styles.axisLabel, on && styles.axisLabelOn)}>
                  {d.label}
                </text>
                <text x={lx} y={ly + 13} textAnchor={anchor} className={cx(styles.axisScore, tier(d.score))}>
                  {d.score ?? "—"}
                </text>
                <circle cx={px} cy={py} r={14} className={styles.hit} />
                <circle cx={px} cy={py} r={on ? 5 : 3.5} className={cx(styles.dot, on && styles.dotOn)} />
              </g>
            );
          })}
        </svg>

        {focus && (
          <div
            className={cx(styles.tip, fx < W * 0.3 ? styles.tipLeft : fx > W * 0.7 ? styles.tipRight : undefined)}
            style={{ left: `${(fx / W) * 100}%`, top: `${(fy / H) * 100}%` }}
            role="tooltip"
          >
            <div className={styles.tipHead}>
              <span>{focus.label}</span>
              <strong className={tier(focus.score)}>{focus.score ?? "未评估"}</strong>
            </div>
            {focus.quote && <q className={styles.quote}>{focus.quote}</q>}
            {focus.reason && <p className={styles.reason}>{focus.reason}</p>}
            {!focus.quote && !focus.reason && <p className={styles.reason}>该维度没有可引用的依据。</p>}
          </div>
        )}
      </div>

      <div className={styles.dimList} role="list" aria-label="五维得分与依据">
        {dims.map((d, i) => (
          <div
            key={d.key}
            role="listitem"
            className={cx(styles.dimRow, active === i && styles.dimRowOn)}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
          >
            <div className={styles.dimHead}>
              <span className={styles.dimLabel}>{d.label}</span>
              <span className={styles.bar} aria-hidden>
                <span className={tier(d.score)} style={{ width: `${d.score ?? 0}%` }} />
              </span>
              <strong className={cx(styles.dimScore, tier(d.score))}>{d.score ?? "—"}</strong>
            </div>
            {(d.quote || d.reason) && (
              <p className={styles.dimBody}>
                {d.quote && <q className={styles.quote}>{d.quote}</q>}
                {d.reason && <span>{d.reason}</span>}
              </p>
            )}
            {d.score === null && <p className={styles.dimBody}>本场回答未覆盖该维度，未评分。</p>}
          </div>
        ))}
      </div>

      {(verdict || suggestions.length > 0) && (
        <div className={styles.summary}>
          {verdict && (
            <p className={styles.verdict}>
              <span className={styles.summaryLabel}>面试官总评</span>
              {verdict}
            </p>
          )}
          {suggestions.length > 0 && (
            <div>
              <span className={styles.summaryLabel}>改进建议</span>
              <ul className={styles.suggestions}>
                {suggestions.map((s, i) => (
                  <li key={`${i}-${s}`}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <footer className={base.widgetFoot}>
        <span className={base.footHint}>悬停雷达图顶点查看评分依据</span>
        <div className={styles.actions}>
          <button
            type="button"
            className={base.askAiBtn}
            onClick={() => askInComposer(`再来一场模拟复试${topic ? `，这次换一个比「${topic}」更难的知识点` : ""}`)}
          >
            <RotateCcw size={12} aria-hidden />
            <span>再来一场</span>
          </button>
          {weakest && (
            <button
              type="button"
              className={base.askAiBtn}
              onClick={() =>
                askInComposer(
                  `刚才的复试里我最弱的是「${weakest.label}」（${weakest.score} 分）。请具体讲讲我该补什么，并给一个能马上练的例子。`,
                )
              }
            >
              <MessageSquarePlus size={12} aria-hidden />
              <span>补强{weakest.label}</span>
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

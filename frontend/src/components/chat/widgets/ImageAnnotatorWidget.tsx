"use client";

import { useMemo, useState } from "react";
import { ImageIcon, MessageSquarePlus } from "lucide-react";
import { cx } from "@/lib/cx";
import base from "../LearningWidget.module.css";
import { RouteBadge, useImageUrl } from "./VisionBits";
import { arrowBetween, ellipseOf, parseAnnotatorData } from "./visionData";
import { askInComposer } from "./widgetEvents";
import styles from "./VisionWidgets.module.css";

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export const annotationMarker = (index: number) => CIRCLED[index] ?? String(index + 1);

/**
 * image_annotator: lossless red-circle annotations over the student's original image.
 *
 * data: { title, summary?, image_id, width, height, annotations: [{ id, bbox: [ymin, xmin, ymax, xmax] (0-1000),
 *         shape: "ellipse" | "rect", note, color?, arrow_to? }], route? }
 * Legacy cards with imageUrl / aspectRatio / label are still accepted.
 */
export function ImageAnnotatorWidget({ data }: { data: Record<string, unknown> }) {
  const parsed = useMemo(() => parseAnnotatorData(data), [data]);
  const { title, summary, annotations, aspect, route } = parsed;
  const image = useImageUrl(parsed.imageId);
  const [active, setActive] = useState<number | null>(null);
  // Match the SVG viewBox to the source image's real proportions so circles stay round,
  // including very wide textbook screenshots.
  const viewHeight = 1000 / aspect;
  const scaleY = viewHeight / 1000;
  const shapes = useMemo(() => annotations.map((anno) => ellipseOf(anno.box, viewHeight)), [annotations, viewHeight]);
  const arrows = useMemo(
    () => annotations.map((anno, i) => (anno.arrowTo === null ? null : arrowBetween(shapes[i], shapes[anno.arrowTo]))),
    [annotations, shapes],
  );

  if (annotations.length === 0 && !parsed.imageId && !parsed.imageSrc) return null;
  const src = parsed.imageId ? image.url : parsed.imageSrc;
  const current = active === null ? null : annotations[active] ?? null;
  const toggle = (index: number) => setActive((previous) => (previous === index ? null : index));
  const stageHint = parsed.imageId && !image.url
    ? image.failed ? "原图无法加载，可能已被删除" : "原图加载中…"
    : src ? "" : "未提供图片，仅展示批注位置";
  const label = `${title}，共 ${annotations.length} 处批注`;

  return (
    <section className={base.widgetCard} aria-label={title}>
      <header className={base.widgetHead}>
        <div className={base.widgetTitleWrap}>
          <span className={base.widgetBadge}>
            <ImageIcon size={12} aria-hidden />
            图片批注
          </span>
          <strong className={base.widgetTitle}>{title}</strong>
        </div>
        <div className={styles.headMeta}>
          <RouteBadge route={route} />
          <span className={base.stepCounter}>{annotations.length ? `${annotations.length} 处批注` : "无批注"}</span>
        </div>
      </header>

      <div className={base.annoStage} style={{ aspectRatio: String(aspect) }}>
        <svg className={base.annoSvg} viewBox={`0 0 1000 ${viewHeight}`} preserveAspectRatio="none" role="img" aria-label={label}>
          {src ? (
            <image href={src} x={0} y={0} width={1000} height={viewHeight} preserveAspectRatio="none" />
          ) : (
            <rect x={0} y={0} width={1000} height={viewHeight} className={base.annoEmpty} />
          )}
          {annotations.map((anno, i) => {
            const on = active === i;
            const paint = {
              fill: on ? anno.color : "none",
              fillOpacity: 0.14,
              stroke: anno.color,
              strokeWidth: on ? 4 : 2.5,
              opacity: active === null || on ? 1 : 0.35,
              vectorEffect: "non-scaling-stroke",
            };
            const [ymin, xmin, ymax, xmax] = anno.box;
            return anno.shape === "rect" ? (
              <rect key={`shape-${i}`} x={xmin} y={ymin * scaleY} width={xmax - xmin} height={(ymax - ymin) * scaleY} rx={6} {...paint} />
            ) : (
              <ellipse key={`shape-${i}`} cx={shapes[i].cx} cy={shapes[i].cy} rx={shapes[i].rx} ry={shapes[i].ry} {...paint} />
            );
          })}
          {arrows.map((arrow, i) => arrow && (
            <g key={`arrow-${i}`} opacity={active === null || active === i ? 1 : 0.35}>
              <line x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2} stroke={annotations[i].color}
                strokeWidth={2.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              <polygon points={arrow.head} fill={annotations[i].color} />
            </g>
          ))}
        </svg>
        {stageHint && <span className={styles.stageHint}>{stageHint}</span>}
        {annotations.map((anno, i) => (
          <button
            key={`badge-${i}`}
            type="button"
            className={cx(base.annoBadge, active === i && base.annoBadgeOn)}
            style={{ left: `${anno.box[1] / 10}%`, top: `${anno.box[0] / 10}%`, background: anno.color }}
            aria-pressed={active === i}
            aria-label={`批注 ${i + 1}：${anno.text}`}
            onClick={() => toggle(i)}
          >
            {annotationMarker(i)}
          </button>
        ))}
      </div>

      {summary && <p className={base.matrixTakeaway}>{summary}</p>}

      {annotations.length > 0 ? (
        <ul className={base.annoList}>
          {annotations.map((anno, i) => (
            <li key={`item-${i}`}>
              <button
                type="button"
                className={cx(base.annoItem, active === i && base.annoItemOn)}
                aria-pressed={active === i}
                onClick={() => toggle(i)}
              >
                <span className={base.annoDot} style={{ background: anno.color }} aria-hidden>{annotationMarker(i)}</span>
                <span className={styles.annoText}>{anno.text}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={base.matrixTakeaway}>没有发现需要批注的地方。</p>
      )}

      {annotations.length > 0 && (
        <footer className={base.widgetFoot}>
          <span className={base.footHint}>点击图上的编号或下方列表高亮对应批注，再针对这一处追问</span>
          <button
            type="button"
            className={base.askAiBtn}
            disabled={!current}
            onClick={() => {
              if (!current || active === null) return;
              askInComposer(`关于「${title}」中的批注 ${annotationMarker(active)}：「${current.text}」，请结合图中这一处详细讲讲错在哪里、应该怎么改。`);
            }}
          >
            <MessageSquarePlus size={12} aria-hidden />
            <span>{current && active !== null ? `针对第 ${annotationMarker(active)} 处批注追问 AI` : "先选择一处批注"}</span>
          </button>
        </footer>
      )}
    </section>
  );
}

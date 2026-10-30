"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { toApiError } from "@/lib/api/errors";
import { conceptGraphApi, type ConceptGraphResult, type FogConcept } from "@/lib/chat/conceptGraph";
import { insightsApi, type InsightThread, type SubjectInsights } from "@/lib/chat/insights";
import { cx } from "@/lib/cx";
import { localeOf, type Language } from "@/lib/i18n";
import styles from "./ConceptGraph.module.css";

const VB = 860;
const CX = 430;
const CY = 430;
const RADIUS = { inner: 132, mid: 230, outer: 318 } as const;
const IDENTITY = { x: 0, y: 0, k: 1 };

export interface AttackTarget {
  kind: "misconception" | "fog";
  label: string;
  summary: string;
}

type Ring = keyof typeof RADIUS;
type GraphKind = "mastery" | "resolved-thread" | "misconception" | "open-thread" | "fog";

interface GraphNode {
  id: string;
  kind: GraphKind;
  ring: Ring;
  label: string;
  summary: string;
  updatedAt: string;
  quotes: string[];
  x: number;
  y: number;
}

const TYPE_LABEL: Record<GraphKind, string> = {
  mastery: "已掌握",
  "resolved-thread": "已解决支线",
  misconception: "误区",
  "open-thread": "进行中支线",
  fog: "待解锁",
};

function truncate(text: string, limit: number) {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}…`;
}

function formatTime(iso: string, lang: Language) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(localeOf(lang), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function nodeRadius(count: number, radius: number) {
  if (count <= 1) return 8;
  return Math.max(4.5, Math.min(8, ((2 * Math.PI * radius) / count) * 0.22));
}

function place(partial: Omit<GraphNode, "x" | "y">[]): GraphNode[] {
  const sorted = [...partial].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.map((node, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / sorted.length;
    const radius = RADIUS[node.ring];
    return { ...node, x: CX + Math.cos(angle) * radius, y: CY + Math.sin(angle) * radius };
  });
}

function layout(insights: SubjectInsights, fog: FogConcept[], generatedAt: string) {
  const partial: Omit<GraphNode, "x" | "y">[] = [];
  for (const memory of insights.mastered) {
    partial.push({
      id: memory.id, kind: "mastery", ring: "inner", label: memory.topic, summary: memory.summary,
      updatedAt: memory.updatedAt, quotes: [],
    });
  }
  for (const thread of insights.threads) {
    if (thread.status !== "resolved") continue;
    partial.push({
      id: thread.id, kind: "resolved-thread", ring: "inner", label: thread.title,
      summary: [thread.summary, ...thread.takeaways].filter(Boolean).join("\n"),
      updatedAt: thread.resolvedAt || thread.updatedAt, quotes: [],
    });
  }
  for (const memory of insights.misconceptions) {
    partial.push({
      id: memory.id, kind: "misconception", ring: "mid", label: memory.topic, summary: memory.summary,
      updatedAt: memory.updatedAt,
      quotes: memory.evidence.filter((item) => item.signal === "supports" && item.quote.trim()).map((item) => item.quote).slice(0, 3),
    });
  }
  for (const thread of insights.threads) {
    if (thread.status === "resolved") continue;
    partial.push({
      id: thread.id, kind: "open-thread", ring: "mid", label: thread.title, summary: thread.summary,
      updatedAt: thread.updatedAt, quotes: [],
    });
  }
  const known = new Set(partial.map((node) => node.id));
  for (const concept of fog) {
    if (known.has(concept.id)) continue;
    known.add(concept.id);
    partial.push({
      id: concept.id, kind: "fog", ring: "outer", label: concept.name, summary: concept.summary,
      updatedAt: generatedAt, quotes: [],
    });
  }
  const nodes = (["inner", "mid", "outer"] as const).flatMap((ring) => place(partial.filter((node) => node.ring === ring)));
  const seen = new Set<string>();
  const edges: Array<[string, string]> = [];
  const add = (a: string, b: string) => {
    if (!a || !b || a === b || !known.has(a) || !known.has(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(a < b ? [a, b] : [b, a]);
  };
  for (const thread of insights.threads) {
    for (const memoryId of thread.memoryIds) add(thread.id, memoryId);
  }
  for (const concept of fog) {
    for (const relatedId of concept.relatedIds) add(concept.id, relatedId);
  }
  return { nodes, edges };
}

function labelOf(node: GraphNode, count: number, ink = 1) {
  const radius = RADIUS[node.ring];
  const next = node.ring === "inner" ? RADIUS.mid : node.ring === "mid" ? RADIUS.outer : null;
  const dot = nodeRadius(count, radius) * Math.min(ink, 1.8);
  const gap = next == null ? CX - radius - dot - 14 : next - radius - dot * 2 - 16;
  const chord = count <= 1 ? gap : 2 * radius * Math.sin(Math.PI / count) - dot;
  const limit = Math.max(4, Math.min(8, Math.floor(Math.min(gap, chord) / (13 * ink))));
  const sortedAngle = Math.atan2(node.y - CY, node.x - CX);
  const cos = Math.cos(sortedAngle);
  const sin = Math.sin(sortedAngle);
  const labelR = radius + dot + 9 * ink;
  return {
    text: truncate(node.label, limit),
    full: node.label,
    x: CX + cos * labelR,
    y: CY + sin * labelR + (Math.abs(cos) <= 0.3 ? (sin >= 0 ? 4 : -4) : 0),
    anchor: cos > 0.3 ? "start" as const : cos < -0.3 ? "end" as const : "middle" as const,
    dot,
  };
}

function linkedThreads(nodeId: string, insights: SubjectInsights, edges: Array<[string, string]>) {
  const neighbor = new Set<string>([nodeId]);
  for (const [a, b] of edges) {
    if (a === nodeId) neighbor.add(b);
    if (b === nodeId) neighbor.add(a);
  }
  return insights.threads.filter((thread) => neighbor.has(thread.id) || thread.memoryIds.some((id) => neighbor.has(id)));
}

function Mark({ kind }: { kind: GraphKind }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      {kind === "mastery" && <circle cx="6" cy="6" r="3.2" className={styles.solidGreen} />}
      {kind === "misconception" && <circle cx="6" cy="6" r="3.2" className={cx(styles.solidRed, styles.breathe)} />}
      {kind === "open-thread" && (
        <circle cx="6" cy="6" r="3.2" className={styles.half} strokeDasharray={`${Math.PI * 3.2} ${Math.PI * 3.2}`} transform="rotate(-90 6 6)" />
      )}
      {kind === "fog" && <circle cx="6" cy="6" r="3.2" className={styles.fogNode} />}
    </svg>
  );
}

export function ConceptGraph({
  subjectId, subjectName, onAttack, onOpenThread, onStart,
}: {
  subjectId: string;
  subjectName: string;
  onAttack: (target: AttackTarget) => Promise<void>;
  onOpenThread: (threadId: string) => void;
  onStart?: () => void;
}) {
  const { tx, lang } = useI18n();
  const [insights, setInsights] = useState<SubjectInsights | null>(null);
  const [fog, setFog] = useState<ConceptGraphResult | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [fogLoading, setFogLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [cam, setCam] = useState(IDENTITY);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [attacking, setAttacking] = useState(false);
  const [attackError, setAttackError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // 视图坐标系固定为 VB，面板越窄缩放越小；按比例放大字号和节点，屏幕上的文字始终可读
  const [ink, setInk] = useState(1.6);
  const hubScale = Math.min(ink, 1.8);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const size = Math.min(entry.contentRect.width, entry.contentRect.height || entry.contentRect.width);
      if (size > 0) setInk(Math.round(Math.min(2.6, Math.max(1, VB / size)) * 10) / 10);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const requestId = useRef(0);

  const reload = useCallback(async (force: boolean) => {
    const token = ++requestId.current;
    setFogLoading(true);
    setInsightsError(null);
    try {
      const data = await insightsApi.getInsights(subjectId);
      if (requestId.current !== token) return;
      setInsights(data);
    } catch (error) {
      if (requestId.current !== token) return;
      setInsightsError(toApiError(error).message);
      setFogLoading(false);
      return;
    }
    try {
      const graph = await conceptGraphApi.get(subjectId, { force });
      if (requestId.current !== token) return;
      setFog(graph);
    } catch (error) {
      if (requestId.current !== token) return;
      setFog({
        subjectId, generatedAt: "", cached: false, degraded: true,
        notice: toApiError(error).message, model: null, nodes: [],
      });
    } finally {
      if (requestId.current === token) setFogLoading(false);
    }
  }, [subjectId]);

  useEffect(() => {
    setInsights(null);
    setFog(null);
    setSelected(null);
    setCam(IDENTITY);
    setTip(null);
    void reload(false);
  }, [reload]);

  const graph = insights ? layout(insights, fog?.nodes ?? [], fog?.generatedAt ?? "") : null;
  const showGraph = Boolean(graph && graph.nodes.length > 0);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !showGraph) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const cursor = point.matrixTransform(matrix.inverse());
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setCam((current) => {
        const k = Math.min(2.8, Math.max(0.55, current.k * factor));
        const contentX = (cursor.x - current.x) / current.k;
        const contentY = (cursor.y - current.y) / current.k;
        return { k, x: cursor.x - contentX * k, y: cursor.y - contentY * k };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [showGraph]);

  const selectedNode = graph?.nodes.find((node) => node.id === selected) ?? null;
  const name = insights?.subject.name || subjectName;
  const settled = graph?.nodes.filter((node) => node.ring === "inner").length ?? 0;
  const pending = graph?.nodes.filter((node) => node.ring === "mid").length ?? 0;
  const locked = graph?.nodes.filter((node) => node.ring === "outer").length ?? 0;
  const total = settled + pending;
  const pct = total === 0 ? 0 : Math.round((settled / total) * 100);
  const progress = 2 * Math.PI * 40;

  const showTip = (event: { clientX: number; clientY: number }, text: string, full: string) => {
    if (text === full) {
      setTip(null);
      return;
    }
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    let x = event.clientX - bounds.left + 10;
    const y = event.clientY - bounds.top + 14;
    if (x > bounds.width - 180) x = Math.max(8, x - 188);
    setTip({ x, y, text: full });
  };

  const attack = async (node: GraphNode) => {
    if (node.kind !== "misconception" && node.kind !== "fog") return;
    setAttacking(true);
    setAttackError(null);
    try {
      await onAttack({ kind: node.kind, label: node.label, summary: node.summary });
    } catch (error) {
      setAttackError(toApiError(error).message);
    } finally {
      setAttacking(false);
    }
  };

  const counts = {
    mastery: graph?.nodes.filter((node) => node.kind === "mastery" || node.kind === "resolved-thread").length ?? 0,
    misconception: graph?.nodes.filter((node) => node.kind === "misconception").length ?? 0,
    "open-thread": graph?.nodes.filter((node) => node.kind === "open-thread").length ?? 0,
    fog: locked,
  };

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.muted}>{fogLoading ? tx("正在推演外环") : fog?.degraded ? tx("外环未生成") : tx("三环拓扑")}</span>
        <span className={styles.toolbarSpacer} />
        <button type="button" className={styles.toolBtn} onClick={() => void reload(true)} disabled={fogLoading}>{tx("刷新")}</button>
        <button type="button" className={styles.toolBtn} onClick={() => setCam(IDENTITY)}>{tx("重置视图")}</button>
      </div>
      {fog?.notice && <p className={styles.notice} role="status">{fog.notice}</p>}
      {insightsError && !insights ? (
        <div className={styles.message} role="alert">
          <p>{insightsError}</p>
          <button type="button" className={styles.toolBtn} onClick={() => void reload(false)}>{tx("重试")}</button>
        </div>
      ) : !insights || !graph ? (
        <p className={styles.empty}>{tx("正在整理这个空间的知识…")}</p>
      ) : !showGraph ? (
        <div className={styles.empty}>
          <strong>{tx("讲过的概念会画在这里。")}</strong>
          {onStart && <button type="button" className={styles.toolBtn} onClick={onStart}>{tx("去主线讲一讲")}</button>}
          {fogLoading && <p className={styles.muted}>{tx("正在根据空间目标推演外环…")}</p>}
        </div>
      ) : (
        <>
          {settled + pending === 0 && (
            <p className={styles.guide}>
              {tx("掌握和误区会落到环上。先在主线里讲一讲你的理解。")}
            </p>
          )}
          <div className={styles.stage} ref={stageRef}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${VB} ${VB}`}
              style={{ "--ink": ink } as CSSProperties}
              role="application"
              aria-label={tx("{name}的知识迷雾拓扑图，已掌握 {settled}，待攻克 {pending}，待解锁 {locked}", {
                name, settled, pending, locked,
              })}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const target = event.target as Element;
                if (target.closest("[data-node]")) return;
                drag.current = { px: event.clientX, py: event.clientY, x: cam.x, y: cam.y };
                dragged.current = false;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const start = drag.current;
                const svg = svgRef.current;
                if (!start || !svg) return;
                const matrix = svg.getScreenCTM();
                if (!matrix) return;
                const dx = (event.clientX - start.px) / matrix.a;
                const dy = (event.clientY - start.py) / matrix.d;
                if (Math.hypot(event.clientX - start.px, event.clientY - start.py) > 3) dragged.current = true;
                setCam((current) => ({ ...current, x: start.x + dx, y: start.y + dy }));
              }}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                setSelected(null);
              }}
            >
              <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.k})`}>
                <circle cx={CX} cy={CY} r={RADIUS.inner} className={styles.guide} />
                <circle cx={CX} cy={CY} r={RADIUS.mid} className={styles.guide} />
                <circle cx={CX} cy={CY} r={RADIUS.outer} className={cx(styles.guide, styles.guideOuter)} />
                {graph.edges.map(([a, b]) => {
                  const from = graph.nodes.find((node) => node.id === a);
                  const to = graph.nodes.find((node) => node.id === b);
                  if (!from || !to) return null;
                  return <line key={`${a}|${b}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={styles.edge} />;
                })}
                <circle cx={CX} cy={CY} r={58 * hubScale} className={styles.hub} />
                <circle cx={CX} cy={CY} r={40 * hubScale} className={styles.track} />
                {total > 0 && pct > 0 && (
                  <circle
                    cx={CX}
                    cy={CY}
                    r={40 * hubScale}
                    className={styles.value}
                    strokeDasharray={`${(pct / 100) * progress * hubScale} ${progress * hubScale}`}
                    transform={`rotate(-90 ${CX} ${CY})`}
                  />
                )}
                <text x={CX} y={CY - 8 * hubScale} className={styles.centerName}>{truncate(name, 6)}</text>
                <text x={CX} y={CY + 14 * hubScale} className={styles.centerPct}>{total ? `${pct}%` : "—"}</text>
                <text x={CX} y={CY + 32 * hubScale} className={styles.centerHint}>{total ? tx("已掌握 {settled}/{total}", { settled, total }) : tx("待开始")}</text>
                <title>{name}</title>
                {graph.nodes.map((node) => {
                  const count = graph.nodes.filter((item) => item.ring === node.ring).length;
                  const label = labelOf(node, count, ink);
                  const on = selected === node.id;
                  return (
                    <g
                      key={node.id}
                      data-node={node.id}
                      className={styles.node}
                      tabIndex={0}
                      role="button"
                      aria-label={`${tx(TYPE_LABEL[node.kind])} ${node.label}`}
                      aria-pressed={on}
                      onClick={(event) => {
                        event.stopPropagation();
                        setTip(null);
                        setSelected(node.id);
                        setAttackError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(node.id);
                        }
                      }}
                      onMouseEnter={(event) => showTip(event, label.text, label.full)}
                      onMouseLeave={() => setTip(null)}
                    >
                      <circle cx={node.x} cy={node.y} r={Math.max(label.dot + 5, 12)} className={styles.hit} />
                      <circle cx={node.x} cy={node.y} r={label.dot + 3.5} className={styles.focusRing} />
                      {on && <circle cx={node.x} cy={node.y} r={label.dot + 3.5} className={styles.selectedRing} />}
                      {node.kind === "open-thread" ? (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={label.dot}
                          className={styles.half}
                          strokeDasharray={`${Math.PI * label.dot} ${Math.PI * label.dot}`}
                          transform={`rotate(-90 ${node.x} ${node.y})`}
                        />
                      ) : (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={label.dot}
                          className={cx(
                            node.kind === "misconception" ? styles.solidRed : node.kind === "fog" ? styles.fogNode : styles.solidGreen,
                            node.kind === "misconception" && styles.breathe,
                          )}
                        />
                      )}
                      <text x={label.x} y={label.y} textAnchor={label.anchor} dominantBaseline="central" className={styles.label}>
                        {label.text}
                        <title>{label.full}</title>
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
            {tip && <div className={styles.tip} style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
            {selectedNode && insights && (
              <aside className={styles.drawer} aria-label={tx("节点详情")} onClick={(event) => event.stopPropagation()}>
                <header className={styles.drawerHead}>
                  <h2>{selectedNode.label}</h2>
                  <button type="button" className={styles.close} aria-label={tx("关闭详情")} onClick={() => setSelected(null)}>
                    <X size={14} />
                  </button>
                </header>
                <div className={styles.body}>
                  <span className={cx(styles.badge, badgeClass(selectedNode.kind))}>{tx(TYPE_LABEL[selectedNode.kind])}</span>
                  <p className={styles.summary}>{selectedNode.summary || tx("还没有摘要。")}</p>
                  {selectedNode.kind === "misconception" && selectedNode.quotes.length > 0 && (
                    <section>
                      <h3 className={styles.blockTitle}>{tx("原话证据")}</h3>
                      {selectedNode.quotes.map((quote) => <blockquote key={quote} className={styles.quote}>{tx("「{quote}」", { quote })}</blockquote>)}
                    </section>
                  )}
                  <ThreadList
                    node={selectedNode}
                    threads={linkedThreads(selectedNode.id, insights, graph.edges)}
                    onOpenThread={onOpenThread}
                  />
                  <RelatedNodes node={selectedNode} nodes={graph.nodes} edges={graph.edges} onSelect={setSelected} />
                  {formatTime(selectedNode.updatedAt, lang) && (
                    <p className={styles.meta}>{tx("更新于 {time}", { time: formatTime(selectedNode.updatedAt, lang) })}</p>
                  )}
                  {(selectedNode.kind === "misconception" || selectedNode.kind === "fog") && (
                    <>
                      <button type="button" className={styles.attack} disabled={attacking} onClick={() => void attack(selectedNode)}>
                        {attacking ? tx("正在开启…") : tx("🎯 开启支线攻克此节点 →")}
                      </button>
                      {attackError && <p className={styles.attackError}>{attackError}</p>}
                    </>
                  )}
                </div>
              </aside>
            )}
          </div>
          <div className={styles.legend}>
            <span className={styles.legendItem}><Mark kind="mastery" />{tx("已掌握 {count}", { count: counts.mastery })}</span>
            <span className={styles.legendItem}><Mark kind="misconception" />{tx("误区 {count}", { count: counts.misconception })}</span>
            <span className={styles.legendItem}><Mark kind="open-thread" />{tx("进行中 {count}", { count: counts["open-thread"] })}</span>
            <span className={styles.legendItem}><Mark kind="fog" />{tx("待解锁 {count}", { count: counts.fog })}</span>
          </div>
        </>
      )}
    </div>
  );
}

function badgeClass(kind: GraphKind) {
  if (kind === "misconception") return styles.badgeMis;
  if (kind === "open-thread" || kind === "resolved-thread") return styles.badgeThread;
  if (kind === "fog") return styles.badgeFog;
  return styles.badgeMastery;
}

function ThreadList({
  node, threads, onOpenThread,
}: {
  node: GraphNode;
  threads: InsightThread[];
  onOpenThread: (threadId: string) => void;
}) {
  const { tx } = useI18n();
  const items = threads.filter((thread) => thread.id !== node.id);
  const self = node.kind === "open-thread" || node.kind === "resolved-thread";
  if (!self && items.length === 0) return null;
  return (
    <section>
      <h3 className={styles.blockTitle}>{tx("关联支线")}</h3>
      {self && (
        <button type="button" className={styles.threadBtn} onClick={() => onOpenThread(node.id)}>{tx("打开此支线")}</button>
      )}
      {items.map((thread) => (
        <button key={thread.id} type="button" className={styles.threadBtn} onClick={() => onOpenThread(thread.id)}>
          {thread.status === "resolved" ? tx("已解决") : tx("进行中")} · {thread.title}
        </button>
      ))}
    </section>
  );
}

function RelatedNodes({
  node, nodes, edges, onSelect,
}: {
  node: GraphNode;
  nodes: GraphNode[];
  edges: Array<[string, string]>;
  onSelect: (id: string) => void;
}) {
  const { tx } = useI18n();
  const ids = new Set<string>();
  for (const [a, b] of edges) {
    if (a === node.id) ids.add(b);
    if (b === node.id) ids.add(a);
  }
  const related = nodes.filter((item) => ids.has(item.id) && item.kind !== "open-thread" && item.kind !== "resolved-thread");
  if (related.length === 0) return null;
  return (
    <section>
      <h3 className={styles.blockTitle}>{tx("关联节点")}</h3>
      <ul className={styles.related}>
        {related.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onSelect(item.id)}>{tx(TYPE_LABEL[item.kind])} · {item.label}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

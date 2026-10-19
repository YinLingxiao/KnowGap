"use client";

import { useMemo, useRef, useState } from "react";
import {
  Bug, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, CircuitBoard, Code, HelpCircle,
  ImageIcon, Layers, MessageSquarePlus, Pencil, Play, Sliders, Sparkles, Terminal,
} from "lucide-react";
import { cx } from "@/lib/cx";
import { parseWidgetJson } from "@/lib/chat/widgetJson";
import styles from "./LearningWidget.module.css";

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

  return null;
}

function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface PlaygroundTest {
  name: string;
  input: string;
  expected: string;
}

interface PlaygroundResult {
  ok: boolean;
  lines: string[];
}

const BLANK_RE = /_{3,}|\bTODO\b/g;

function CodePlaygroundWidget({ data }: { data: Record<string, unknown> }) {
  const title = asText(data.title, "代码脚手架填空");
  const language = asText(data.language, "python");
  const starter = asText(data.code ?? data.starter ?? data.scaffold);
  const solution = asText(data.solution);
  const hint = asText(data.hint);
  const sampleOutput = asText(data.sampleOutput);
  const tests = useMemo<PlaygroundTest[]>(
    () =>
      asList(data.tests ?? data.test_cases).map((raw, index) => {
        const item = asRecord(raw);
        return {
          name: asText(item.name, `用例 ${index + 1}`),
          input: asText(item.input),
          expected: asText(item.expected ?? item.output),
        };
      }),
    [data.tests, data.test_cases],
  );
  const [code, setCode] = useState(starter);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const gutter = useRef<HTMLDivElement>(null);

  if (!starter) return null;
  const lineCount = Math.max(1, code.split("\n").length);

  const run = () => {
    const blanks = (code.match(BLANK_RE) ?? []).length;
    if (blanks > 0) {
      setResult({ ok: false, lines: [`⚠ 还有 ${blanks} 处空白（___ 或 TODO）没有填写`] });
      return;
    }
    const squash = (text: string) => text.replace(/\s+/g, "");
    const lines: string[] = [];
    let ok = true;
    if (solution && squash(solution) !== squash(code)) {
      ok = false;
      lines.push("△ 与参考写法不完全一致，不代表一定有错，可以点「让 AI 诊断代码」确认");
    } else {
      lines.push("✓ 空白已全部填写");
      tests.forEach((test) => lines.push(`✓ ${test.name}：${test.input || "（无输入）"} → 预期 ${test.expected || "—"}`));
      if (sampleOutput) lines.push(`输出：${sampleOutput}`);
    }
    lines.push("（模拟运行：浏览器端只做占位与写法检查，不会真正执行代码）");
    setResult({ ok, lines });
  };

  const diagnose = () => {
    const testText = tests.map((test) => `- ${test.name}：输入 ${test.input || "无"}，预期 ${test.expected || "—"}`).join("\n");
    const outText = result ? `\n本地检查结果：\n${result.lines.join("\n")}` : "";
    emitWidgetQuestion(
      `请帮我诊断「${title}」里的 ${language} 代码，先指出问题所在并给提示，不要直接给完整答案：\n\`\`\`${language}\n${code}\n\`\`\`${
        testText ? `\n测试用例：\n${testText}` : ""
      }${outText}`,
    );
  };

  return (
    <section className={styles.widgetCard} aria-label={title}>
      <header className={styles.widgetHead}>
        <div className={styles.widgetTitleWrap}>
          <span className={styles.widgetBadge}>
            <Code size={12} aria-hidden />
            代码填空
          </span>
          <strong className={styles.widgetTitle}>{title}</strong>
        </div>
        <code className={styles.formulaBadge}>{language}</code>
      </header>

      {hint && <p className={styles.matrixTakeaway}>💡 {hint}</p>}

      <div className={styles.codeWrap}>
        <div ref={gutter} className={styles.codeGutter} aria-hidden>
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <textarea
          className={styles.codeArea}
          value={code}
          spellCheck={false}
          wrap="off"
          aria-label={`${language} 代码编辑区`}
          onChange={(event) => setCode(event.target.value)}
          onScroll={(event) => {
            if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
          }}
        />
      </div>

      {tests.length > 0 && (
        <ul className={styles.testList} aria-label="测试用例">
          {tests.map((test, index) => (
            <li key={`${test.name}-${index}`}>
              <strong>{test.name}</strong>
              <code>{test.input || "（无输入）"}</code>
              <span>→</span>
              <code>{test.expected || "—"}</code>
            </li>
          ))}
        </ul>
      )}

      <div className={cx(styles.runOutput, result && !result.ok && styles.runOutputWarn)} role="status" aria-live="polite">
        <span className={styles.runOutputHead}>
          <Terminal size={12} aria-hidden />
          运行输出
        </span>
        {result ? result.lines.map((line, i) => <p key={i}>{line}</p>) : <p>点击「模拟运行」检查填空是否完整。</p>}
      </div>

      <footer className={styles.widgetFoot}>
        <button type="button" className={styles.ctrlBtn} onClick={run}>
          <Play size={13} aria-hidden />
          <span>模拟运行</span>
        </button>
        <button
          type="button"
          className={styles.ctrlBtn}
          onClick={() => {
            setCode(starter);
            setResult(null);
          }}
        >
          <span>重置代码</span>
        </button>
        <button type="button" className={styles.askAiBtn} onClick={diagnose}>
          <Bug size={12} aria-hidden />
          <span>让 AI 诊断代码</span>
        </button>
      </footer>
    </section>
  );
}

interface Annotation {
  box: [number, number, number, number];
  label: string;
  color: string;
}

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
const DEFAULT_ANNOTATION_COLOR = "#ef4444";

function safeColor(value: unknown) {
  const text = asText(value);
  return /^#[0-9a-f]{3,8}$/i.test(text) || /^[a-z]{3,20}$/i.test(text) ? text : DEFAULT_ANNOTATION_COLOR;
}

function safeImageSrc(value: unknown) {
  const text = asText(value).trim();
  return /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|bmp);base64,|blob:|\/)/i.test(text) ? text : "";
}

function parseAnnotations(raw: unknown): Annotation[] {
  const list: Annotation[] = [];
  asList(raw).forEach((entry) => {
    const item = asRecord(entry);
    const bbox = asList(item.bbox).map(Number);
    if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) return;
    const scale = Math.max(...bbox.map(Math.abs)) <= 1 ? 1000 : 1;
    const clamp = (n: number) => Math.min(1000, Math.max(0, n * scale));
    const [ymin, xmin, ymax, xmax] = bbox.map(clamp);
    list.push({
      box: [Math.min(ymin, ymax), Math.min(xmin, xmax), Math.max(ymin, ymax), Math.max(xmin, xmax)],
      label: asText(item.label, "批注"),
      color: safeColor(item.color),
    });
  });
  return list;
}

function ImageAnnotatorWidget({ data }: { data: Record<string, unknown> }) {
  const title = asText(data.title, "图片批注");
  const src = safeImageSrc(data.imageUrl ?? data.src ?? data.image);
  const annotations = useMemo(() => parseAnnotations(data.annotations), [data.annotations]);
  const ratio = Number(data.aspectRatio);
  const aspect = Number.isFinite(ratio) && ratio >= 0.3 && ratio <= 4 ? ratio : 4 / 3;
  const [active, setActive] = useState<number | null>(null);

  if (annotations.length === 0) return null;
  const marker = (index: number) => CIRCLED[index] ?? String(index + 1);
  const current = active === null ? null : annotations[active];

  return (
    <section className={styles.widgetCard} aria-label={title}>
      <header className={styles.widgetHead}>
        <div className={styles.widgetTitleWrap}>
          <span className={styles.widgetBadge}>
            <ImageIcon size={12} aria-hidden />
            图片批注
          </span>
          <strong className={styles.widgetTitle}>{title}</strong>
        </div>
        <span className={styles.stepCounter}>{annotations.length} 处批注</span>
      </header>

      <div className={styles.annoStage} style={{ aspectRatio: String(aspect) }}>
        <svg className={styles.annoSvg} viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label={`${title}，共 ${annotations.length} 处批注`}>
          {src ? (
            <image href={src} x={0} y={0} width={1000} height={1000} preserveAspectRatio="none" />
          ) : (
            <rect x={0} y={0} width={1000} height={1000} className={styles.annoEmpty} />
          )}
          {annotations.map((anno, i) => {
            const [ymin, xmin, ymax, xmax] = anno.box;
            return (
              <ellipse
                key={i}
                cx={(xmin + xmax) / 2}
                cy={(ymin + ymax) / 2}
                rx={Math.max(((xmax - xmin) / 2) * 1.08, 14)}
                ry={Math.max(((ymax - ymin) / 2) * 1.08, 14)}
                fill={active === i ? `${anno.color}22` : "none"}
                stroke={anno.color}
                strokeWidth={active === i ? 4 : 2.5}
                opacity={active === null || active === i ? 1 : 0.4}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        {!src && <span className={styles.annoEmptyHint}>未提供图片，仅展示批注位置</span>}
        {annotations.map((anno, i) => (
          <button
            key={i}
            type="button"
            className={cx(styles.annoBadge, active === i && styles.annoBadgeOn)}
            style={{ left: `${anno.box[1] / 10}%`, top: `${anno.box[0] / 10}%`, background: anno.color }}
            aria-pressed={active === i}
            aria-label={`批注 ${i + 1}：${anno.label}`}
            onClick={() => setActive(active === i ? null : i)}
          >
            {marker(i)}
          </button>
        ))}
      </div>

      <ul className={styles.annoList}>
        {annotations.map((anno, i) => (
          <li key={i}>
            <button
              type="button"
              className={cx(styles.annoItem, active === i && styles.annoItemOn)}
              onClick={() => setActive(active === i ? null : i)}
            >
              <span className={styles.annoDot} style={{ background: anno.color }}>{marker(i)}</span>
              <span>{anno.label}</span>
            </button>
          </li>
        ))}
      </ul>

      <footer className={styles.widgetFoot}>
        <span className={styles.footHint}>点击角标高亮对应批注，再针对这一处追问</span>
        <button
          type="button"
          className={styles.askAiBtn}
          disabled={!current}
          onClick={() =>
            current &&
            active !== null &&
            emitWidgetQuestion(`关于图片「${title}」里的批注 ${marker(active)}「${current.label}」，请结合图中这一处详细讲讲。`)
          }
        >
          <MessageSquarePlus size={12} aria-hidden />
          <span>{current && active !== null ? `追问批注 ${marker(active)}` : "先选择一处批注"}</span>
        </button>
      </footer>
    </section>
  );
}

interface NetNode {
  id: string;
  note: string;
}

interface NetBranch {
  id: string;
  from: string;
  to: string;
  element: string;
  value: string;
  polarity: string;
}

function CircuitNetlistWidget({ data }: { data: Record<string, unknown> }) {
  const title = asText(data.title, "电路拓扑确认");
  const nodes = useMemo<NetNode[]>(
    () =>
      asList(data.nodes).map((raw, i) => {
        if (typeof raw === "string" || typeof raw === "number") return { id: String(raw), note: "" };
        const item = asRecord(raw);
        return { id: asText(item.id ?? item.label, `N${i}`), note: asText(item.note ?? item.label) };
      }),
    [data.nodes],
  );
  const branches = useMemo<NetBranch[]>(
    () =>
      asList(data.branches).map((raw, i) => {
        const item = asRecord(raw);
        const ends = asList(item.nodes);
        return {
          id: asText(item.id ?? item.name, `B${i + 1}`),
          from: asText(item.from ?? ends[0], "?"),
          to: asText(item.to ?? ends[1], "?"),
          element: asText(item.element ?? item.type ?? item.component, "元件"),
          value: asText(item.value),
          polarity: asText(item.polarity ?? item.direction),
        };
      }),
    [data.branches],
  );
  const [status, setStatus] = useState<"idle" | "fixing" | "confirmed">("idle");
  const [picked, setPicked] = useState<number | null>(null);
  const [fix, setFix] = useState("");

  if (branches.length === 0) return null;
  const netlistText = [
    `节点：${nodes.map((node) => node.id).join("、") || "（未列出）"}`,
    ...branches.map((b) => `${b.id}：${b.element}${b.value ? ` ${b.value}` : ""}，${b.from} → ${b.to}${b.polarity ? `（${b.polarity}）` : ""}`),
  ].join("\n");
  const fixing = status === "fixing";
  const hasPolarity = branches.some((branch) => branch.polarity);

  return (
    <section className={styles.widgetCard} aria-label={title}>
      <header className={styles.widgetHead}>
        <div className={styles.widgetTitleWrap}>
          <span className={styles.widgetBadge}>
            <CircuitBoard size={12} aria-hidden />
            电路拓扑
          </span>
          <strong className={styles.widgetTitle}>{title}</strong>
        </div>
        <span className={styles.stepCounter}>{nodes.length} 个节点 · {branches.length} 条支路</span>
      </header>

      {nodes.length > 0 && (
        <div className={styles.netNodes} role="list" aria-label="识别出的节点">
          {nodes.map((node) => (
            <span key={node.id} role="listitem" className={styles.netNode} title={node.note || undefined}>
              {node.id}
            </span>
          ))}
        </div>
      )}

      <div className={styles.matrixScroll}>
        <table className={styles.matrixTable}>
          <thead>
            <tr>
              {fixing && <th aria-label="选择" />}
              <th>支路</th>
              <th>起点</th>
              <th>终点</th>
              <th>元件</th>
              {hasPolarity && <th>极性 / 参考方向</th>}
            </tr>
          </thead>
          <tbody>
            {branches.map((branch, i) => (
              <tr key={`${branch.id}-${i}`} className={cx(fixing && picked === i && styles.netRowPicked)}>
                {fixing && (
                  <td>
                    <button
                      type="button"
                      className={cx(styles.netPick, picked === i && styles.netPickOn)}
                      aria-pressed={picked === i}
                      aria-label={`选择支路 ${branch.id}`}
                      onClick={() => setPicked(picked === i ? null : i)}
                    />
                  </td>
                )}
                <td className={styles.dimCell}>{branch.id}</td>
                <td>{branch.from}</td>
                <td>{branch.to}</td>
                <td>{branch.element}{branch.value ? ` ${branch.value}` : ""}</td>
                {hasPolarity && <td className={styles.dimCell}>{branch.polarity || "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {fixing && (
        <form
          className={styles.netFixForm}
          onSubmit={(event) => {
            event.preventDefault();
            const text = fix.trim();
            if (picked === null || !text) return;
            emitWidgetQuestion(
              `我想修正「${title}」中支路 ${branches[picked].id} 的连接：${text}。请按修正后的拓扑重新核对整张电路的节点与支路，再确认是否可以列方程。\n当前识别结果：\n${netlistText}`,
            );
            setFix("");
            setPicked(null);
            setStatus("idle");
          }}
        >
          <input
            value={fix}
            maxLength={120}
            aria-label="修正说明"
            placeholder={picked === null ? "先在上方选择要修正的支路" : `支路 ${branches[picked].id} 实际应如何连接？`}
            disabled={picked === null}
            onChange={(event) => setFix(event.target.value)}
          />
          <button type="submit" className={styles.ctrlBtn} disabled={picked === null || !fix.trim()}>
            提交修正
          </button>
        </form>
      )}

      {status === "confirmed" && <p className={styles.matrixTakeaway}>✅ 已确认拓扑，已请 AI 开始列方程求解。</p>}

      <footer className={styles.widgetFoot}>
        <button
          type="button"
          className={styles.askAiBtn}
          disabled={status === "confirmed"}
          onClick={() => {
            setStatus("confirmed");
            emitWidgetQuestion(
              `「${title}」的电路拓扑我已核对，连接无误：\n${netlistText}\n请开始列方程求解：先说明选用节点电压法还是网孔电流法，再写出方程并求解。`,
            );
          }}
        >
          <Check size={12} aria-hidden />
          <span>[✓ 连接无误，开始列方程求解]</span>
        </button>
        <button
          type="button"
          className={styles.ctrlBtn}
          disabled={status === "confirmed"}
          onClick={() => {
            setStatus(fixing ? "idle" : "fixing");
            setPicked(null);
          }}
        >
          <Pencil size={12} aria-hidden />
          <span>{fixing ? "取消修正" : "[✎ 修正某条支路连接]"}</span>
        </button>
      </footer>
    </section>
  );
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
          <strong className={styles.widgetTitle}>{question}</strong>
        </div>
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
              <span className={styles.quizOptionText}>{opt}</span>
              {rightOption && <CheckCircle2 size={15} className={styles.iconRight} aria-hidden />}
              {wrongPicked && <CircleAlert size={15} className={styles.iconWrong} aria-hidden />}
            </button>
          );
        })}
      </div>

      {answered && (
        <div className={cx(styles.quizFeedback, isCorrect ? styles.feedbackRight : styles.feedbackWrong)}>
          <strong>{isCorrect ? "回答正确！" : `这道题选 ${String.fromCharCode(65 + answerIndex)}`}</strong>
          {explanation && <p>{explanation}</p>}
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

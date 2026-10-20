"use client";

/**
 * 代码实验台微件（`knowgap-widget` 的 `code_playground` 类型）。
 *
 * 讲完原理后下发带 `# TODO` / `// TODO` 挖空的脚手架（或空白的完整编写模式），
 * 学生在 CodeMirror 6 里填写，点「编译并运行」后在本机沙盒（POST /api/sandbox/run）
 * 拿到真实的编译器 / 解释器输出；出错时可以把「代码 + 报错」一键放进聊天输入框请 AI 诊断。
 *
 * 挂载方式：props 是标准的 `data: Record<string, unknown>`，由负责人在 LearningWidget 里分发：
 *   <CodePlaygroundWidget data={parsed} />
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, CircleAlert, CircleCheck, Code, LoaderCircle, Play, RotateCcw, ShieldAlert,
} from "lucide-react";
import {
  defaultKeymap, history, historyKeymap, indentWithTab, temporarilySetTabFocusMode,
} from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration, EditorView, MatchDecorator, ViewPlugin, drawSelection, highlightActiveLine, keymap, lineNumbers,
  type DecorationSet, type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { toApiError } from "@/lib/api/errors";
import {
  runSandbox, type SandboxCaseResult, type SandboxCaseStatus, type SandboxDiagnostic, type SandboxResult,
  type SandboxStatus,
} from "@/lib/api/sandbox-client";
import { cx } from "@/lib/cx";
import base from "../LearningWidget.module.css";
import styles from "./CodePlaygroundWidget.module.css";
import {
  LANGUAGE_LABELS, buildDiagnosisPrompt, countTodos, parseCodePlaygroundSpec,
  type PlaygroundLanguage, type PlaygroundSpec,
} from "./codePlaygroundModel";

/** 与 LearningWidget.tsx 里的 WIDGET_ASK_EVENT 相同。Composer 监听它并把内容预填进输入框。
 *  这里复制字符串而不是 import，避免两个微件文件互相依赖形成循环。 */
const WIDGET_ASK_EVENT = "knowgap:widget-ask";

function emitWidgetQuestion(prompt: string) {
  window.dispatchEvent(new CustomEvent<string>(WIDGET_ASK_EVENT, { detail: prompt }));
}

// ----------------------------------------------------------------- 编辑器扩展

/** TODO 注释高亮：`# TODO…` 或 `// TODO…` 整行注释加底色 */
const todoMatcher = new MatchDecorator({
  regexp: /(?:#|\/\/)[ \t]*TODO\b.*/g,
  decoration: Decoration.mark({ class: "cm-sbx-todo" }),
});

const todoHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = todoMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = todoMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** 出错行标红。装饰会随编辑自动平移。 */
const setErrorLines = StateEffect.define<number[]>();
const errorLineDeco = Decoration.line({ class: "cm-sbx-error-line" });
const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setErrorLines)) continue;
      const doc = transaction.state.doc;
      const lines = [...new Set(effect.value)].filter((n) => n >= 1 && n <= doc.lines).sort((a, b) => a - b);
      next = Decoration.set(lines.map((n) => errorLineDeco.range(doc.line(n).from)));
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// 颜色全部引用 globals.css 的变量，明暗主题自动适配。
const editorTheme = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--bg-subtle)",
    fontSize: "13px",
    maxHeight: "420px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--text)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--text-tertiary)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--accent-soft-strong)",
  },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft-strong)", outline: "none" },
  ".cm-sbx-todo": { backgroundColor: "var(--orange-soft)", color: "var(--orange)", borderRadius: "3px" },
  ".cm-line.cm-sbx-error-line": { backgroundColor: "var(--red-soft)" },
});

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "var(--accent-text)", fontWeight: "600" },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: "var(--green)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--orange)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--text-tertiary)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--amber)" },
  { tag: [tags.meta, tags.operator], color: "var(--text-secondary)" },
  { tag: tags.function(tags.variableName), fontWeight: "600" },
]);

function languageExtension(language: PlaygroundLanguage): Extension {
  if (language === "python") return python();
  if (language === "javascript") return javascript();
  return cpp(); // cpp() 同时覆盖 C
}

// ------------------------------------------------------------------- 展示文案

const STATUS_TITLE: Record<SandboxStatus, string> = {
  blocked: "被安全黑名单拦截",
  compile_error: "编译失败",
  timeout: "运行超时",
  runtime_error: "运行出错",
  failed: "输出和预期不一致",
  passed: "全部通过",
  ok: "运行完成",
};

const CASE_LABEL: Record<SandboxCaseStatus, string> = {
  passed: "通过", failed: "输出不一致", ok: "已运行", runtime_error: "运行出错",
  timeout: "超时", output_limit: "输出过多", skipped: "未运行",
};

const isGoodCase = (status: SandboxCaseStatus) => status === "passed" || status === "ok";

function Output({ label, text }: { label: string; text: string }) {
  return (
    <div className={styles.output}>
      <span className={styles.outputLabel}>{label}</span>
      <pre className={styles.pre}>{text}</pre>
    </div>
  );
}

function DiagnosticList({ items, onJump }: { items: SandboxDiagnostic[]; onJump: (line: number) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className={styles.diagList}>
      {items.map((item, index) => (
        <li key={`${item.line}-${item.column}-${index}`}>
          {item.line !== null ? (
            <button type="button" className={styles.diagItem} onClick={() => onJump(item.line as number)}>
              <span className={cx(styles.diagSeverity, item.severity === "warning" && styles.diagWarn)}>
                {item.severity === "warning" ? "警告" : "错误"}
              </span>
              <span className={styles.diagLoc}>第 {item.line} 行{item.column !== null ? `:${item.column}` : ""}</span>
              <span className={styles.diagMsg}>{item.message}</span>
            </button>
          ) : (
            <div className={styles.diagItem}>
              <span className={styles.diagSeverity}>错误</span>
              <span className={styles.diagMsg}>{item.message}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function CaseCard({ item, single }: { item: SandboxCaseResult; single: boolean }) {
  const good = isGoodCase(item.status);
  const showExpected = item.expected !== null && item.status === "failed";
  return (
    // 单次运行（没有测试用例）时输出就是学生想看的东西，默认展开；多用例时只展开没通过的。
    <details className={styles.case} open={single || (!good && item.status !== "skipped")}>
      <summary>
        <span className={cx(styles.chip, good ? styles.chipGood : item.status === "skipped" ? styles.chipMuted : styles.chipBad)}>
          {CASE_LABEL[item.status]}
        </span>
        <strong>{single ? "运行结果" : item.name}</strong>
        <span className={styles.caseMeta}>{item.durationMs} ms</span>
      </summary>
      <div className={styles.caseBody}>
        {item.input && <Output label="输入" text={item.input} />}
        {showExpected && (
          <div className={styles.compare}>
            <Output label="期望输出" text={item.expected ?? ""} />
            <Output label="实际输出" text={item.stdout || "（没有输出）"} />
          </div>
        )}
        {!showExpected && item.stdout && <Output label="标准输出" text={item.stdout} />}
        {!showExpected && !item.stdout && good && <p className={styles.muted}>（程序没有输出）</p>}
        {item.stderr.trim() && <Output label="错误输出" text={item.stderr.trim()} />}
        {(item.exitCode !== null && item.exitCode !== 0) || item.exitNote ? (
          <p className={styles.exit}>
            {item.exitCode !== null && <>退出码 {item.exitCode}</>}
            {item.exitNote && <> · {item.exitNote}</>}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function ResultPanel({
  result, language, onJump,
}: { result: SandboxResult; language: PlaygroundLanguage; onJump: (line: number) => void }) {
  const compiled = language === "c" || language === "cpp";
  const warnings = result.compile?.ok ? result.compile.diagnostics.filter((item) => item.severity === "warning") : [];
  const title = result.status === "compile_error" && !compiled ? "语法错误" : STATUS_TITLE[result.status];
  const tone = result.ok ? styles.bannerGood : result.status === "blocked" ? styles.bannerWarn : styles.bannerBad;
  const Icon = result.ok ? CircleCheck : result.status === "blocked" ? ShieldAlert : CircleAlert;
  return (
    <div className={styles.result}>
      <div className={cx(styles.banner, tone)} role={result.ok ? "status" : "alert"}>
        <Icon size={15} aria-hidden />
        <div className={styles.bannerText}>
          <strong>{title}</strong>
          <p>{result.message}</p>
        </div>
        {result.total > 0 && <span className={styles.score}>{result.passed}/{result.total}</span>}
      </div>

      {result.blocked.length > 0 && (
        <ul className={styles.diagList}>
          {result.blocked.map((rule) => (
            <li key={`${rule.ruleId}-${rule.line}`}>
              <button type="button" className={styles.diagItem} onClick={() => onJump(rule.line)}>
                <span className={cx(styles.diagSeverity, styles.diagWarn)}>{rule.ruleId}</span>
                <span className={styles.diagLoc}>第 {rule.line} 行</span>
                <span className={styles.diagMsg}>{rule.description}<code className={styles.excerpt}>{rule.excerpt}</code></span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {result.compile && !result.compile.ok && (
        <>
          <DiagnosticList items={result.compile.diagnostics} onJump={onJump} />
          <Output
            label={compiled ? "编译器输出" : "语法检查输出"}
            text={(result.compile.stderr || result.compile.stdout).trim() || "（没有输出）"}
          />
        </>
      )}

      {warnings.length > 0 && (
        <details className={styles.warnings}>
          <summary>{warnings.length} 条编译警告</summary>
          <DiagnosticList items={warnings} onJump={onJump} />
        </details>
      )}

      {result.testResults.length > 0 && (
        <div className={styles.cases}>
          {result.testResults.map((item) => (
            <CaseCard key={item.index} item={item} single={result.total === 0 && result.testResults.length === 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- 主体

interface LastRun {
  id: number;
  code: string;
  result: SandboxResult;
}

function PlaygroundPanel({ spec, onAsk }: { spec: PlaygroundSpec; onAsk?: (prompt: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const seqRef = useRef(0);
  const runRef = useRef<() => Promise<void>>(async () => {});

  const [todoCount, setTodoCount] = useState(() => countTodos(spec.starterCode));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [last, setLast] = useState<LastRun | null>(null);
  const [stdin, setStdin] = useState("");
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 编辑器只在挂载时创建一次（StrictMode 下 cleanup 会 destroy 再重建），重渲染不会丢掉学生写的内容。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: spec.starterCode,
        extensions: [
          Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { void runRef.current(); return true; } }])),
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          languageExtension(spec.language),
          syntaxHighlighting(highlightStyle),
          editorTheme,
          todoHighlighter,
          errorLineField,
          // Esc 先让位给原有的「取消选区」；没有选区时开启 2 秒的 Tab 焦点模式，Tab 就能离开编辑器。
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, { key: "Escape", run: temporarilySetTabFocusMode }]),
          EditorView.contentAttributes.of({
            "aria-label": `${LANGUAGE_LABELS[spec.language]} 代码编辑器。按 Esc 再按 Tab 可离开编辑器。`,
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && mountedRef.current) setTodoCount(countTodos(update.state.doc.toString()));
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [spec]);

  const run = useCallback(async () => {
    const view = viewRef.current;
    if (!view || runningRef.current) return;
    runningRef.current = true;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    const code = view.state.doc.toString();
    setRunning(true);
    setError("");
    setAsked(false);
    try {
      const result = await runSandbox({
        language: spec.language, code, stdin,
        testCases: spec.testCases.map((item) => ({ name: item.name, input: item.input, expected: item.expected })),
      });
      if (!mountedRef.current || seq !== seqRef.current) return;
      setLast({ id: seq, code, result });
      // 只有学生在运行期间没改过代码时才标红，否则行号可能已经对不上。
      const current = viewRef.current;
      if (current && current.state.doc.toString() === code) {
        const lines = result.diagnostics
          .filter((item) => item.severity === "error" && item.line !== null)
          .map((item) => item.line as number);
        current.dispatch({ effects: setErrorLines.of(lines) });
      }
    } catch (caught) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      // ApiError.message 已经是后端给的中文说明（沙盒正忙、缺编译器、仅限本机访问等）。
      setError(toApiError(caught).message);
      setLast(null);
      viewRef.current?.dispatch({ effects: setErrorLines.of([]) });
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  }, [spec, stdin]);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const reset = () => {
    const view = viewRef.current;
    if (!view || runningRef.current) return;
    // 走编辑器事务，学生可以用 Ctrl+Z 撤销重置。
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: spec.starterCode },
      effects: setErrorLines.of([]),
    });
    setLast(null);
    setError("");
    setAsked(false);
    view.focus();
  };

  const jumpTo = (lineNumber: number) => {
    const view = viewRef.current;
    if (!view || lineNumber < 1 || lineNumber > view.state.doc.lines) return;
    const line = view.state.doc.line(lineNumber);
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
  };

  const diagnose = () => {
    if (!last || last.result.ok) return;
    const prompt = buildDiagnosisPrompt({
      title: spec.title, language: spec.language, instructions: spec.instructions,
      code: last.code, result: last.result,
    });
    (onAsk ?? emitWidgetQuestion)(prompt);
    setAsked(true);
  };

  const scaffold = spec.mode === "scaffold";
  // 脚手架里本来就没有 TODO 时不显示进度徽章，否则会对一段没有挖空的代码说「已全部补全」。
  const hasTodos = countTodos(spec.starterCode) > 0;
  const failed = last !== null && !last.result.ok;

  return (
    <section className={base.widgetCard} aria-label={spec.title}>
      <header className={base.widgetHead}>
        <div className={base.widgetTitleWrap}>
          <span className={base.widgetBadge}>
            <Code size={12} aria-hidden />
            代码实验
          </span>
          <strong className={base.widgetTitle}>{spec.title}</strong>
        </div>
        <div className={styles.metaRow}>
          <span className={base.stepCounter}>{LANGUAGE_LABELS[spec.language]}</span>
          <span className={base.stepCounter}>{scaffold ? "脚手架填空" : "完整编写"}</span>
          {scaffold && hasTodos && (
            <span className={cx(base.stepCounter, todoCount === 0 && styles.todoDone)} aria-live="polite">
              {todoCount > 0 ? `剩余 ${todoCount} 处待补全` : "已全部补全"}
            </span>
          )}
        </div>
      </header>

      {spec.instructions && <p className={styles.instructions}>{spec.instructions}</p>}

      <div className={styles.editor} ref={hostRef} />

      {spec.testCases.length === 0 && (
        <details className={styles.stdin}>
          <summary>标准输入（stdin）</summary>
          <textarea
            className={styles.stdinInput}
            value={stdin}
            onChange={(event) => setStdin(event.target.value)}
            maxLength={10_000}
            rows={3}
            spellCheck={false}
            aria-label="程序的标准输入"
            placeholder="程序用 input() / scanf / readline 读取的内容写在这里"
          />
        </details>
      )}

      <div className={styles.toolbar}>
        <button type="button" className={styles.runBtn} onClick={() => void run()} disabled={running} aria-busy={running}>
          {running ? <LoaderCircle size={14} className={styles.spin} aria-hidden /> : <Play size={14} aria-hidden />}
          <span>{running ? "运行中…" : "编译并运行"}</span>
        </button>
        <button type="button" className={base.ctrlBtn} onClick={reset} disabled={running}>
          <RotateCcw size={13} aria-hidden />
          <span>{scaffold ? "重置脚手架" : "重置代码"}</span>
        </button>
        {failed && (
          <button type="button" className={base.askAiBtn} onClick={diagnose}>
            <Bot size={13} aria-hidden />
            <span>让 AI 诊断报错原因</span>
          </button>
        )}
      </div>

      {asked && (
        <p className={styles.askedNote} role="status">
          已把代码和报错放进聊天输入框，检查后按回车发送给 AI。
        </p>
      )}

      {error && (
        <div className={cx(styles.banner, styles.bannerBad)} role="alert">
          <CircleAlert size={15} aria-hidden />
          <div className={styles.bannerText}>
            <strong>没能运行</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {last && <ResultPanel key={last.id} result={last.result} language={spec.language} onJump={jumpTo} />}

      <footer className={base.widgetFoot}>
        <span className={base.footHint}>
          Ctrl/⌘ + Enter 运行 · 按 Esc 再按 Tab 离开编辑器 · 每次最多运行 {last?.result.timeLimitSeconds ?? 3} 秒
        </span>
      </footer>
    </section>
  );
}

export interface CodePlaygroundWidgetProps {
  data: Record<string, unknown>;
  /** 点「让 AI 诊断」时调用；不传则派发 `knowgap:widget-ask` 事件，由 Composer 预填输入框 */
  onAsk?: (prompt: string) => void;
}

export function CodePlaygroundWidget({ data, onAsk }: CodePlaygroundWidgetProps) {
  // 用序列化后的字符串当稳定 key：父组件重渲染时 data 引用可能变，但内容没变就不该重建编辑器。
  const key = JSON.stringify(data);
  const parsed = useMemo(() => parseCodePlaygroundSpec(JSON.parse(key) as Record<string, unknown>), [key]);
  if (!parsed.ok) {
    return (
      <section className={base.widgetCard} role="alert" aria-label="代码实验台无法载入">
        <header className={base.widgetHead}>
          <div className={base.widgetTitleWrap}>
            <span className={base.widgetBadge}>
              <Code size={12} aria-hidden />
              代码实验
            </span>
            <strong className={base.widgetTitle}>无法载入代码实验台</strong>
          </div>
        </header>
        <p className={styles.instructions}>{parsed.reason}</p>
      </section>
    );
  }
  return <PlaygroundPanel key={key} spec={parsed.spec} onAsk={onAsk} />;
}

export default CodePlaygroundWidget;

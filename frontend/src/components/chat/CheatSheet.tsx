"use client";

/** 考前急救一页纸：全屏预览覆盖层，四宫格高密度排版，可打印 / 导出 PDF / 导出 Markdown / 重新生成。 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Download, Printer, RefreshCw, X, Zap } from "lucide-react";
import { toApiError } from "@/lib/api/errors";
import { insightsApi, type CheatSheet as Sheet, type SubjectInsights } from "@/lib/chat/insights";
import type { Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { Button } from "../ui/Button";
import { Markdown } from "./Markdown";
import styles from "./CheatSheet.module.css";

const STATUS_LABEL: Record<string, string> = {
  needs_review: "待复习", suspected: "疑似", improving: "好转中", resolved: "已解决",
};

/* 打印时只保留一页纸本身：CSS Modules 不允许纯全局选择器，所以这段规则以内联 <style> 挂载。 */
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 10mm; }
  body > *:not([data-cheatsheet-root]) { display: none !important; }
  html, body { overflow: visible !important; height: auto !important; background: Canvas !important; }
}`;

type Preview = Pick<Sheet["sections"], "pitfalls" | "conclusions">;

/** 模型还在生成时，先用聚合数据把 ① ② 画出来（与后端 pitfalls()/conclusions() 规则一致）。 */
function previewFrom(insights: SubjectInsights): Preview {
  return {
    pitfalls: insights.misconceptions.slice(0, 8).map((m) => ({
      memoryId: m.id, topic: m.topic, summary: m.summary, status: m.status,
      quotes: m.evidence.filter((e) => e.signal === "supports" && e.quote.trim()).slice(0, 2).map((e) => e.quote),
    })),
    conclusions: insights.threads
      .filter((t) => t.status === "resolved" && (t.summary || t.takeaways.length))
      .slice(0, 8)
      .map((t) => ({ threadId: t.id, title: t.title, summary: t.summary, takeaways: t.takeaways.slice(0, 4) })),
  };
}

function formatTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Md({ text }: { text: string }) {
  return <div className={styles.md}><Markdown text={text} /></div>;
}

function Quadrant({ index, title, hint, tone, children }: {
  index: string; title: string; hint: string; tone: "red" | "green" | "accent" | "amber"; children: React.ReactNode;
}) {
  return (
    <section className={cx(styles.quadrant, styles[tone])}>
      <header className={styles.qHead}>
        <span className={styles.qIndex}>{index}</span>
        <h3>{title}</h3>
        <span className={styles.qHint}>{hint}</span>
      </header>
      <div className={styles.qBody}>{children}</div>
    </section>
  );
}

export function CheatSheet({ subject, notes, onClose }: { subject: Subject; notes?: string; onClose: () => void }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setSheet(await insightsApi.getCheatSheet(subject.id, { force, notes }));
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setLoading(false);
    }
  }, [subject.id, notes]);

  useEffect(() => {
    setMounted(true);
    let alive = true;
    insightsApi.getInsights(subject.id).then((data) => { if (alive) setPreview(previewFrom(data)); }).catch(() => undefined);
    void load(false);
    return () => { alive = false; };
    // 只在打开或切换空间时生成一次；notes 变化不自动重算，需点「重新生成」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const exportMarkdown = () => {
    if (!sheet) return;
    const blob = new Blob([sheet.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${subject.name.replace(/[\\/:*?"<>|]/g, "_")}-考前一页纸.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!mounted) return null;

  const pitfalls = sheet?.sections.pitfalls ?? preview?.pitfalls ?? [];
  const conclusions = sheet?.sections.conclusions ?? preview?.conclusions ?? [];
  const formulas = sheet?.sections.formulas ?? [];
  const contrasts = sheet?.sections.contrasts ?? [];
  const quiz = sheet?.sections.quiz ?? [];
  const days = sheet?.stats.daysToDeadline;
  const pending = loading && !sheet;

  return createPortal(
    <div className={styles.backdrop} data-cheatsheet-root role="dialog" aria-modal="true" aria-label="考前一页纸">
      <style>{PRINT_CSS}</style>
      <div className={styles.toolbar}>
        <div className={styles.toolTitle}>
          <Zap size={14} aria-hidden />
          <strong>考前一页纸</strong>
          <span className={styles.toolMeta}>
            {sheet ? `${sheet.cached ? "缓存 · " : ""}生成于 ${formatTime(sheet.generatedAt)}` : loading ? "生成中…" : ""}
          </span>
        </div>
        <div className={styles.toolActions}>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={loading && Boolean(sheet)}
            disabled={loading} onClick={() => void load(true)}>
            重新生成
          </Button>
          <Button size="sm" variant="secondary" icon={<Download size={13} />} disabled={!sheet} onClick={exportMarkdown}>
            导出 Markdown
          </Button>
          <Button size="sm" variant="primary" icon={<Printer size={13} />} disabled={!sheet} onClick={() => window.print()}>
            打印 / 导出 PDF
          </Button>
          <button type="button" className={styles.close} aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className={styles.scroller}>
        {(error || sheet?.notice) && (
          <p className={cx(styles.notice, error && styles.noticeError)} role="status">
            <AlertTriangle size={13} aria-hidden />
            <span>{error ?? sheet?.notice}</span>
            {error && <button type="button" onClick={() => void load(false)}>重试</button>}
          </p>
        )}

        <article className={styles.sheet}>
          <header className={styles.sheetHead}>
            <h2>⚡ {subject.name} · 考前一页纸</h2>
            <div className={styles.sheetMeta}>
              {subject.goal && <span>目标：{subject.goal}</span>}
              {subject.deadline && <span>考试 {subject.deadline}{typeof days === "number" && days >= 0 ? `（剩 ${days} 天）` : ""}</span>}
              {sheet && <span>待攻克 {sheet.stats.misconceptions} · 已掌握 {sheet.stats.mastered} · 已解决 Thread {sheet.stats.threadsResolved}</span>}
            </div>
          </header>

          <div className={styles.grid}>
            <Quadrant index="①" title="个人易错红榜" hint="来自你的误区记忆与原话" tone="red">
              {pitfalls.length ? (
                <ol className={styles.list}>
                  {pitfalls.map((p) => (
                    <li key={p.memoryId}>
                      <div className={styles.itemHead}>
                        <strong>{p.topic}</strong>
                        <span className={styles.pill}>{STATUS_LABEL[p.status] ?? p.status}</span>
                      </div>
                      <Md text={p.summary} />
                      {p.quotes.map((q) => <blockquote key={q} className={styles.quote}>「{q}」</blockquote>)}
                    </li>
                  ))}
                </ol>
              ) : (
                <div className={styles.empty}>{pending ? "读取中…" : <>记下的误区会出现在这里。<button type="button" onClick={onClose}>去主对话讲一讲</button></>}</div>
              )}
            </Quadrant>

            <Quadrant index="②" title="Thread 核心结论" hint="来自已解决 Thread 的总结" tone="green">
              {conclusions.length ? (
                <ul className={styles.list}>
                  {conclusions.map((c) => (
                    <li key={c.threadId}>
                      <strong className={styles.itemTitle}>{c.title}</strong>
                      {c.summary && <Md text={c.summary} />}
                      {c.takeaways.length > 0 && (
                        <ul className={styles.takeaways}>
                          {c.takeaways.map((t) => <li key={t}><Md text={t} /></li>)}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className={styles.empty}>{pending ? "读取中…" : <>已解决的支线结论会出现在这里。<button type="button" onClick={onClose}>去主对话讲一讲</button></>}</div>
              )}
            </Quadrant>

            <Quadrant index="③" title="核心公式与适用边界" hint="模型从讲义与对话中提炼" tone="accent">
              {formulas.length ? (
                <ul className={styles.list}>
                  {formulas.map((f, i) => (
                    <li key={`${f.name}-${i}`}>
                      {f.name && <strong className={styles.itemTitle}><Md text={f.name} /></strong>}
                      <Md text={f.formula} />
                      {f.conditions && <div className={styles.sub}><span>适用</span><Md text={f.conditions} /></div>}
                      {f.pitfall && <div className={cx(styles.sub, styles.subWarn)}><span>易错</span><Md text={f.pitfall} /></div>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>{pending ? <span className={styles.shimmer}>正在提炼公式与适用边界…</span> : "暂未生成。"}</p>
              )}
            </Quadrant>

            <Quadrant index="④" title="易混概念对比 · 押题自测" hint="模型生成，先遮住答案自测" tone="amber">
              {contrasts.length > 0 && (
                <table className={styles.table}>
                  <thead><tr><th>A</th><th>B</th><th>核心区别</th></tr></thead>
                  <tbody>
                    {contrasts.map((c, i) => (
                      <tr key={`${c.a}-${c.b}-${i}`}>
                        <td><Md text={c.a} /></td><td><Md text={c.b} /></td>
                        <td><Md text={c.difference} />{c.tip && <div className={styles.tip}><Md text={c.tip} /></div>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {quiz.length > 0 && (
                <ol className={cx(styles.list, styles.quiz)}>
                  {quiz.map((q, i) => (
                    <li key={`${i}-${q.question}`}>
                      <Md text={q.question} />
                      <details className={styles.answer} open>
                        <summary>答案</summary>
                        <Md text={q.answer} />
                      </details>
                    </li>
                  ))}
                </ol>
              )}
              {!contrasts.length && !quiz.length && (
                <p className={styles.empty}>{pending ? <span className={styles.shimmer}>正在生成对比与自测题…</span> : "暂未生成。"}</p>
              )}
            </Quadrant>
          </div>
          <footer className={styles.sheetFoot}>KnowGap 知隙 · ①② 来自你的真实学习记录，③④ 由模型生成，请以课本为准</footer>
        </article>
      </div>
    </div>,
    document.body,
  );
}

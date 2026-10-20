"use client";

/**
 * micro_quiz 右上角的「真题母题溯源」标签 + 「再来一道同型好题」按钮。
 *
 * 数据来自后端 problem_drill 核对后重写的 meta.source，模型自己写的出处不会到这里。
 * 安全：所有文本按纯文本渲染（不用 dangerouslySetInnerHTML）；链接只放行 http/https。
 * 挂载方式（需 LearningWidget.tsx 的 owner 合入一行）：
 *   {meta?.source && <ProblemSourceBadge source={meta.source} patternId={meta.pattern_id} … />}
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BookMarked, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import { WIDGET_ASK_EVENT } from "../LearningWidget";
import styles from "./ProblemSourceBadge.module.css";

export interface ProblemSource {
  kind?: "original" | "adapted" | string;
  origin_type?: string | null;
  label?: string | null;
  title?: string | null;
  site?: string | null;
  url?: string | null;
  retrieved_at?: string | null;
  adaptation_note?: string | null;
}

export interface ProblemSourceBadgeProps {
  source: ProblemSource;
  patternId?: string | null;
  knowledgePoint?: string | null;
  fingerprint?: string | null;
  /** 父组件可直接发送消息；不传则把请求填入输入框（沿用 WIDGET_ASK_EVENT）。 */
  onRequestMore?: (message: string) => void | Promise<unknown>;
  /** 回复流式输出期间由父组件置 true，防止重复点击。 */
  disabled?: boolean;
}

const MORE_PREFIX = "再出一道同型好题";

/** 只放行带主机名的 http/https 链接，拦截 javascript:、data: 等。 */
export function safeHref(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim() || url.length > 2048) return null;
  try {
    const parsed = new URL(url.trim());
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function clean(text: unknown, limit: number): string {
  // 去掉会破坏消息格式的分隔符和换行
  return typeof text === "string" ? text.replace(/[｜|\r\n]+/g, " ").trim().slice(0, limit) : "";
}

/** 与后端 problem_drill_skill.build_more_request 保持同一格式；以「再出…题」开头才能命中练习路由。 */
export function buildMoreRequest(knowledgePoint?: string | null, patternId?: string | null, fingerprint?: string | null): string {
  const parts = [MORE_PREFIX];
  const kp = clean(knowledgePoint, 40);
  const pattern = clean(patternId, 60);
  if (kp) parts.push(`知识点：${kp}`);
  if (pattern) parts.push(`题型：${pattern}`);
  if (typeof fingerprint === "string" && /^[0-9a-f]{16}$/.test(fingerprint)) parts.push(`已出：${fingerprint}`);
  return parts.join("｜");
}

/** 标签文案：真题显示出处，改编题显示「改编自 …」，讲义题显示「讲义例题 · …」。 */
export function badgeText(source: ProblemSource): string {
  const label = clean(source.label, 60);
  if (label) return label;
  const base = clean(source.origin_type, 20) || "经典母题";
  return source.kind === "adapted" ? `改编自 ${base}` : base;
}

export function ProblemSourceBadge({
  source, patternId, knowledgePoint, fingerprint, onRequestMore, disabled = false,
}: ProblemSourceBadgeProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [filled, setFilled] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const href = safeHref(source.url);
  const text = badgeText(source);
  const adapted = source.kind === "adapted";

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  useEffect(() => {
    if (!filled) return;
    const timer = window.setTimeout(() => setFilled(false), 2500);
    return () => window.clearTimeout(timer);
  }, [filled]);

  const requestMore = async () => {
    if (pending || disabled) return;
    const message = buildMoreRequest(knowledgePoint, patternId, fingerprint);
    if (onRequestMore) {
      setPending(true);
      try {
        await onRequestMore(message);
      } finally {
        setPending(false);
      }
      return;
    }
    window.dispatchEvent(new CustomEvent<string>(WIDGET_ASK_EVENT, { detail: message }));
    setFilled(true);
  };

  const busy = pending || disabled;

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        className={adapted ? `${styles.badge} ${styles.badgeAdapted}` : styles.badge}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`题目来源：${text}，点击查看详情`}
        title={text}
        onClick={() => setOpen((value) => !value)}
      >
        <BookMarked size={12} aria-hidden />
        <span className={styles.badgePrefix}>真题母题溯源</span>
        <span className={styles.badgeText}>{text}</span>
      </button>

      <button
        type="button"
        className={styles.moreBtn}
        onClick={() => void requestMore()}
        disabled={busy}
        aria-busy={pending}
        aria-label="再来一道同型好题"
        title={filled ? "已填入输入框，按发送即可" : "再来一道同型好题"}
      >
        {pending ? <Loader2 size={12} className={styles.spin} aria-hidden /> : <RefreshCw size={12} aria-hidden />}
        <span className={styles.moreText}>{filled ? "已填入输入框" : "再来一道同型好题"}</span>
      </button>

      {open && (
        <div id={panelId} role="dialog" aria-label="题目来源详情" className={styles.panel}>
          <div className={styles.panelHead}>
            <strong>{adapted ? "改编题来源" : "原题来源"}</strong>
            <button type="button" className={styles.closeBtn} onClick={() => close(true)} aria-label="关闭来源详情">
              <X size={14} aria-hidden />
            </button>
          </div>
          <dl className={styles.fields}>
            <dt>来源类型</dt>
            <dd>{clean(source.origin_type, 20) || "经典母题"}{adapted ? "（已改编）" : ""}</dd>
            {source.title && (<><dt>出处</dt><dd>{clean(source.title, 120)}</dd></>)}
            {source.site && (<><dt>站点</dt><dd>{clean(source.site, 60)}</dd></>)}
            {source.retrieved_at && (<><dt>检索时间</dt><dd>{clean(source.retrieved_at, 20)}</dd></>)}
            {adapted && source.adaptation_note && (<><dt>改编说明</dt><dd>{clean(source.adaptation_note, 200)}</dd></>)}
          </dl>
          {href ? (
            <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer nofollow">
              <ExternalLink size={12} aria-hidden />
              <span>查看原文</span>
              <span className={styles.srOnly}>（在新窗口打开）</span>
            </a>
          ) : (
            <p className={styles.noLink}>{source.origin_type === "讲义例题" ? "来自你上传的课程讲义" : "原文链接不可用"}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default ProblemSourceBadge;

"use client";

import { CircleAlert, Globe } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import type { ToolCallView } from "@/lib/chat/types";
import styles from "./WebSearchCard.module.css";

/** 支线联网搜索（web_search）的结果卡片：列出查询词和每条来源，链接可以点开 */
export const WEB_SEARCH_TOOL = "web_search";

export interface WebResult {
  label: string;
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  status: "ok" | "no_result" | "error" | "limit";
  query: string;
  results: WebResult[];
  note: string;
}

const STATUSES = new Set(["ok", "no_result", "error", "limit"]);

/** 只接受 http / https：模型或网页给出的其他协议（javascript:、data:）一律丢弃 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 解析工具输出；格式不对返回 null，由调用方退回通用的工具清单 */
export function parseWebSearch(output: string): WebSearchOutput | null {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.status !== "string" || !STATUSES.has(record.status)) return null;
  const rows = Array.isArray(record.results) ? record.results : [];
  const results: WebResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const url = safeHttpUrl(item.url);
    if (!url) continue;
    results.push({
      label: typeof item.label === "string" ? item.label : "",
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : url,
      url,
      snippet: typeof item.snippet === "string" ? item.snippet : "",
    });
  }
  return {
    status: record.status as WebSearchOutput["status"],
    query: typeof record.query === "string" ? record.query : "",
    results,
    note: typeof record.note === "string" ? record.note : "",
  };
}

/** 工具还在跑时输出是空的，查询词从参数里取 */
export function queryFromArguments(text: string): string {
  try {
    const data: unknown = JSON.parse(text);
    if (data && typeof data === "object" && typeof (data as { query?: unknown }).query === "string") {
      return (data as { query: string }).query;
    }
  } catch { /* 参数还没写完 */ }
  return "";
}

export function WebSearchCard({ call }: { call: ToolCallView }) {
  const { tx } = useI18n();
  if (!call.output) {
    const query = queryFromArguments(call.arguments);
    return (
      <div className={styles.card} role="status">
        <div className={styles.head}>
          <span className={styles.icon} aria-hidden><Globe size={13} /></span>
          <span>{tx("正在联网搜索…")}</span>
        </div>
        {query && <p className={styles.query}>{query}</p>}
      </div>
    );
  }
  const data = parseWebSearch(call.output);
  if (!data) return null;
  const failed = data.status !== "ok";
  return (
    <section className={styles.card} aria-label={tx("联网搜索")}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden>{failed ? <CircleAlert size={13} /> : <Globe size={13} />}</span>
        <span>{tx("联网搜索")}</span>
        {data.results.length > 0 && <span className={styles.count}>{tx("{count} 条结果", { count: data.results.length })}</span>}
      </div>
      {data.query && <p className={styles.query}>{data.query}</p>}
      {data.note && <p className={failed ? styles.noteWarn : styles.note}>{data.note}</p>}
      {data.results.length > 0 && (
        <ol className={styles.list}>
          {data.results.map((item, index) => (
            <li key={index} className={styles.item}>
              <span className={styles.label}>{item.label || index + 1}</span>
              <div className={styles.body}>
                <a className={styles.title} href={item.url} target="_blank" rel="noreferrer noopener">{item.title}</a>
                <span className={styles.host}>{hostOf(item.url)}</span>
                {item.snippet && <p className={styles.snippet}>{item.snippet}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

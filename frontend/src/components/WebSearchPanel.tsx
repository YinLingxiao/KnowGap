"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLink, Search, X } from "lucide-react";
import { API_BASE_URL } from "@/lib/config";
import { request } from "@/lib/api/http-client";
import { toApiError } from "@/lib/api/errors";
import type { WebSearchResponse, WebSource } from "@/lib/types";
import styles from "./WebSearchPanel.module.css";

export function WebSearchPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WebSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) { if (!dialog.current?.open) dialog.current?.showModal(); input.current?.focus(); }
    else { generation.current += 1; dialog.current?.close(); }
  }, [open]);
  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim() || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setSearched(false); setResults([]);
    const version = ++generation.current;
    try {
      const response = await request<WebSearchResponse>(API_BASE_URL, `/api/search?q=${encodeURIComponent(query.trim())}`, { timeoutMs: 65_000 });
      if (version === generation.current) { setResults(response.results); setSearched(true); }
    } catch (failure) { if (version === generation.current) setError(toApiError(failure).message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="web-search-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className={styles.header}><div><Search size={17} aria-hidden /><h2 id="web-search-title">联网搜索</h2><span>AnySearch</span></div>
      <button className={styles.close} onClick={onClose} aria-label="关闭联网搜索"><X size={18} aria-hidden /></button>
    </header>
    <div className={styles.body}>
      <p className={styles.intro}>搜索学习资料、代码文档和参考解释，查看原始来源。</p>
      <form className={styles.form} onSubmit={(event) => void search(event)} role="search">
        <input ref={input} value={query} maxLength={600} aria-label="联网搜索关键词" placeholder="例如：C++ stack 后进先出"
          onChange={(event) => { generation.current += 1; setQuery(event.target.value); setSearched(false); setResults([]); }} />
        <button type="submit" disabled={busy || !query.trim()}>{busy ? "搜索中…" : "搜索"}</button>
      </form>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {busy && <p className={styles.empty} role="status">AnySearch 正在检索网页…</p>}
      {!busy && !searched && !error && <p className={styles.empty}>输入关键词，开始联网检索。</p>}
      {searched && results.length === 0 && <p className={styles.empty}>没有找到结果，试试更具体的关键词。</p>}
      {results.length > 0 && <section className={styles.results} aria-label="AnySearch 搜索结果">
        {results.map((result) => <article key={result.id}>
          <a href={result.url} target="_blank" rel="noopener noreferrer">{result.title}<ExternalLink size={13} aria-hidden /></a>
          <span className={styles.url}>{result.url}</span>
          {result.snippet && <p>{result.snippet}</p>}
        </article>)}
      </section>}
    </div>
  </dialog>;
}

export function WebSources({ sources }: { sources: WebSource[] }) {
  if (!sources.length) return null;
  return <div className={styles.sources} aria-label="导师引用的网页来源">
    {sources.map((source) => <details key={source.id}>
      <summary>{source.label} · {source.title}</summary>
      <a href={source.url} target="_blank" rel="noopener noreferrer">查看原文<ExternalLink size={12} aria-hidden /></a>
      {source.snippet && <blockquote>{source.snippet}</blockquote>}
    </details>)}
  </div>;
}

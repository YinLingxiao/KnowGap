"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, BookOpen, Search, Trash2, Upload } from "lucide-react";
import { createMaterialClient } from "@/lib/api/material-client";
import { toApiError } from "@/lib/api/errors";
import type { CourseMaterial, SourceReference } from "@/lib/types";
import { sourceLocation } from "./SourceReferences";
import styles from "./MaterialLibrary.module.css";

/** unassigned：只管理未归入 Subject 的资料（所有对话都会检索）；Subject 自己的资料在 Subject 页 */
export function MaterialLibrary({ enabled, onBack, unassigned = false }: { enabled: boolean; onBack: () => void; unassigned?: boolean }) {
  const client = useMemo(() => createMaterialClient(), []);
  const [documents, setDocuments] = useState<CourseMaterial[]>([]);
  const [results, setResults] = useState<SourceReference[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<"upload" | "search" | "delete" | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const pending = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setDocuments(await client.list({ unassigned })); }
    catch (failure) { setError(toApiError(failure).message); }
    finally { setLoading(false); }
  }, [client, unassigned]);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  useEffect(() => () => { generation.current += 1; }, []);

  async function upload(file: File) {
    if (pending.current) return;
    setError(null); setNotice(null);
    if (file.size > 5 * 1024 * 1024) { setError("单份资料不能超过 5 MB。"); return; }
    if (!/\.(pdf|txt|md)$/i.test(file.name)) { setError("请上传 PDF、TXT 或 Markdown 文件。"); return; }
    pending.current = true; setOperation("upload");
    try {
      const document = await client.upload(file);
      setDocuments((current) => [document, ...current]);
      setNotice(`已添加 ${document.title}，教学时会检索相关内容。`);
    } catch (failure) { setError(toApiError(failure).message); }
    finally { pending.current = false; setOperation(null); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim() || pending.current) return;
    const version = ++generation.current;
    pending.current = true; setOperation("search"); setError(null); setSearched(false); setResults([]);
    try {
      const data = await client.search(query.trim());
      if (version === generation.current) { setResults(data); setSearched(true); }
    } catch (failure) { if (version === generation.current) setError(toApiError(failure).message); }
    finally { pending.current = false; setOperation(null); }
  }

  async function remove(document: CourseMaterial) {
    if (pending.current) return;
    pending.current = true; setOperation("delete"); setError(null); setNotice(null);
    try {
      await client.remove(document.id);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setResults((current) => current.filter((source) => source.documentId !== document.id));
      setNotice(`已删除 ${document.title}，后续教学不再检索这份资料。`);
      setConfirmId(null);
    } catch (failure) { setError(toApiError(failure).message); }
    finally { pending.current = false; setOperation(null); }
  }

  return <section className={styles.library} aria-labelledby="materials-title">
    <header className={styles.header}>
      <div><BookOpen size={16} aria-hidden /><h2 id="materials-title">课程资料</h2></div>
      <button onClick={onBack} className={styles.back}><ArrowLeft size={14} aria-hidden />返回学习</button>
    </header>
    <div className={styles.body}>
      <p className={styles.intro}>{unassigned ? "这里的资料不属于任何学习空间，所有对话都会检索；某个空间专用的资料请放到对应学习空间里。" : "找到课程中的原文，让每次解释都有出处。"}</p>
      {!enabled ? <p className={styles.empty}>当前为演示模式。连接真实后端后，可上传和检索自己的课程资料。</p> : <>
        <form className={styles.search} onSubmit={(event) => void search(event)} role="search">
          <Search size={16} aria-hidden />
          <input aria-label="搜索课程资料" placeholder="搜索知识点，例如：栈的后进先出" value={query} maxLength={600}
            onChange={(event) => { generation.current += 1; setQuery(event.target.value); setSearched(false); setResults([]); }} />
          <button type="submit" disabled={!query.trim() || Boolean(operation)}>{operation === "search" ? "检索中…" : "搜索"}</button>
        </form>
        <div className={styles.toolbar}>
          <span>{documents.length} 份资料 · PDF / TXT / Markdown</span>
          <button onClick={() => fileInput.current?.click()} disabled={Boolean(operation) || loading}><Upload size={14} aria-hidden />{operation === "upload" ? "正在解析…" : "上传资料"}</button>
          <input ref={fileInput} type="file" accept=".pdf,.txt,.md" className={styles.fileInput} aria-label="选择课程资料"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
        </div>
        <p className={styles.hint}>单份最多 5 MB、100 页。PDF 需包含可复制的文字；文本文件使用 UTF-8。</p>
        {error && <div className={styles.error} role="alert"><span>{error}</span><button onClick={() => { setError(null); void refresh(); }}>刷新资料列表</button></div>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        {operation === "search" && <p className={styles.empty} role="status">正在查找资料中的原文…</p>}
        {searched && results.length === 0 && <p className={styles.empty}>没有找到相关原文，试试更具体的关键词，或上传对应章节的资料。</p>}
        {results.length > 0 && <section className={styles.results} aria-label="搜索结果">
          <h3>相关原文 <span>{results.length}</span></h3>
          {results.map((source) => <article className={styles.result} key={source.id}>
            <div><strong>{source.title}</strong><span>{sourceLocation(source)}</span></div>
            <blockquote>{source.excerpt}</blockquote>
          </article>)}
        </section>}
        <section className={styles.documents} aria-label="已上传的资料">
          <h3>我的资料</h3>
          {loading ? <p className={styles.empty} role="status">正在加载资料…</p> : documents.length === 0 ?
            <div className={styles.empty}><BookOpen size={25} aria-hidden /><p>添加一份课件或讲义，开始检索课程内容。</p></div> :
            <ul>{documents.map((document) => <li key={document.id}>
              <BookOpen size={16} className={styles.documentIcon} aria-hidden />
              <div className={styles.documentInfo}><strong>{document.title}</strong><span>{document.kind.toUpperCase()}{document.pageCount > 0 ? ` · ${document.pageCount} 页` : ""} · {document.chunkCount} 个原文片段</span></div>
              {confirmId === document.id ? <div className={styles.confirm}>
                <span>历史对话中的引用仍会保留。</span>
                <button disabled={Boolean(operation)} onClick={() => void remove(document)}>{operation === "delete" ? "删除中…" : "确认删除"}</button>
                <button disabled={Boolean(operation)} onClick={() => setConfirmId(null)}>取消</button>
              </div> : <button className={styles.remove} aria-label={`删除 ${document.title}`} disabled={Boolean(operation)} onClick={() => setConfirmId(document.id)}><Trash2 size={14} aria-hidden /></button>}
            </li>)}</ul>}
        </section>
      </>}
    </div>
  </section>;
}

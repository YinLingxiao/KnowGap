"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileSpreadsheet, FileText, FileType, Folder, LayoutGrid, List,
  MessageSquareText, NotebookPen, Plus, Presentation, Trash2, Upload,
} from "lucide-react";
import { createMaterialClient } from "@/lib/api/material-client";
import { toApiError } from "@/lib/api/errors";
import { chatApi } from "@/lib/chat/api";
import { DOCUMENT_EXTENSIONS } from "@/lib/chat/attachments";
import { cx } from "@/lib/cx";
import type { CourseMaterial } from "@/lib/types";
import { WIDGET_ASK_EVENT } from "./LearningWidget";
import styles from "./Library.module.css";

type Category = "doc" | "slides" | "sheet" | "text";
type SortKey = "name" | "date" | "size" | "kind";

const CATEGORY_LABEL: Record<Category, string> = { doc: "文档", slides: "课件", sheet: "表格", text: "文本" };
const CATEGORY_ICON = { doc: FileType, slides: Presentation, sheet: FileSpreadsheet, text: FileText } as const;
const FILTERS: Array<{ id: Category | "all"; label: string }> = [
  { id: "all", label: "全部类型" }, { id: "doc", label: "文档" }, { id: "slides", label: "课件" },
  { id: "sheet", label: "表格" }, { id: "text", label: "文本" },
];
const UNIT: Record<Category, string> = { doc: "页", slides: "张", sheet: "个表", text: "页" };

function categoryOf(title: string, kind: string): Category {
  const name = title.toLowerCase();
  if (/\.pptx?$/.test(name) || kind === "pptx" || kind === "ppt") return "slides";
  if (/\.(xlsx?|csv)$/.test(name) || kind === "xlsx" || kind === "xls") return "sheet";
  if (/\.(pdf|docx?)$/.test(name) || kind === "pdf" || kind === "docx" || kind === "doc") return "doc";
  return "text";
}

function extension(title: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(title);
  return match ? match[1].toUpperCase() : "";
}

function dateLabel(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "—";
  const day = `${time.getMonth() + 1}月${time.getDate()}日`;
  return time.getFullYear() === new Date().getFullYear() ? day : `${time.getFullYear()}年${day}`;
}

function sizeLabel(item: CourseMaterial, category: Category): string {
  return item.pageCount > 0 ? `${item.pageCount} ${UNIT[category]}` : "—";
}

interface WorkspaceEntry { name: string; path: string; kind: "dir" | "file" }
interface WorkspaceTree {
  workspace: string;
  name: string;
  entries: Array<WorkspaceEntry & { children?: WorkspaceEntry[] }>;
}

interface LibraryProps {
  subjectId: string;
  /** 空间笔记的字数；0 表示还没有内容 */
  notesChars: number;
  onOpenNotes: () => void;
  onChange: () => void;
}

const askAbout = (text: string) => window.dispatchEvent(new CustomEvent<string>(WIDGET_ASK_EVENT, { detail: text }));
const askWorkspaceFile = (path: string) => askAbout(`请读取工作区文件「${path}」并帮我分析其中的核心内容：`);
const kindOfEntry = (entry: WorkspaceEntry) => (entry.kind === "dir" ? "文件夹" : extension(entry.name) || "文件");

/**
 * 空间资料库：上传的讲义、空间笔记和本地工作区放在同一张文件列表里，
 * 可以按类型筛选、按列排序，在列表和卡片之间切换，也可以直接把文件拖进来。
 */
export function Library({ subjectId, notesChars, onOpenNotes, onChange }: LibraryProps) {
  const client = useMemo(() => createMaterialClient(), []);
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<CourseMaterial[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tree, setTree] = useState<WorkspaceTree>({ workspace: "", name: "", entries: [] });
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [filter, setFilter] = useState<Category | "all">("all");
  const [view, setView] = useState<"list" | "grid">("list");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await client.list({ subjectId }));
      setError(null);
    } catch (failure) {
      setError(toApiError(failure).message);
    } finally {
      setLoaded(true);
    }
  }, [client, subjectId]);
  const refreshWorkspace = useCallback(async () => {
    try { setTree(await chatApi.workspaceTree()); } catch { /* 没有绑定工作区时不显示这一行 */ }
  }, []);
  useEffect(() => {
    void refresh();
    void refreshWorkspace();
    const onEnv = () => void refreshWorkspace();
    window.addEventListener("knowgap:agent-env", onEnv);
    return () => window.removeEventListener("knowgap:agent-env", onEnv);
  }, [refresh, refreshWorkspace]);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(null), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const upload = async (files: File[]) => {
    for (const file of files) {
      setUploading((count) => count + 1);
      try {
        await client.upload(file, subjectId);
        setError(null);
      } catch (failure) {
        setError(`${file.name}：${toApiError(failure).message}`);
      } finally {
        setUploading((count) => count - 1);
      }
    }
    await refresh();
    onChange();
  };
  const remove = async (id: string) => {
    setConfirming(null);
    try {
      await client.remove(id);
      await refresh();
      onChange();
    } catch (failure) {
      setError(toApiError(failure).message);
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length) void upload(files);
  };

  const rows = useMemo(() => {
    const decorated = items.map((item) => ({ item, category: categoryOf(item.title, item.kind) }))
      .filter(({ category }) => filter === "all" || category === filter);
    const order: Record<SortKey, (row: (typeof decorated)[number]) => string | number> = {
      name: ({ item }) => item.title.toLowerCase(), date: ({ item }) => item.createdAt,
      size: ({ item }) => item.pageCount, kind: ({ category }) => category,
    };
    return decorated.sort((a, b) => {
      const x = order[sort.key](a), y = order[sort.key](b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [items, filter, sort]);
  const toggleSort = (key: SortKey) => setSort((current) => (
    current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: key === "date" ? -1 : 1 }
  ));
  const header = (key: SortKey, label: string) => (
    <span role="columnheader" aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className={styles.headCell} onClick={() => toggleSort(key)}>
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden />)}
      </button>
    </span>
  );

  const showNotes = (filter === "all" || filter === "text") && notesChars > 0;
  const showWorkspace = filter === "all" && Boolean(tree.workspace);
  const total = rows.length + (showNotes ? 1 : 0);
  const empty = loaded && items.length === 0 && !showNotes && !showWorkspace;

  const rowActions = (item: CourseMaterial) => (
    <span className={styles.actions}>
      <button
        type="button" aria-label={`就「${item.title}」提问`} title="就这份资料提问"
        onClick={() => askAbout(`请基于课程资料「${item.title}」帮我梳理重点：`)}
      >
        <MessageSquareText size={13} aria-hidden />
      </button>
      {confirming === item.id ? (
        <button type="button" className={styles.danger} onClick={() => void remove(item.id)}>确认删除</button>
      ) : (
        <button type="button" aria-label={`删除 ${item.title}`} title="删除" onClick={() => setConfirming(item.id)}>
          <Trash2 size={13} aria-hidden />
        </button>
      )}
    </span>
  );

  return (
    <div
      className={cx(styles.library, dragging && styles.dragging)}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={onDrop}
    >
      <div className={styles.toolbar}>
        <label className={styles.filter}>
          <select value={filter} onChange={(event) => setFilter(event.target.value as Category | "all")} aria-label="按类型筛选">
            {FILTERS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          <ChevronDown size={12} aria-hidden />
        </label>
        <div className={styles.views} role="group" aria-label="显示方式">
          <button type="button" aria-pressed={view === "grid"} aria-label="卡片" title="卡片" className={cx(view === "grid" && styles.viewOn)} onClick={() => setView("grid")}>
            <LayoutGrid size={13} aria-hidden />
          </button>
          <button type="button" aria-pressed={view === "list"} aria-label="列表" title="列表" className={cx(view === "list" && styles.viewOn)} onClick={() => setView("list")}>
            <List size={13} aria-hidden />
          </button>
        </div>
        <button type="button" className={styles.add} onClick={() => input.current?.click()}>
          <Plus size={14} aria-hidden />添加
        </button>
        <input
          ref={input} hidden multiple type="file" accept={DOCUMENT_EXTENSIONS.join(",")}
          onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) void upload(files); }}
        />
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}

      {empty ? (
        <button type="button" className={styles.empty} onClick={() => input.current?.click()}>
          <Upload size={20} aria-hidden />
          <strong>把讲义放进来</strong>
          <span>拖到这里，或点击添加。支持 PDF、Word、PPT、Excel 和文本，AI 回答时会引用其中的内容。</span>
        </button>
      ) : view === "list" ? (
        <div className={styles.table} role="table" aria-label="资料列表">
          <div className={cx(styles.row, styles.head)} role="row">
            {header("name", "名称")}
            {header("date", "修改日期")}
            {header("size", "规模")}
            {header("kind", "类型")}
          </div>
          {showWorkspace && (
            <>
              <div className={styles.row} role="row">
                <button type="button" className={styles.name} onClick={() => setWorkspaceOpen(!workspaceOpen)} aria-expanded={workspaceOpen}>
                  {workspaceOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                  <Folder size={14} className={styles.folder} aria-hidden />
                  <span>{tree.name || "本地工作区"}</span>
                </button>
                <span className={styles.cell}>—</span><span className={styles.cell}>—</span><span className={styles.cell}>工作区</span>
              </div>
              {workspaceOpen && (tree.entries.length === 0 ? (
                <p className={styles.nested}>工作区文件夹是空的。</p>
              ) : tree.entries.map((entry) => (
                <div key={entry.path} role="rowgroup">
                  <div className={cx(styles.row, styles.nestedRow)} role="row">
                    <button
                      type="button" className={styles.name}
                      onClick={() => (entry.kind === "dir"
                        ? setOpenDirs((old) => ({ ...old, [entry.path]: !old[entry.path] }))
                        : askWorkspaceFile(entry.path))}
                      title={entry.kind === "file" ? "点击把这个文件带入输入框" : undefined}
                    >
                      {entry.kind === "dir"
                        ? (openDirs[entry.path] ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />)
                        : <span className={styles.chevronSpace} />}
                      {entry.kind === "dir" ? <Folder size={14} className={styles.folder} aria-hidden /> : <FileText size={14} aria-hidden />}
                      <span>{entry.name}</span>
                    </button>
                    <span className={styles.cell}>—</span><span className={styles.cell}>—</span>
                    <span className={styles.cell}>{kindOfEntry(entry)}</span>
                  </div>
                  {entry.kind === "dir" && openDirs[entry.path] && entry.children?.map((child) => (
                    <div key={child.path} className={cx(styles.row, styles.nestedRow, styles.deepRow)} role="row">
                      <button type="button" className={styles.name} onClick={() => child.kind === "file" && askWorkspaceFile(child.path)}>
                        <span className={styles.chevronSpace} />
                        {child.kind === "dir" ? <Folder size={14} className={styles.folder} aria-hidden /> : <FileText size={14} aria-hidden />}
                        <span>{child.name}</span>
                      </button>
                      <span className={styles.cell}>—</span><span className={styles.cell}>—</span>
                      <span className={styles.cell}>{kindOfEntry(child)}</span>
                    </div>
                  ))}
                </div>
              )))}
            </>
          )}
          {showNotes && (
            <div className={styles.row} role="row">
              <button type="button" className={styles.name} onClick={onOpenNotes} title="打开空间笔记">
                <span className={styles.chevronSpace} />
                <NotebookPen size={14} aria-hidden />
                <span>空间笔记.md</span>
              </button>
              <span className={styles.cell}>—</span>
              <span className={styles.cell}>{notesChars} 字</span>
              <span className={styles.cell}>笔记</span>
            </div>
          )}
          {rows.map(({ item, category }) => {
            const Icon = CATEGORY_ICON[category];
            return (
              <div key={item.id} className={styles.row} role="row">
                <span className={styles.name}>
                  <span className={styles.chevronSpace} />
                  <Icon size={14} aria-hidden />
                  <span title={item.title}>{item.title}</span>
                </span>
                <span className={styles.cell}>{dateLabel(item.createdAt)}</span>
                <span className={styles.cell}>{sizeLabel(item, category)}</span>
                <span className={styles.cell}>{extension(item.title) || CATEGORY_LABEL[category]}</span>
                {rowActions(item)}
              </div>
            );
          })}
          {loaded && total === 0 && !showWorkspace && <p className={styles.nested}>没有这个类型的资料。</p>}
        </div>
      ) : (
        <div className={styles.grid}>
          {showNotes && (
            <button type="button" className={styles.card} onClick={onOpenNotes}>
              <NotebookPen size={20} aria-hidden />
              <strong>空间笔记.md</strong>
              <span>{notesChars} 字 · 笔记</span>
            </button>
          )}
          {rows.map(({ item, category }) => {
            const Icon = CATEGORY_ICON[category];
            const meta = [sizeLabel(item, category), dateLabel(item.createdAt)].filter((part) => part !== "—").join(" · ");
            return (
              <div key={item.id} className={styles.card}>
                <Icon size={20} aria-hidden />
                <strong title={item.title}>{item.title}</strong>
                <span>{meta || CATEGORY_LABEL[category]}</span>
                {rowActions(item)}
              </div>
            );
          })}
        </div>
      )}

      <footer className={styles.footer}>
        <span>{uploading > 0 ? `正在上传并解析 ${uploading} 个文件…` : `${total} 个文件`}</span>
        {dragging && <span>松开即可上传</span>}
      </footer>
    </div>
  );
}

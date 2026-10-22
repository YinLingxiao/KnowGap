"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  BookOpen, Check, ChevronDown, FileCode2, FileText, Folder, LayoutGrid,
  List, ListFilter, MoreHorizontal, PanelLeftOpen, Plus, Search, Trash2, Upload, X,
} from "lucide-react";
import { createMaterialClient } from "@/lib/api/material-client";
import { toApiError } from "@/lib/api/errors";
import type { Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import { formatRelativeTime } from "@/lib/labels";
import type { CourseMaterial, SourceReference } from "@/lib/types";
import { sourceLocation } from "./SourceReferences";
import styles from "./MaterialLibrary.module.css";

type ViewMode = "grid" | "list";
type KindFilter = "all" | "pdf" | "md" | "txt";
type ScopeFilter = "all" | "general" | string;

/** 参照截图 2/3/4 绘制的彩色文件类型图标（小号用于列表/卡片头，大号用于网格卡片中央） */
function FileKindIcon({ kind, size = "sm" }: { kind: "pdf" | "md" | "txt"; size?: "sm" | "lg" }) {
  if (size === "lg") {
    if (kind === "pdf") {
      return (
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden className={styles.iconPdf}>
          <path
            d="M11 6h12l8 8v18a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M23 6v8h8" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <text x="20" y="27" textAnchor="middle" fill="currentColor" fontSize="8.5" fontWeight="700" fontFamily="sans-serif">
            PDF
          </text>
        </svg>
      );
    }
    if (kind === "md") {
      return (
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden className={styles.iconMd}>
          <rect x="8" y="7" width="24" height="26" rx="4" stroke="currentColor" strokeWidth="1.8" />
          <path d="M13 15h14M13 20h14M13 25h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    }
    return (
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden className={styles.iconTxt}>
        <path
          d="M11 6h12l8 8v18a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M23 6v8h8M14 19h12M14 24h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (kind === "pdf") {
    return <span className={cx(styles.miniBadge, styles.miniPdf)}>PDF</span>;
  }
  if (kind === "md") {
    return (
      <span className={cx(styles.miniIconWrap, styles.iconMd)}>
        <FileCode2 size={15} aria-hidden />
      </span>
    );
  }
  return (
    <span className={cx(styles.miniIconWrap, styles.iconTxt)}>
      <FileText size={15} aria-hidden />
    </span>
  );
}

export function MaterialLibrary({
  enabled,
  onBack,
  unassigned = false,
  subjects = [],
  sidebarOpen = true,
  onOpenSidebar,
}: {
  enabled: boolean;
  onBack?: () => void;
  unassigned?: boolean;
  subjects?: Subject[];
  sidebarOpen?: boolean;
  onOpenSidebar?: () => void;
}) {
  const client = useMemo(() => createMaterialClient(), []);
  const [documents, setDocuments] = useState<CourseMaterial[]>([]);
  const [results, setResults] = useState<SourceReference[]>([]);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [uploadTargetSubjectId, setUploadTargetSubjectId] = useState<string | undefined>(undefined);
  const [menuDocId, setMenuDocId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<"upload" | "search" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const pending = useRef(false);

  const subjectMap = useMemo(
    () => Object.fromEntries(subjects.map((s) => [s.id, s])),
    [subjects],
  );

  // 读取全部资料（支持在前端按通用/空间/文件类型秒级切换筛选）
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setDocuments(await client.list({}));
    } catch (failure) {
      setError(toApiError(failure).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  useEffect(() => () => {
    generation.current += 1;
  }, []);

  useEffect(() => {
    if (!filterOpen && !uploadMenuOpen && !menuDocId) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (filterOpen && !filterRef.current?.contains(target)) setFilterOpen(false);
      if (uploadMenuOpen && !uploadMenuRef.current?.contains(target)) setUploadMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFilterOpen(false);
        setUploadMenuOpen(false);
        setMenuDocId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen, uploadMenuOpen, menuDocId]);

  async function upload(file: File, targetSubjectId?: string) {
    if (pending.current) return;
    setError(null);
    setNotice(null);
    if (file.size > 5 * 1024 * 1024) {
      setError("单份资料不能超过 5 MB。");
      return;
    }
    if (!/\.(pdf|txt|md)$/i.test(file.name)) {
      setError("此资料库入口暂仅支持 PDF、TXT 或 Markdown；Word、PPT、Excel、CSV 请在对话中上传。");
      return;
    }
    pending.current = true;
    setOperation("upload");
    try {
      const document = await client.upload(file, targetSubjectId);
      setDocuments((current) => [document, ...current]);
      const scopeName = targetSubjectId && subjectMap[targetSubjectId]
        ? `「${subjectMap[targetSubjectId].name}」`
        : "通用资料库";
      setNotice(`已添加 ${document.title} 至${scopeName}。`);
    } catch (failure) {
      setError(toApiError(failure).message);
    } finally {
      pending.current = false;
      setOperation(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function searchContent(event?: FormEvent, customQuery?: string) {
    event?.preventDefault();
    const q = (customQuery ?? query).trim();
    if (!q || pending.current) return;
    const version = ++generation.current;
    pending.current = true;
    setOperation("search");
    setError(null);
    setSearched(false);
    setResults([]);
    try {
      const data = await client.search(q);
      if (version === generation.current) {
        setResults(data);
        setSearched(true);
      }
    } catch (failure) {
      if (version === generation.current) setError(toApiError(failure).message);
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }

  async function remove(document: CourseMaterial) {
    if (pending.current) return;
    pending.current = true;
    setOperation("delete");
    setError(null);
    setNotice(null);
    try {
      await client.remove(document.id);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setResults((current) => current.filter((source) => source.documentId !== document.id));
      setNotice(`已删除 ${document.title}。`);
      setConfirmId(null);
      setMenuDocId(null);
    } catch (failure) {
      setError(toApiError(failure).message);
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }

  const triggerUpload = (subjectId?: string) => {
    setUploadTargetSubjectId(subjectId);
    setUploadMenuOpen(false);
    fileInput.current?.click();
  };

  const keyword = query.trim().toLowerCase();
  const filteredDocs = useMemo(() => {
    return documents.filter((doc) => {
      if (kindFilter !== "all" && doc.kind !== kindFilter) return false;
      if (scopeFilter === "general" && doc.subjectId !== null) return false;
      if (scopeFilter !== "all" && scopeFilter !== "general" && doc.subjectId !== scopeFilter) return false;
      if (keyword && !doc.title.toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [documents, kindFilter, scopeFilter, keyword]);

  const categoryPills: Array<{ id: string; label: string; active: boolean; onSelect: () => void }> = [
    {
      id: "all",
      label: "全部",
      active: kindFilter === "all" && scopeFilter === "all",
      onSelect: () => { setKindFilter("all"); setScopeFilter("all"); },
    },
    {
      id: "general",
      label: "通用资料",
      active: scopeFilter === "general" && kindFilter === "all",
      onSelect: () => { setScopeFilter("general"); setKindFilter("all"); },
    },
    {
      id: "pdf",
      label: "PDF 文件",
      active: kindFilter === "pdf",
      onSelect: () => setKindFilter(kindFilter === "pdf" ? "all" : "pdf"),
    },
    {
      id: "md",
      label: "Markdown",
      active: kindFilter === "md",
      onSelect: () => setKindFilter(kindFilter === "md" ? "all" : "md"),
    },
    {
      id: "txt",
      label: "纯文本",
      active: kindFilter === "txt",
      onSelect: () => setKindFilter(kindFilter === "txt" ? "all" : "txt"),
    },
    ...subjects.map((sub) => ({
      id: `sub-${sub.id}`,
      label: sub.name,
      active: scopeFilter === sub.id,
      onSelect: () => setScopeFilter(scopeFilter === sub.id ? "all" : sub.id),
    })),
  ];

  void unassigned;
  void onBack;

  return (
    <section
      className={cx(styles.page, dragOver && styles.pageDragOver)}
      aria-labelledby="materials-title"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void upload(file, scopeFilter !== "all" && scopeFilter !== "general" ? scopeFilter : undefined);
      }}
    >
      {!sidebarOpen && onOpenSidebar && (
        <button className={styles.floatingToggle} onClick={onOpenSidebar} aria-label="展开侧栏" title="展开侧栏">
          <PanelLeftOpen size={16} />
        </button>
      )}

      <input
        ref={fileInput}
        type="file"
        accept=".pdf,.docx,.pptx,.xlsx,.txt,.md,.csv"
        className={styles.fileInput}
        aria-label="选择课程资料"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file, uploadTargetSubjectId);
        }}
      />

      <div className={styles.container}>
        {/* 顶栏：左标题「资料库」，右筛选浮层 + 网格/列表切换 + 搜索框 + 新建/上传按钮 */}
        <header className={styles.header}>
          <h1 id="materials-title" className={styles.title}>资料库</h1>

          <div className={styles.toolbar}>
            {/* 筛选下拉框（参照图 3） */}
            <div className={styles.menuAnchor} ref={filterRef}>
              <button
                type="button"
                className={cx(styles.iconBtn, (kindFilter !== "all" || scopeFilter !== "all" || filterOpen) && styles.iconBtnActive)}
                onClick={() => setFilterOpen((v) => !v)}
                aria-expanded={filterOpen}
                aria-label="筛选资料"
                title="筛选"
              >
                <ListFilter size={15} />
              </button>
              {filterOpen && (
                <div className={styles.filterPopover} role="menu" aria-label="筛选条件">
                  <p className={styles.popoverGroupTitle}>文件类型</p>
                  {([
                    ["all", "全部类型"],
                    ["pdf", "PDF 文件"],
                    ["md", "Markdown 文档"],
                    ["txt", "纯文本 (TXT)"],
                  ] as const).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      role="menuitemradio"
                      aria-checked={kindFilter === k}
                      className={cx(styles.popoverItem, kindFilter === k && styles.popoverItemOn)}
                      onClick={() => setKindFilter(k)}
                    >
                      <span>{label}</span>
                      {kindFilter === k && <Check size={13} aria-hidden />}
                    </button>
                  ))}

                  <p className={styles.popoverGroupTitle}>来源归属</p>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={scopeFilter === "all"}
                    className={cx(styles.popoverItem, scopeFilter === "all" && styles.popoverItemOn)}
                    onClick={() => setScopeFilter("all")}
                  >
                    <span>全部来源</span>
                    {scopeFilter === "all" && <Check size={13} aria-hidden />}
                  </button>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={scopeFilter === "general"}
                    className={cx(styles.popoverItem, scopeFilter === "general" && styles.popoverItemOn)}
                    onClick={() => setScopeFilter("general")}
                  >
                    <span>通用资料（全局共享）</span>
                    {scopeFilter === "general" && <Check size={13} aria-hidden />}
                  </button>
                  {subjects.map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={scopeFilter === sub.id}
                      className={cx(styles.popoverItem, scopeFilter === sub.id && styles.popoverItemOn)}
                      onClick={() => setScopeFilter(sub.id)}
                    >
                      <span className={styles.popoverSubName}>{sub.name}</span>
                      {scopeFilter === sub.id && <Check size={13} aria-hidden />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 网格 / 列表视图切换器（参照图 2/3/4） */}
            <div className={styles.viewSwitch} role="radiogroup" aria-label="视图模式">
              <button
                type="button"
                role="radio"
                aria-checked={viewMode === "grid"}
                className={cx(styles.viewBtn, viewMode === "grid" && styles.viewBtnActive)}
                onClick={() => setViewMode("grid")}
                aria-label="网格视图"
                title="网格视图"
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={viewMode === "list"}
                className={cx(styles.viewBtn, viewMode === "list" && styles.viewBtnActive)}
                onClick={() => setViewMode("list")}
                aria-label="列表视图"
                title="列表视图"
              >
                <List size={14} />
              </button>
            </div>

            {/* 搜索框（支持筛选文件名 + 按 Enter 检索全文片段） */}
            <form className={styles.searchBox} onSubmit={(e) => void searchContent(e)} role="search">
              <Search size={13} aria-hidden />
              <input
                aria-label="搜索资料库"
                placeholder="搜索资料库…"
                value={query}
                maxLength={600}
                onChange={(event) => {
                  generation.current += 1;
                  setQuery(event.target.value);
                  setSearched(false);
                  setResults([]);
                }}
              />
              {query && (
                <button
                  type="button"
                  className={styles.clearSearchBtn}
                  onClick={() => {
                    setQuery("");
                    setSearched(false);
                    setResults([]);
                  }}
                  aria-label="清空搜索"
                >
                  <X size={12} />
                </button>
              )}
            </form>

            {/* 上传 / 新建按钮（参照图 2/3/4 右上角实心胶囊按钮 `新建 ∨`） */}
            <div className={styles.menuAnchor} ref={uploadMenuRef}>
              <button
                type="button"
                className={styles.uploadPillBtn}
                disabled={Boolean(operation) || loading}
                onClick={() => {
                  if (subjects.length > 0) {
                    setUploadMenuOpen((v) => !v);
                  } else {
                    triggerUpload(undefined);
                  }
                }}
              >
                <span>{operation === "upload" ? "解析中…" : "上传"}</span>
                {subjects.length > 0 ? <ChevronDown size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
              </button>

              {uploadMenuOpen && (
                <div className={styles.uploadPopover} role="menu" aria-label="选择上传归属">
                  <p className={styles.popoverGroupTitle}>上传至</p>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.popoverItem}
                    onClick={() => triggerUpload(undefined)}
                  >
                    <Upload size={13} aria-hidden />
                    <span>通用资料（所有对话可检索）</span>
                  </button>
                  {subjects.map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      role="menuitem"
                      className={styles.popoverItem}
                      onClick={() => triggerUpload(sub.id)}
                    >
                      <Folder size={13} style={{ color: sub.color }} aria-hidden />
                      <span className={styles.popoverSubName}>{sub.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* 分类胶囊行（参照图 2/3/4 的 `推荐 收藏 文件夹 图像 全部`） */}
        <div className={styles.categoryRow} role="tablist" aria-label="资料分类">
          {categoryPills.map((pill) => (
            <button
              key={pill.id}
              type="button"
              role="tab"
              aria-selected={pill.active}
              className={cx(styles.categoryPill, pill.active && styles.categoryPillActive)}
              onClick={pill.onSelect}
            >
              {pill.label}
            </button>
          ))}
        </div>

        {error && (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => { setError(null); void refresh(); }}>
              重试
            </button>
          </div>
        )}
        {notice && (
          <p className={styles.noticeBanner} role="status">
            {notice}
          </p>
        )}

        {/* 当输入了搜索词时，可一键检索资料内部原文片段 */}
        {query.trim() && !searched && operation !== "search" && (
          <div className={styles.deepSearchPrompt}>
            <span>想在所有资料的正文里查找“{query.trim()}”？</span>
            <button type="button" onClick={() => void searchContent()}>
              全文检索原文片段 →
            </button>
          </div>
        )}

        {operation === "search" && <p className={styles.statusText}>正在检索资料中的相关原文…</p>}
        {searched && results.length === 0 && (
          <p className={styles.statusText}>没有在资料正文中找到与“{query.trim()}”匹配的片段。</p>
        )}
        {results.length > 0 && (
          <section className={styles.resultsSection} aria-label="原文检索结果">
            <div className={styles.resultsHead}>
              <h3>匹配到的原文片段 ({results.length})</h3>
              <button type="button" onClick={() => { setResults([]); setSearched(false); }}>
                收起结果
              </button>
            </div>
            <div className={styles.resultsList}>
              {results.map((source) => (
                <article className={styles.resultCard} key={source.id}>
                  <div className={styles.resultMeta}>
                    <strong>{source.title}</strong>
                    <span>{sourceLocation(source)}</span>
                  </div>
                  <blockquote>{source.excerpt}</blockquote>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* 主体区域：空状态 vs 网格卡片视图（图 3/4） vs 列表视图（图 2） */}
        {!enabled ? (
          <div className={styles.emptyCard}>
            <BookOpen size={22} aria-hidden />
            <h2>连接后端后可使用资料库</h2>
            <p>支持上传 PDF、Markdown、TXT 讲义或笔记，对话时 AI 会自动检索并引用相关段落。</p>
          </div>
        ) : loading && documents.length === 0 ? (
          <p className={styles.statusText}>正在加载资料库…</p>
        ) : documents.length === 0 ? (
          <div className={styles.emptyCard}>
            <BookOpen size={22} aria-hidden />
            <h2>资料库还是空的</h2>
            <p>
              拖入或点击右上角「上传」添加 PDF、Markdown 或 TXT 讲义（单份最大 5 MB）。通用资料在所有对话中生效，空间专属资料仅在对应学习空间内检索。
            </p>
            <button type="button" className={styles.uploadPillBtn} onClick={() => triggerUpload(undefined)}>
              <Plus size={14} aria-hidden />
              <span>上传第一份资料</span>
            </button>
          </div>
        ) : filteredDocs.length === 0 ? (
          <p className={styles.statusText}>当前筛选条件下没有匹配的资料。</p>
        ) : viewMode === "grid" ? (
          /* 网格卡片视图（严格对齐图 3 & 图 4） */
          <div className={styles.cardGrid}>
            {filteredDocs.map((doc) => {
              const space = doc.subjectId ? subjectMap[doc.subjectId] : null;
              return (
                <article
                  key={doc.id}
                  className={cx(styles.gridCard, menuDocId === doc.id && styles.cardMenuOpen)}
                >
                  <div className={styles.gridCardTop}>
                    <FileKindIcon kind={doc.kind} size="sm" />
                    <span className={styles.gridCardTitle} title={doc.title}>
                      {doc.title}
                    </span>
                    <button
                      type="button"
                      className={styles.cardMoreBtn}
                      aria-label={`${doc.title} 更多操作`}
                      onClick={() => setMenuDocId(menuDocId === doc.id ? null : doc.id)}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>

                  <div
                    className={styles.gridCardCenter}
                    onClick={() => {
                      const baseTitle = doc.title.replace(/\.(pdf|md|txt)$/i, "");
                      setQuery(baseTitle);
                      void searchContent(undefined, baseTitle);
                    }}
                    title="点击预览文档片段"
                  >
                    <FileKindIcon kind={doc.kind} size="lg" />
                  </div>

                  <div className={styles.gridCardFoot}>
                    <span className={styles.scopeBadge}>
                      {space ? space.name : "通用"}
                    </span>
                    <span>
                      {doc.pageCount > 0 ? `${doc.pageCount} 页` : `${doc.chunkCount} 段`}
                    </span>
                  </div>

                  {menuDocId === doc.id && (
                    <div className={styles.docMenu} role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const baseTitle = doc.title.replace(/\.(pdf|md|txt)$/i, "");
                          setMenuDocId(null);
                          setQuery(baseTitle);
                          void searchContent(undefined, baseTitle);
                        }}
                      >
                        检索内容片段
                      </button>
                      {confirmId === doc.id ? (
                        <button
                          type="button"
                          role="menuitem"
                          className={styles.dangerItem}
                          disabled={Boolean(operation)}
                          onClick={() => void remove(doc)}
                        >
                          {operation === "delete" ? "删除中…" : "确认删除"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          className={styles.dangerItem}
                          onClick={() => setConfirmId(doc.id)}
                        >
                          <Trash2 size={13} aria-hidden />
                          <span>删除资料</span>
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          /* 列表视图（严格对齐图 2） */
          <div className={styles.listTable}>
            <div className={styles.listHead}>
              <span>名称</span>
              <span>最近活动时间</span>
            </div>
            <ul className={styles.listBody}>
              {filteredDocs.map((doc) => {
                const space = doc.subjectId ? subjectMap[doc.subjectId] : null;
                return (
                  <li key={doc.id} className={cx(styles.listRow, menuDocId === doc.id && styles.cardMenuOpen)}>
                    <div
                      className={styles.listRowMain}
                      onClick={() => {
                        const baseTitle = doc.title.replace(/\.(pdf|md|txt)$/i, "");
                        setQuery(baseTitle);
                        void searchContent(undefined, baseTitle);
                      }}
                    >
                      <FileKindIcon kind={doc.kind} size="sm" />
                      <span className={styles.listRowTitle}>{doc.title}</span>
                      <span className={styles.scopeBadge}>{space ? space.name : "通用"}</span>
                      <span className={styles.listRowChunks}>
                        {doc.pageCount > 0 ? `${doc.pageCount} 页 · ` : ""}
                        {doc.chunkCount} 片段
                      </span>
                    </div>

                    <div className={styles.listRowRight}>
                      <span className={styles.listRowTime}>{formatRelativeTime(doc.createdAt)}</span>
                      <button
                        type="button"
                        className={styles.rowMoreBtn}
                        aria-label={`${doc.title} 更多操作`}
                        onClick={() => setMenuDocId(menuDocId === doc.id ? null : doc.id)}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </div>

                    {menuDocId === doc.id && (
                      <div className={styles.docMenu} role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            const baseTitle = doc.title.replace(/\.(pdf|md|txt)$/i, "");
                            setMenuDocId(null);
                            setQuery(baseTitle);
                            void searchContent(undefined, baseTitle);
                          }}
                        >
                          检索内容片段
                        </button>
                        {confirmId === doc.id ? (
                          <button
                            type="button"
                            role="menuitem"
                            className={styles.dangerItem}
                            disabled={Boolean(operation)}
                            onClick={() => void remove(doc)}
                          >
                            {operation === "delete" ? "删除中…" : "确认删除"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            role="menuitem"
                            className={styles.dangerItem}
                            onClick={() => setConfirmId(doc.id)}
                          >
                            <Trash2 size={13} aria-hidden />
                            <span>删除资料</span>
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

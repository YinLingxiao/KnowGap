"use client";

/**
 * 资料库右侧预览面板。
 *
 * 安全设计（务必保持，不要图省事改掉）：
 * - docx 用沙箱 iframe（sandbox="allow-scripts"，不带 allow-same-origin）渲染，iframe 拿到
 *   opaque origin，内部脚本执行完全被隔离，即使被恶意构造的 docx 触发了脚本也拿不到父页面的
 *   localStorage（认证 token 在那里）、cookie 或 DOM。iframe 内容用 srcdoc 整个写入，不走 src。
 * - xlsx / csv 不用 SheetJS 的 sheet_to_html（它的输出不转义单元格内容，真实存在过 CVE-2026-44549
 *   这种存储型 XSS），改用 sheet_to_json 拿纯数组数据，自己拼 <table>，交给 React 的文本节点自动转义。
 * - md 复用 chat/Markdown.tsx 的 Markdown 组件，它基于 ReactMarkdown，明确不渲染原始 HTML。
 * - pptx 用 @meshesha/pptxjs 渲染成 HTML/SVG（见 lib/materials/pptx.ts），放进 sandbox="" + CSP 的 iframe，
 *   不执行脚本、不加载外部资源；渲染失败时回退到文字版。
 * - 旧版 .doc/.ppt 和原件丢失的资料走「文字版」：展示上传时后端已提取的纯文本，界面明确标注。
 *
 * 兼容性兜底：PDF 的 pdf.js 渲染失败时切到浏览器自带查看器；docx / pptx 解析失败时切到文字版；
 * 任何格式都保留下载入口，不让一种渲染器的问题把资料变成白屏。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download, FileSpreadsheet, FileText, FileType, Maximize2, Minimize2, Presentation, TriangleAlert, X,
} from "lucide-react";
import { createMaterialClient, type ExtractedText } from "@/lib/api/material-client";
import { toApiError } from "@/lib/api/errors";
import { cx } from "@/lib/cx";
import { clampPptxScale, pptxFrameDocument, renderPptxDocument, type RenderedPptx } from "@/lib/materials/pptx";
import type { CourseMaterial } from "@/lib/types";
import { Markdown, type CitationPreviewTarget } from "./chat/Markdown";
import { useI18n } from "@/components/LanguageProvider";
import styles from "./MaterialPreviewPanel.module.css";

// 比后端 MAX_UPLOAD_BYTES（100 MB）保守得多：docx-preview / pdf.js 在大文件、
// 多图片文档上会在主线程产生明显卡顿，这个阈值不是精确基准测试得出的，只是经验性的安全余量，
// 如果实测发现偏大偏小可以调整。
const DEGRADE_BYTES = { pdf: 12 * 1024 * 1024, office: 8 * 1024 * 1024 } as const;

// 预览只逐页铺 canvas，几百页的 PDF 会吃掉大量内存，超出的部分请下载查看。
const MAX_PDF_PAGES = 100;

export function normalizeInitialPage(page?: number | null): number {
  return typeof page === "number" && Number.isInteger(page) && page > 0 ? page : 1;
}

export function pdfPagesToRender(pageCount: number, initialPage?: number): readonly number[] {
  if (!Number.isInteger(pageCount) || pageCount <= 0) return [];
  const count = Math.floor(pageCount);
  const target = Math.min(normalizeInitialPage(initialPage), count);
  const pages = Array.from({ length: Math.min(count, MAX_PDF_PAGES) }, (_, index) => index + 1);
  if (!pages.includes(target)) pages.push(target);
  return pages;
}

export function worksheetIndex(initialPage: number | undefined, sheetCount: number): number | null {
  if (!Number.isInteger(sheetCount) || sheetCount <= 0) return null;
  return Math.min(normalizeInitialPage(initialPage), Math.floor(sheetCount)) - 1;
}

const TITLE_ICON = { docx: FileType, pptx: Presentation, xlsx: FileSpreadsheet } as const;

/** 导出供单测直接调用，不需要真实 DOM/网络就能验证分发逻辑。 */
export function degradeThreshold(kind: CourseMaterial["kind"]): number {
  return kind === "pdf" ? DEGRADE_BYTES.pdf : DEGRADE_BYTES.office;
}

/** OLE 复合文档（旧版 .doc/.ppt/.xls）魔数检测，和后端 materials.py 的判断逻辑一致。
 *  Material.kind 上传时已经被记成新格式名，这里要看字节本身，不能只信 kind 字段。 */
export function isLegacyOle(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/** 预览分发：pdf.js / docx-preview（沙箱 iframe） / SheetJS（安全表格） / PPTX 文字版 / 提取文字。
 *  导出成纯函数方便单测；真实渲染组件内部也调这个来决定走哪条分支。 */
export type PreviewMode = "pdf" | "markdown" | "text" | "csv" | "xlsx" | "pptx" | "docx" | "extracted";

export function previewMode(
  kind: CourseMaterial["kind"], legacy: boolean,
): PreviewMode {
  if (kind === "pdf") return "pdf";
  if (kind === "md") return "markdown";
  if (kind === "txt") return "text";
  if (kind === "csv") return "csv";
  if (kind === "xlsx") return "xlsx"; // SheetJS 原生支持旧版 .xls（BIFF8），不需要特殊处理
  // 新版 .pptx 是 ZIP（OOXML），可以读出文字版幻灯片；旧版 .ppt 是 OLE 二进制，只能看提取文字
  if (kind === "pptx") return legacy ? "extracted" : "pptx";
  // 新版 .docx 走 docx-preview；旧版 .doc 是 OLE 二进制，docx-preview 解析不了
  return legacy ? "extracted" : "docx";
}

type RenderState =
  | { status: "loading" }
  | { status: "degraded" }
  | { status: "error"; message: string }
  | { status: "ready"; bytes: ArrayBuffer; legacy: boolean };

const LOADING: RenderState = { status: "loading" };

function useMaterialBytes(material: CourseMaterial | null): RenderState {
  // 结果带上它属于哪份资料：切换资料后的第一帧 effect 还没跑，不能把上一份的字节交给新资料的渲染分支。
  const [result, setResult] = useState<{ id: string; state: RenderState } | null>(null);
  const client = useMemo(() => createMaterialClient(), []);

  useEffect(() => {
    if (!material) return;
    let cancelled = false;
    const { id } = material;
    if (material.sizeBytes > degradeThreshold(material.kind)) {
      setResult({ id, state: { status: "degraded" } });
      return;
    }
    (async () => {
      try {
        const blob = await client.downloadBytes(id);
        if (cancelled) return;
        const buffer = await blob.arrayBuffer();
        if (cancelled) return;
        setResult({ id, state: { status: "ready", bytes: buffer, legacy: isLegacyOle(new Uint8Array(buffer.slice(0, 4))) } });
      } catch (failure) {
        if (!cancelled) setResult({ id, state: { status: "error", message: toApiError(failure).message } });
      }
    })();
    return () => { cancelled = true; };
  }, [material, client]);

  return result && result.id === material?.id ? result.state : LOADING;
}

type CitationMaterialState =
  | { status: "loading"; material: null }
  | { status: "ready"; material: CourseMaterial }
  | { status: "missing"; material: null };

function useCitationMaterial(citation?: CitationPreviewTarget): CitationMaterialState {
  const client = useMemo(() => createMaterialClient(), []);
  const [result, setResult] = useState<{ id: string; state: CitationMaterialState } | null>(null);
  useEffect(() => {
    if (!citation) return;
    let cancelled = false;
    const id = citation.documentId;
    if (!id.trim()) {
      setResult({ id, state: { status: "missing", material: null } });
      return () => { cancelled = true; };
    }
    client.list().then((materials) => {
      if (cancelled) return;
      const material = materials.find((item) => item.id === id);
      setResult({ id, state: material ? { status: "ready", material } : { status: "missing", material: null } });
    }).catch(() => {
      if (!cancelled) setResult({ id, state: { status: "missing", material: null } });
    });
    return () => { cancelled = true; };
  }, [citation, client]);
  if (!citation) return { status: "loading", material: null };
  return result?.id === citation.documentId ? result.state : { status: "loading", material: null };
}

/** UTF-8 优先；不是合法 UTF-8 时按 GB18030 解（Excel 在中文 Windows 上导出的 CSV 默认是 GBK），去掉 BOM。 */
export function decodeText(bytes: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("gb18030").decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 支持双引号包裹、字段内逗号/换行、"" 转义的最小 CSV 解析；空行跳过。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") endRow();
    else if (char !== "\r") cell += char;
  }
  endRow();
  return rows;
}

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function DownloadButton({ material }: { material: CourseMaterial }) {
  const { tx } = useI18n();
  const client = useMemo(() => createMaterialClient(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={styles.state}>
      <FileText size={28} aria-hidden />
      <p>{error ?? tx("文件较大，建议下载后用本地程序查看。")}</p>
      <button
        type="button"
        className={styles.downloadBtn}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const blob = await client.downloadBytes(material.id);
            await saveBlob(blob, material.title);
          } catch (failure) {
            setError(toApiError(failure).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download size={14} aria-hidden />
        <span>{busy ? tx("下载中…") : tx("下载查看")}</span>
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ PDF

function PdfView({ bytes, initialPage, fullscreen, material }: {
  bytes: ArrayBuffer;
  initialPage?: number;
  fullscreen?: boolean;
  material: CourseMaterial;
}) {
  const { t, tx } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncatedAt, setTruncatedAt] = useState<number | null>(null);
  const [nativeUrl, setNativeUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;
    host.replaceChildren();
    setError(null);
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
        // bytes 可能被 React 严格模式下的重复 effect 或其他读取者转移，复制一份给 pdf.js 专用。
        const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
        if (cancelled) return;
        const target = Math.min(normalizeInitialPage(initialPage), doc.numPages);
        if (doc.numPages > MAX_PDF_PAGES) setTruncatedAt(doc.numPages);
        else setTruncatedAt(null);
        for (const number of pdfPagesToRender(doc.numPages, target)) {
          const page = await doc.getPage(number);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: fullscreen ? 1.8 : 1.3 });
          const canvas = document.createElement("canvas");
          canvas.className = styles.pdfPage;
          canvas.dataset.pageNumber = String(number);
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d");
          if (!context) continue;
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          if (cancelled) return;
          host.append(canvas);
          if (number === target) canvas.scrollIntoView({ block: "start" });
        }
      } catch {
        if (!cancelled) setError(tx("PDF 无法渲染，请下载后查看。"));
      }
    })();
    return () => { cancelled = true; };
  }, [bytes, initialPage, fullscreen, tx]);

  // pdf.js 失败（worker 被拦、PDF 结构损坏、浏览器太旧）时交给浏览器自带的 PDF 查看器。
  // Blob URL 只指向用户自己的文件，不会发起跨站请求；不支持内置查看器的环境仍可下载。
  useEffect(() => {
    if (!error) {
      setNativeUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(new Blob([bytes.slice(0)], { type: "application/pdf" }));
    setNativeUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [error, bytes]);

  if (error) {
    return (
      <div>
        <p className={styles.outlineBanner}>
          <TriangleAlert size={14} aria-hidden />
          {tx("内置 PDF 渲染器不可用，已切换到浏览器自带的查看器。")}
        </p>
        {nativeUrl && (
          <iframe
            className={styles.pdfNative}
            src={nativeUrl}
            title={tx("PDF 预览")}
          />
        )}
        <p className={styles.statusHint}>{tx("若下方空白，请下载后用本地程序查看。")}</p>
        <div className={styles.fallbackActions}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => void saveBlob(new Blob([bytes.slice(0)], { type: "application/pdf" }), material.title)}
          >
            <Download size={14} aria-hidden />
            <span>{tx("下载查看")}</span>
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {truncatedAt && (
        <p className={styles.outlineBanner}>
          <TriangleAlert size={14} aria-hidden />
          {normalizeInitialPage(initialPage) > MAX_PDF_PAGES && normalizeInitialPage(initialPage) <= truncatedAt
            ? t("sources.pdfTruncatedWithTarget", { pages: truncatedAt, max: MAX_PDF_PAGES, target: normalizeInitialPage(initialPage) })
            : tx("共 {pages} 页，仅预览前 {max} 页，完整内容请下载查看", { pages: truncatedAt, max: MAX_PDF_PAGES })}
        </p>
      )}
      <div ref={hostRef} className={styles.pdfPages} aria-label={tx("PDF 预览")} />
    </>
  );
}

// ------------------------------------------------------------------ DOCX（沙箱 iframe）

/** iframe 内自包含的页面：不带任何外部 <script src>——opaque origin 的 iframe 去加载同站
 *  /vendor 下的脚本，在部分浏览器里会被本地网络访问限制直接拦掉（实测加载失败，docx 一直
 *  报「无法渲染」）。所以 jszip + docx-preview（UMD 版）的脚本文本由父页面取好，连同文件字节
 *  一起经 message 传进来，iframe 里再执行并渲染。
 *  sandbox="allow-scripts" 不带 allow-same-origin：iframe 是 opaque origin，脚本能跑，
 *  但读不到父页面的 cookie / localStorage / DOM，postMessage 的 targetOrigin 只能是 "*"，
 *  这里传的只是脚本文本和文件字节，不是敏感数据，可以接受。 */
const DOCX_IFRAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  /* opaque origin 无法继承父页面 CSS 变量；此固定字体栈需与 --font-read 对应栈人工保持一致。 */
  body { margin: 0; padding: 12px; font-family: "Source Serif 4 Variable", "Source Serif 4", "Noto Serif SC Variable", "Songti SC", "STSong", Georgia, serif; }
  .docx-wrapper { background: transparent !important; }
</style></head>
<body>
  <div id="styles"></div>
  <div id="container"></div>
  <script>
    function locateCitation(initialPage, quote) {
      var container = document.getElementById("container");
      var sections = Array.from(container.querySelectorAll("section.docx"));
      if (!sections.length) return;
      var target = null;
      if (quote) {
        var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        var textNode;
        while ((textNode = walker.nextNode())) {
          if (textNode.nodeValue && textNode.nodeValue.indexOf(quote) !== -1) {
            target = textNode.parentElement.closest("section.docx") || textNode.parentElement;
            break;
          }
        }
      }
      target = target || sections[Math.min(Math.max(initialPage - 1, 0), sections.length - 1)];
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "start" });
    }
    window.addEventListener("message", async function (event) {
      if (event.source !== window.parent) return;
      if (event.data && event.data.docxLocate) {
        locateCitation(event.data.initialPage, event.data.quote || "");
        return;
      }
      try {
        event.data.scripts.forEach(function (code) { (0, eval)(code); });
        await window.docx.renderAsync(
          event.data.bytes,
          document.getElementById("container"),
          document.getElementById("styles"),
          { inWrapper: true, ignoreWidth: false, className: "docx" },
        );
        locateCitation(event.data.initialPage, event.data.quote || "");
        window.parent.postMessage({ docxPreview: "ready" }, "*");
      } catch (error) {
        window.parent.postMessage({ docxPreview: "error" }, "*");
      }
    });
  </script>
</body></html>`;

/** jszip 必须先于 docx-preview 执行（后者读全局 JSZip）。同站取回，浏览器会缓存。 */
const DOCX_SCRIPTS = ["/vendor/jszip.min.js", "/vendor/docx-preview.min.js"];

async function loadDocxScripts(): Promise<string[]> {
  return Promise.all(DOCX_SCRIPTS.map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }));
}

function DocxView({ bytes, initialPage = 1, quote = "", onFallback }: {
  bytes: ArrayBuffer;
  initialPage?: number;
  quote?: string;
  onFallback?: () => void;
}) {
  const { tx } = useI18n();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    let loaded = false;
    let cancelled = false;
    const scripts = loadDocxScripts();
    scripts.catch(() => { if (!cancelled) setError(true); });
    const onLoad = () => {
      loaded = true;
      scripts.then((code) => {
        if (!cancelled) frame.contentWindow?.postMessage({ scripts: code, bytes, initialPage: normalizeInitialPage(initialPage), quote }, "*");
      }).catch(() => undefined);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if (event.data?.docxPreview === "error") setError(true);
    };
    frame.addEventListener("load", onLoad);
    window.addEventListener("message", onMessage);
    // srcdoc 赋值触发一次新的 load；如果 iframe 之前已经加载过同一份 srcdoc（React 严格模式
    // 下的重复 effect），浏览器可能不会重新触发 load 事件，这里主动兜底一次。
    if (frame.contentDocument?.readyState === "complete" && !loaded) onLoad();
    return () => {
      cancelled = true;
      frame.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
    };
  }, [bytes, initialPage, quote]);

  return (
    <>
      {error && (
        <div className={styles.state}>
          <TriangleAlert size={24} aria-hidden />
          <p>{tx("这份文档无法渲染（可能是旧版格式或文件已损坏），请下载后查看。")}</p>
          {onFallback && (
            <button type="button" className={styles.secondaryBtn} onClick={onFallback}>
              <FileText size={14} aria-hidden />
              <span>{tx("查看提取文字")}</span>
            </button>
          )}
        </div>
      )}
      <iframe
        ref={frameRef}
        className={styles.docxFrame}
        style={error ? { display: "none" } : undefined}
        sandbox="allow-scripts"
        srcDoc={DOCX_IFRAME_HTML}
        title={tx("Word 文档预览")}
      />
    </>
  );
}

// ------------------------------------------------------------------ XLSX / CSV（安全表格）

function SheetTable({ rows }: { rows: string[][] }) {
  const { tx } = useI18n();
  if (rows.length === 0) return <p className={styles.plainText}>{tx("（空工作表）")}</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.sheetTable}>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function XlsxView({ bytes, initialPage }: { bytes: ArrayBuffer; initialPage?: number }) {
  const { tx } = useI18n();
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setActive(worksheetIndex(initialPage, sheets?.length ?? 0) ?? 0);
  }, [initialPage, sheets]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(bytes, { type: "array" });
        if (cancelled) return;
        setSheets(workbook.SheetNames.map((name) => ({
          name,
          // 明确不用 sheet_to_html：它生成的字符串不转义单元格内容，直接插入 DOM 有 XSS 风险
          // （真实案例见 CVE-2026-44549）。sheet_to_json 只给纯数据，交给 React 自动转义渲染。
          rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, raw: false })
            .map((row) => row.map((cell) => (cell == null ? "" : String(cell)))),
        })));
      } catch {
        if (!cancelled) setError(tx("表格无法解析，请下载后查看。"));
      }
    })();
    return () => { cancelled = true; };
  }, [bytes, tx]);

  if (error) return <div className={styles.state}><TriangleAlert size={24} aria-hidden /><p>{error}</p></div>;
  if (!sheets) return <p className={styles.plainText}>{tx("正在解析表格…")}</p>;
  return (
    <div>
      {sheets.length > 1 && (
        <div className={styles.sheetTabs} role="tablist" aria-label={tx("工作表")}>
          {sheets.map((sheet, index) => (
            <button
              key={sheet.name}
              type="button"
              role="tab"
              aria-selected={index === active}
              className={cx(styles.sheetTab, index === active && styles.sheetTabActive)}
              onClick={() => setActive(index)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}
      <SheetTable rows={sheets[active]?.rows ?? []} />
    </div>
  );
}

function CsvView({ bytes }: { bytes: ArrayBuffer }) {
  const rows = useMemo(() => parseCsv(decodeText(bytes)), [bytes]);
  return <SheetTable rows={rows} />;
}

// ------------------------------------------------------------------ PPTX 视觉预览 / 提取文字兜底

function PptxView({ bytes, material, initialPage, quote, citationMode = false }: {
  bytes: ArrayBuffer;
  material: CourseMaterial;
  initialPage?: number;
  quote?: string;
  citationMode?: boolean;
}) {
  const { tx } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<RenderedPptx | null>(null);
  const [failed, setFailed] = useState(false);
  const [textView, setTextView] = useState(false);
  const [stageWidth, setStageWidth] = useState(0);
  // 引用预览只渲染被引用的那一页，避免长课件无谓地全量渲染。
  const onlySlide = citationMode && initialPage ? normalizeInitialPage(initialPage) : undefined;

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setFailed(false);
    setTextView(false);
    renderPptxDocument(bytes, { slides: onlySlide ? [onlySlide] : undefined })
      .then((value) => { if (!cancelled) setDoc(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [bytes, onlySlide]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || textView || failed) return undefined;
    const update = () => setStageWidth(stage.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [doc, failed, textView]);

  const scale = doc ? clampPptxScale(stageWidth || 380, doc.width) : 1;
  const frameDocument = useMemo(() => (doc ? pptxFrameDocument(doc.html, scale) : ""), [doc, scale]);

  if (failed) {
    return <ExtractedTextView material={material} initialPage={initialPage} quote={quote} citationMode={citationMode}
      reason={tx("幻灯片视觉渲染失败，下面显示提取的文字。")} />;
  }
  if (!doc) return <p className={styles.plainText}>{tx("正在渲染幻灯片…")}</p>;
  if (textView) {
    return (
      <div>
        <div className={styles.fallbackActions}>
          <button type="button" className={styles.secondaryBtn} onClick={() => setTextView(false)}>
            {tx("返回幻灯片")}
          </button>
        </div>
        <ExtractedTextView material={material} initialPage={initialPage} quote={quote} citationMode={citationMode} />
      </div>
    );
  }
  return (
    <div>
      <p className={styles.outlineBanner}>
        <TriangleAlert size={14} aria-hidden />
        {tx("幻灯片预览：文字、图片和形状按原位置渲染，复杂动画与部分字体可能和 PowerPoint 不同。")}
      </p>
      <div ref={stageRef} className={styles.pptxStage}>
        <iframe
          className={styles.pptxFrame}
          sandbox=""
          srcDoc={frameDocument}
          title={tx("PowerPoint 预览")}
        />
      </div>
      <div className={styles.fallbackActions}>
        <button type="button" className={styles.secondaryBtn} onClick={() => setTextView(true)}>
          <FileText size={14} aria-hidden />
          <span>{tx("文字版")}</span>
        </button>
      </div>
    </div>
  );
}

function ExtractedTextView({ material, initialPage, quote, reason, citationMode = false }: {
  material: CourseMaterial;
  initialPage?: number;
  quote?: string;
  reason?: string;
  citationMode?: boolean;
}) {
  const { t, tx } = useI18n();
  const client = useMemo(() => createMaterialClient(), []);
  const hostRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ExtractedText | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    client.text(material.id)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((failure: unknown) => { if (!cancelled) setError(toApiError(failure).message); });
    return () => { cancelled = true; };
  }, [client, material.id]);

  useEffect(() => {
    if (!data || !hostRef.current) return;
    const sections = [...hostRef.current.querySelectorAll<HTMLElement>("[data-extracted-page]")];
    if (sections.length === 0) return;
    const quoted = quote?.trim()
      ? sections.findIndex((section) => section.textContent?.includes(quote))
      : -1;
    const targetPage = normalizeInitialPage(initialPage);
    const byNumber = sections.findIndex((section) => Number(section.dataset.page ?? "") === targetPage);
    const index = quoted >= 0 ? quoted : byNumber >= 0 ? byNumber : Math.min(targetPage, sections.length) - 1;
    sections[index]?.scrollIntoView({ block: "start" });
  }, [data, initialPage, quote]);

  return (
    <div>
      <p className={styles.outlineBanner}>
        <TriangleAlert size={14} aria-hidden />
        {reason ?? tx("文字版预览：只显示提取到的文字，版式与图片请下载查看。")}
      </p>
      {error ? (
        <p className={styles.plainText}>{citationMode ? t("sources.missing") : error}</p>
      ) : !data ? (
        <p className={styles.plainText}>{tx("正在加载文字…")}</p>
      ) : data.pages.length === 0 ? (
        <p className={styles.plainText}>{tx("没有可显示的文字。")}</p>
      ) : (
        <div ref={hostRef} className={styles.extractedPages}>
          {data.pages.map((page, index) => (
            <section
              key={index}
              className={styles.extractedPage}
              data-extracted-page
              data-page={page.page ?? ""}
            >
              {page.page !== null && <span className={styles.pageLabel}>#{page.page}</span>}
              <p className={styles.plainText}>{page.text}</p>
            </section>
          ))}
        </div>
      )}
      {data?.truncated && (
        <p className={styles.statusHint}>
          {tx("文字较多，仅显示前 {count} 字，完整内容请下载查看。", {
            count: data.pages.reduce((sum, page) => sum + page.text.length, 0),
          })}
        </p>
      )}
      {data?.notes.map((note, index) => (
        <p key={index} className={styles.statusHint}>{note}</p>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ 分发与面板外壳

function PreviewBody({ material, state, initialPage, quote, citationMode = false, fullscreen = false }: {
  material: CourseMaterial;
  state: RenderState;
  initialPage?: number;
  quote?: string;
  citationMode?: boolean;
  fullscreen?: boolean;
}) {
  const { t, tx } = useI18n();
  const [forceText, setForceText] = useState(false);

  useEffect(() => { setForceText(false); }, [material.id]);

  if (state.status === "loading") return <p className={styles.plainText}>{tx("正在加载…")}</p>;
  if (state.status === "error") {
    return (
      <div>
        <div className={styles.state} role="status">
          <TriangleAlert size={24} aria-hidden />
          <p>{citationMode ? t("sources.missing") : state.message}</p>
        </div>
        {!citationMode && (
          <ExtractedTextView material={material} initialPage={initialPage} quote={quote}
            reason={tx("读不到原件，下面显示上传时提取的文字。")} />
        )}
      </div>
    );
  }
  if (state.status === "degraded") {
    return (
      <div>
        <DownloadButton material={material} />
        <div className={styles.fallbackActions}>
          <button type="button" className={styles.secondaryBtn} onClick={() => setForceText((value) => !value)}>
            <FileText size={14} aria-hidden />
            <span>{forceText ? tx("收起提取文字") : tx("查看提取文字")}</span>
          </button>
        </div>
        {forceText && (
          <ExtractedTextView material={material} initialPage={initialPage} quote={quote} citationMode={citationMode}
            reason={tx("文件较大，不在应用里排版预览，下面显示上传时提取的文字。")} />
        )}
      </div>
    );
  }

  const { bytes, legacy } = state;
  if (forceText) {
    return <ExtractedTextView material={material} initialPage={initialPage} quote={quote} citationMode={citationMode} />;
  }
  switch (previewMode(material.kind, legacy)) {
    case "pdf": return <PdfView bytes={bytes} initialPage={initialPage} fullscreen={fullscreen} material={material} />;
    case "markdown": return <Markdown text={decodeText(bytes)} />;
    case "text": return <pre className={styles.plainText}>{decodeText(bytes)}</pre>;
    case "csv": return <CsvView bytes={bytes} />;
    case "xlsx": return <XlsxView bytes={bytes} initialPage={initialPage} />;
    case "pptx": return <PptxView bytes={bytes} material={material} initialPage={initialPage} quote={quote}
      citationMode={citationMode} />;
    case "extracted": return <ExtractedTextView material={material} initialPage={initialPage} quote={quote}
      citationMode={citationMode} />;
    case "docx": return <DocxView bytes={bytes} initialPage={initialPage} quote={quote} onFallback={() => setForceText(true)} />;
  }
}

type MaterialPreviewPanelProps = {
  initialPage?: number;
  quote?: string;
  onClose: () => void;
} & (
  | { material: CourseMaterial | null; citation?: never }
  | { material?: null; citation: CitationPreviewTarget }
);

export function MaterialPreviewPanel({ material: providedMaterial, citation, initialPage, quote, onClose }: MaterialPreviewPanelProps) {
  const { t, tx } = useI18n();
  const citationState = useCitationMaterial(citation);
  const material = citation ? citationState.material : providedMaterial;
  const state = useMaterialBytes(material ?? null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => { setFullscreen(false); }, [material?.id, citation?.documentId]);

  // 全屏时锁住页面滚动，Esc 先退出全屏；关闭面板或卸载时恢复原状。
  useEffect(() => {
    if (!fullscreen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setFullscreen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey, true);
    };
  }, [fullscreen]);

  if (!citation && !providedMaterial) return null;
  const Icon = material && material.kind in TITLE_ICON ? TITLE_ICON[material.kind as keyof typeof TITLE_ICON] : FileText;
  const title = citation?.title ?? material?.title ?? "";
  return (
    <aside
      className={cx(styles.panel, citation && styles.citationPanel, fullscreen && styles.panelFullscreen)}
      aria-label={citation ? t("sources.preview") : tx("资料预览")}
      aria-modal={fullscreen || undefined}
      role={fullscreen ? "dialog" : undefined}
    >
      <header className={styles.head}>
        <span className={styles.headTitle}>
          <Icon size={15} aria-hidden />
          {title}
        </span>
        <div className={styles.headActions}>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={fullscreen ? tx("退出全屏预览") : tx("全屏预览")}
            title={fullscreen ? tx("退出全屏预览") : tx("全屏预览")}
            aria-pressed={fullscreen}
            onClick={() => setFullscreen((value) => !value)}
          >
            {fullscreen ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
          </button>
          <button type="button" className={styles.iconBtn} aria-label={tx("关闭预览")} title={tx("关闭预览")} onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
      {quote?.trim() && <blockquote className={styles.quote} aria-label={t("sources.excerpt")}>{quote}</blockquote>}
      <div className={styles.body}>
        {citation && citationState.status === "missing" ? (
          <div className={styles.state} role="status"><TriangleAlert size={24} aria-hidden /><p>{t("sources.missing")}</p></div>
        ) : citation && citationState.status === "loading" ? (
          <p className={styles.plainText}>{tx("正在加载…")}</p>
        ) : material ? (
          <PreviewBody material={material} state={state} initialPage={initialPage} quote={quote}
            citationMode={Boolean(citation)} fullscreen={fullscreen} />
        ) : null}
      </div>
    </aside>
  );
}

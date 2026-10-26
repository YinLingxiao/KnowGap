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
 * - pptx 和旧版 .doc/.ppt 没有成熟的纯 JS 渲染库，统一走「大纲预览」：只展示后端已提取好的纯文字
 *   标题列表，经 React 渲染天然转义，不需要额外隔离，但必须在界面上明确标注，不能让人误以为是
 *   真实排版。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, FileText, FileType, Presentation, TriangleAlert, X } from "lucide-react";
import { createMaterialClient } from "@/lib/api/material-client";
import { toApiError } from "@/lib/api/errors";
import type { CourseMaterial } from "@/lib/types";
import { Markdown } from "./chat/Markdown";
import { cx } from "@/lib/cx";
import styles from "./MaterialPreviewPanel.module.css";

// 和后端 MAX_UPLOAD_BYTES（20MB）同一量级，但更保守：docx-preview / pdf.js 在大文件、
// 多图片文档上会在主线程产生明显卡顿，这个阈值不是精确基准测试得出的，只是经验性的安全余量，
// 如果实测发现偏大偏小可以调整。
const DEGRADE_BYTES = { pdf: 12 * 1024 * 1024, office: 8 * 1024 * 1024 } as const;

// 预览只逐页铺 canvas，几百页的 PDF 会吃掉大量内存，超出的部分请下载查看。
const MAX_PDF_PAGES = 100;

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

/** 预览分发：pdf.js / docx-preview（沙箱 iframe） / SheetJS（安全表格） / 大纲视图（pptx、旧版 doc·ppt）。
 *  导出成纯函数方便单测；真实渲染组件内部也调这个来决定走哪条分支。 */
export function previewMode(
  kind: CourseMaterial["kind"], legacy: boolean,
): "pdf" | "markdown" | "text" | "csv" | "xlsx" | "outline" | "docx" {
  if (kind === "pdf") return "pdf";
  if (kind === "md") return "markdown";
  if (kind === "txt") return "text";
  if (kind === "csv") return "csv";
  if (kind === "xlsx") return "xlsx"; // SheetJS 原生支持旧版 .xls（BIFF8），不需要特殊处理
  if (kind === "pptx") return "outline"; // 没有成熟的纯 JS pptx 渲染库
  return legacy ? "outline" : "docx"; // 旧版 .doc 是 OLE 二进制，docx-preview 解析不了
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
  const client = useMemo(() => createMaterialClient(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={styles.state}>
      <FileText size={28} aria-hidden />
      <p>{error ?? "文件较大，建议下载后用本地程序查看。"}</p>
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
        <span>{busy ? "下载中…" : "下载查看"}</span>
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ PDF

function PdfView({ bytes }: { bytes: ArrayBuffer }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncatedAt, setTruncatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;
    host.replaceChildren();
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
        // bytes 可能被 React 严格模式下的重复 effect 或其他读取者转移，复制一份给 pdf.js 专用。
        const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
        if (cancelled) return;
        if (doc.numPages > MAX_PDF_PAGES) setTruncatedAt(doc.numPages);
        for (let number = 1; number <= Math.min(doc.numPages, MAX_PDF_PAGES); number += 1) {
          const page = await doc.getPage(number);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1.3 });
          const canvas = document.createElement("canvas");
          canvas.className = styles.pdfPage;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d");
          if (!context) continue;
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          if (cancelled) return;
          host.append(canvas);
        }
      } catch {
        if (!cancelled) setError("PDF 无法渲染，请下载后查看。");
      }
    })();
    return () => { cancelled = true; };
  }, [bytes]);

  if (error) return <div className={styles.state}><TriangleAlert size={24} aria-hidden /><p>{error}</p></div>;
  return (
    <>
      {truncatedAt && (
        <p className={styles.outlineBanner}>
          <TriangleAlert size={14} aria-hidden />
          共 {truncatedAt} 页，仅预览前 {MAX_PDF_PAGES} 页，完整内容请下载查看
        </p>
      )}
      <div ref={hostRef} className={styles.pdfPages} aria-label="PDF 预览" />
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
  body { margin: 0; padding: 12px; font-family: sans-serif; }
  .docx-wrapper { background: transparent !important; }
</style></head>
<body>
  <div id="styles"></div>
  <div id="container"></div>
  <script>
    window.addEventListener("message", async function (event) {
      if (event.source !== window.parent) return;
      try {
        event.data.scripts.forEach(function (code) { (0, eval)(code); });
        await window.docx.renderAsync(
          event.data.bytes,
          document.getElementById("container"),
          document.getElementById("styles"),
          { inWrapper: true, ignoreWidth: false, className: "docx" },
        );
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

function DocxView({ bytes }: { bytes: ArrayBuffer }) {
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
        if (!cancelled) frame.contentWindow?.postMessage({ scripts: code, bytes }, "*");
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
  }, [bytes]);

  return (
    <>
      {error && (
        <div className={styles.state}>
          <TriangleAlert size={24} aria-hidden />
          <p>这份文档无法渲染（可能是旧版格式或文件已损坏），请下载后查看。</p>
        </div>
      )}
      <iframe
        ref={frameRef}
        className={styles.docxFrame}
        style={error ? { display: "none" } : undefined}
        sandbox="allow-scripts"
        srcDoc={DOCX_IFRAME_HTML}
        title="Word 文档预览"
      />
    </>
  );
}

// ------------------------------------------------------------------ XLSX / CSV（安全表格）

function SheetTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return <p className={styles.plainText}>（空工作表）</p>;
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

function XlsxView({ bytes }: { bytes: ArrayBuffer }) {
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
        if (!cancelled) setError("表格无法解析，请下载后查看。");
      }
    })();
    return () => { cancelled = true; };
  }, [bytes]);

  if (error) return <div className={styles.state}><TriangleAlert size={24} aria-hidden /><p>{error}</p></div>;
  if (!sheets) return <p className={styles.plainText}>正在解析表格…</p>;
  return (
    <div>
      {sheets.length > 1 && (
        <div className={styles.sheetTabs} role="tablist" aria-label="工作表">
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

// ------------------------------------------------------------------ 大纲预览（PPT / 旧版 doc·ppt）

function OutlineView({ material }: { material: CourseMaterial }) {
  const client = useMemo(() => createMaterialClient(), []);
  const [outline, setOutline] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.outline(material.id)
      .then((result) => { if (!cancelled) setOutline(result); })
      .catch((failure: unknown) => { if (!cancelled) setError(toApiError(failure).message); });
    return () => { cancelled = true; };
  }, [client, material.id]);

  return (
    <div>
      <p className={styles.outlineBanner}>
        <TriangleAlert size={14} aria-hidden />
        仅显示大纲，完整排版请下载查看
      </p>
      {error ? (
        <p className={styles.plainText}>{error}</p>
      ) : !outline ? (
        <p className={styles.plainText}>正在加载大纲…</p>
      ) : outline.length === 0 ? (
        <p className={styles.plainText}>没有提取到标题。</p>
      ) : (
        <ol className={styles.outlineList}>
          {outline.map((heading, index) => <li key={index}>{heading}</li>)}
        </ol>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 分发与面板外壳

function PreviewBody({ material, state }: { material: CourseMaterial; state: RenderState }) {
  if (state.status === "loading") return <p className={styles.plainText}>正在加载…</p>;
  if (state.status === "degraded" || state.status === "error") {
    return state.status === "error"
      ? <div className={styles.state}><TriangleAlert size={24} aria-hidden /><p>{state.message}</p></div>
      : <DownloadButton material={material} />;
  }

  const { bytes, legacy } = state;
  switch (previewMode(material.kind, legacy)) {
    case "pdf": return <PdfView bytes={bytes} />;
    case "markdown": return <Markdown text={decodeText(bytes)} />;
    case "text": return <pre className={styles.plainText}>{decodeText(bytes)}</pre>;
    case "csv": return <CsvView bytes={bytes} />;
    case "xlsx": return <XlsxView bytes={bytes} />;
    case "outline": return <OutlineView material={material} />;
    case "docx": return <DocxView bytes={bytes} />;
  }
}

export function MaterialPreviewPanel({ material, onClose }: { material: CourseMaterial | null; onClose: () => void }) {
  const state = useMaterialBytes(material);
  if (!material) return null;
  const Icon = material.kind in TITLE_ICON ? TITLE_ICON[material.kind as keyof typeof TITLE_ICON] : FileText;
  return (
    <aside className={styles.panel} aria-label="资料预览">
      <header className={styles.head}>
        <span className={styles.headTitle}>
          <Icon size={15} aria-hidden />
          {material.title}
        </span>
        <div className={styles.headActions}>
          <button type="button" className={styles.iconBtn} aria-label="关闭预览" title="关闭预览" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
      <div className={styles.body}>
        <PreviewBody material={material} state={state} />
      </div>
    </aside>
  );
}

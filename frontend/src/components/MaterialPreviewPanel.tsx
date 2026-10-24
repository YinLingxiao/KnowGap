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

function useMaterialBytes(material: CourseMaterial | null): RenderState {
  const [state, setState] = useState<RenderState>({ status: "loading" });
  const client = useMemo(() => createMaterialClient(), []);

  useEffect(() => {
    if (!material) return;
    let cancelled = false;
    setState({ status: "loading" });
    if (material.sizeBytes > degradeThreshold(material.kind)) {
      setState({ status: "degraded" });
      return;
    }
    (async () => {
      try {
        const blob = await client.downloadBytes(material.id);
        if (cancelled) return;
        const buffer = await blob.arrayBuffer();
        if (cancelled) return;
        setState({ status: "ready", bytes: buffer, legacy: isLegacyOle(new Uint8Array(buffer.slice(0, 4))) });
      } catch (failure) {
        if (!cancelled) setState({ status: "error", message: toApiError(failure).message });
      }
    })();
    return () => { cancelled = true; };
  }, [material, client]);

  return state;
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
        for (let number = 1; number <= doc.numPages; number += 1) {
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
  return <div ref={hostRef} className={styles.pdfPages} aria-label="PDF 预览" />;
}

// ------------------------------------------------------------------ DOCX（沙箱 iframe）

/** iframe 内自包含的页面：全局 <script> 加载 jszip + docx-preview（UMD 版，不是 ESM，
 *  不依赖打包器解析裸模块说明符），用 message 事件接收父页面传入的文件字节再渲染。
 *  sandbox="allow-scripts" 不带 allow-same-origin：iframe 是 opaque origin，脚本能跑，
 *  但读不到父页面的 cookie / localStorage / DOM，postMessage 的 targetOrigin 只能是 "*"，
 *  这里传的只是文件字节，不是敏感数据，可以接受。 */
const DOCX_IFRAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  body { margin: 0; padding: 12px; font-family: sans-serif; }
  .docx-wrapper { background: transparent !important; }
</style></head>
<body>
  <div id="styles"></div>
  <div id="container"></div>
  <script src="/vendor/jszip.min.js"></script>
  <script src="/vendor/docx-preview.min.js"></script>
  <script>
    window.addEventListener("message", async function (event) {
      if (event.source !== window.parent) return;
      try {
        await window.docx.renderAsync(
          event.data,
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

function DocxView({ bytes }: { bytes: ArrayBuffer }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    let loaded = false;
    const onLoad = () => {
      loaded = true;
      frame.contentWindow?.postMessage(bytes, "*");
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
  const rows = useMemo(() => {
    const text = new TextDecoder("utf-8").decode(bytes);
    return text.replace(/\r\n/g, "\n").split("\n").filter((line) => line.length > 0).map((line) => line.split(","));
  }, [bytes]);
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
    case "markdown": return <Markdown text={new TextDecoder("utf-8").decode(bytes)} />;
    case "text": return <pre className={styles.plainText}>{new TextDecoder("utf-8").decode(bytes)}</pre>;
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

/**
 * PPTX 视觉预览。
 *
 * 用 @meshesha/pptxjs（MIT）在浏览器里把 OOXML 解析成 HTML/SVG：文字、图片、形状、图表
 * 按原位置铺出来，比只列标题的大纲更接近 PowerPoint 的实际页面。
 *
 * 安全边界：
 * - 渲染器只接收 ArrayBuffer，不把内容写进父页面 DOM。
 * - 生成的 HTML 放进 `sandbox=""` 的 iframe，并用 CSP 禁止脚本和外部资源；即使文档里带了
 *   恶意脚本/外链，也跑不进应用上下文。
 * - 渲染失败或无法解析时，由预览面板回退到后端提取的文字版。
 */

export const PPTX_BASE_WIDTH = 960;

export interface RenderedPptx {
  html: string;
  slideCount: number;
  /** 幻灯片原始 CSS 宽高（16:9 通常是 1280×720，4:3 是 960×720）。 */
  width: number;
  height: number;
}

const SLIDE_RE = /class=['"]slide(?:\s[^'"]*)?['"]/g;
const SIZE_RE = /class=['"]slide['"][^>]*style=['"][^'"]*width:\s*([\d.]+)px;[^'"]*height:\s*([\d.]+)px/i;

/**
 * 把 PPTX 字节渲染成可放进 iframe 的 HTML 片段。
 * `slides` 用于引用预览只渲染被引用的那一页；不传时渲染全部幻灯片。
 */
export async function renderPptxDocument(
  bytes: ArrayBuffer, options: { slides?: number[] } = {},
): Promise<RenderedPptx> {
  const { renderToHtmlString } = await import("@meshesha/pptxjs");
  const html = await renderToHtmlString(new Uint8Array(bytes), { slides: options.slides });
  const matches = html.match(SLIDE_RE) ?? [];
  if (matches.length === 0) throw new Error("PPTX renderer produced no slides");
  const size = SIZE_RE.exec(html);
  const width = Number(size?.[1] ?? PPTX_BASE_WIDTH);
  const height = Number(size?.[2] ?? 720);
  return {
    html,
    slideCount: matches.length,
    width: Number.isFinite(width) && width > 0 ? width : PPTX_BASE_WIDTH,
    height: Number.isFinite(height) && height > 0 ? height : 720,
  };
}

/** 面板宽度 → iframe 内缩放比例：小面板缩小到能看全，全屏时允许适当放大。 */
export function clampPptxScale(containerWidth: number, slideWidth = PPTX_BASE_WIDTH): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1;
  const base = Number.isFinite(slideWidth) && slideWidth > 0 ? slideWidth : PPTX_BASE_WIDTH;
  return Math.min(1.6, Math.max(0.2, (containerWidth - 8) / base));
}

/**
 * 生成 iframe 的完整文档：sandbox="" + CSP 把脚本和外部请求全部挡掉。
 * 只允许内联样式、data/blob 图片和媒体，避免课件里的外链在预览时被自动加载。
 */
export function pptxFrameDocument(html: string, scale: number): string {
  const safeScale = Math.min(1.6, Math.max(0.2, Number.isFinite(scale) && scale > 0 ? scale : 1));
  const csp = [
    "default-src 'none'",
    "img-src data: blob:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "media-src data: blob:",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<style>`
    + `html,body{margin:0;padding:0;background:transparent;color-scheme:light}`
    + `body{padding:10px 8px 16px}`
    + `.pptxjs{zoom:${safeScale};margin:0 auto}`
    + `.pptxjs .slide{margin:0 auto 14px !important;box-shadow:0 2px 12px rgba(0,0,0,.16)}`
    // 渲染器把正文列宽算成 NaN 时（某些占位符没有明确宽度），这里兜底成自适应并禁止行被压扁。
    + `.pptxjs .slide .slide-prgrph{flex-shrink:0}`
    + `.pptxjs .slide .slide-prgrph>div:last-child{width:auto !important;flex:1 1 auto;min-width:0}`
    + `.pptxjs .slide .text-block{line-height:1.2 !important}`
    + `</style></head><body>${html}</body></html>`;
}

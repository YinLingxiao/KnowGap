/**
 * PPTX 文字预览。
 *
 * 浏览器里没有成熟的 PPTX 排版渲染库（pptxjs 等已长期不维护），所以这里不做像素级还原：
 * 用 JSZip 打开 OOXML 包，按 presentation.xml 里的顺序读每张 slideN.xml，抽出标题和正文段落，
 * 以「文字版幻灯片」呈现。图片、图表和动画不上屏，界面会明确标注，并保留「下载查看」。
 *
 * 和 docx-preview 不同，这里不执行任何文档内脚本，也不拼 HTML；解析结果只作为 React 文本节点
 * 渲染，天然转义，恶意文档最多只能让自己的文字显示得难看一点。
 *
 * 纯解析函数（parseSlideXml / slidePaths / decodeXmlEntities）单独导出，方便 Node 单测。
 */

export interface PptxSlide {
  title: string;
  lines: string[];
}

export interface PptxPreview {
  slides: PptxSlide[];
  truncated: boolean;
}

/** 一页最多展示的段落数：防止异常文档把预览撑爆。 */
const MAX_LINES_PER_SLIDE = 80;
/** 一次最多解析的幻灯片数。 */
export const MAX_PPTX_SLIDES = 80;

/** OOXML 文本里的 XML 实体和数字字符引用。 */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: {
        const hex = entity[1] === "x" || entity[1] === "X";
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        if (code >= 0xd800 && code <= 0xdfff) return match; // 代理区不能单独解码
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
    }
  });
}

/** 一段 XML 里的所有 a:p 段落文本（按文档顺序，已合并同一段里的多个 a:t）。 */
function paragraphTexts(xml: string): string[] {
  const result: string[] = [];
  for (const paragraph of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const runs = [...paragraph[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
      .map((run) => decodeXmlEntities(run[1]));
    const text = runs.join("").replace(/\s+/g, " ").trim();
    if (text) result.push(text);
  }
  return result;
}

/** 标题占位符（title / ctrTitle / subTitle）里的段落。 */
function titleTexts(xml: string): string[] {
  for (const shape of xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
    const placeholder = /<p:ph\b[^>]*>/.exec(shape[1]);
    if (placeholder && /\btype="(?:title|ctrTitle|subTitle)"/.test(placeholder[0])) {
      return paragraphTexts(shape[1]);
    }
  }
  return [];
}

/** 解析一张 slideN.xml：第一段标题 + 其余段落。没有标题占位符时把第一段当标题。 */
export function parseSlideXml(xml: string): PptxSlide {
  const paragraphs = paragraphTexts(xml);
  const title = titleTexts(xml)[0] ?? paragraphs[0] ?? "";
  let removed = false;
  const lines = paragraphs.filter((line) => {
    if (!removed && line === title) {
      removed = true;
      return false;
    }
    return true;
  });
  return { title, lines: lines.slice(0, MAX_LINES_PER_SLIDE) };
}

/** 把 rels 里的 Target 规范成 zip 内路径（ppt/slides/slideN.xml）。 */
function slidePath(target: string): string | null {
  const path = target.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (path.startsWith("ppt/")) return path;
  if (path.startsWith("slides/")) return `ppt/${path}`;
  if (path.startsWith("../ppt/")) return path.slice(3);
  return null;
}

/** 按 presentation.xml 的 sldIdLst 顺序返回 slide 路径；rels 缺失时返回空数组。 */
export function slidePaths(presentationXml: string, relsXml: string): string[] {
  const targets = new Map<string, string>();
  for (const relationship of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = relationship[0];
    if (/\bTargetMode="External"/i.test(tag)) continue;
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (!id || !target) continue;
    const path = slidePath(target);
    if (path) targets.set(id, path);
  }
  const list = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(presentationXml)?.[1] ?? "";
  const paths: string[] = [];
  for (const slide of list.matchAll(/<p:sldId\b[^>]*>/g)) {
    const id = /\br:id="([^"]+)"/.exec(slide[0])?.[1];
    const path = id ? targets.get(id) : undefined;
    if (path) paths.push(path);
  }
  return paths;
}

/** zip 里所有 slideN.xml，按数字排序（presentation.xml 或 rels 缺失时的兜底）。 */
function fallbackSlidePaths(names: string[]): string[] {
  return names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(right.match(/(\d+)\.xml$/)?.[1] ?? 0));
}

/** 打开 PPTX 并解析出文字版幻灯片；文件不是有效 PPTX 时抛错，由调用方降级。 */
export async function loadPptxSlides(bytes: ArrayBuffer, limit = MAX_PPTX_SLIDES): Promise<PptxPreview> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const read = async (path: string): Promise<string | null> => {
    const file = zip.file(path);
    return file ? file.async("string") : null;
  };
  const [presentation, relationships] = await Promise.all([
    read("ppt/presentation.xml"),
    read("ppt/_rels/presentation.xml.rels"),
  ]);
  if (!presentation) throw new Error("PPTX missing presentation.xml");
  const ordered = relationships ? slidePaths(presentation, relationships) : [];
  const paths = (ordered.length > 0 ? ordered : fallbackSlidePaths(Object.keys(zip.files)))
    .filter((path) => zip.file(path) !== null);
  const selected = paths.slice(0, Math.max(1, limit));
  const slides: PptxSlide[] = [];
  for (const path of selected) {
    const xml = await read(path);
    if (!xml) continue;
    const slide = parseSlideXml(xml);
    if (slide.title || slide.lines.length > 0) slides.push(slide);
  }
  return { slides, truncated: paths.length > selected.length };
}

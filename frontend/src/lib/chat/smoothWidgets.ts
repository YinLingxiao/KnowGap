/** 会渲染成学习卡片的围栏语言 */
const CARD_LANGUAGES = new Set(["knowgap-widget", "widget", "knowgap-visual"]);

interface FenceBlock {
  /** 围栏起始位置（行首） */
  start: number;
  /** 围栏内正文结束位置；未闭合时等于文本长度 */
  contentEnd: number;
  /** 闭合围栏行尾；未闭合时等于文本长度 */
  end: number;
  /** 语言是否为学习卡片 */
  card: boolean;
  closed: boolean;
}

/** 行首的围栏标记：最多缩进三格，至少三个反引号或波浪线 */
const OPEN_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** 闭合围栏在行内的结束位置；不是该围栏的闭合行时返回 null */
function closingFenceEnd(line: string, marker: string, length: number): number | null {
  const match = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line);
  if (!match || match[2][0] !== marker || match[2].length < length) return null;
  return match[1].length + match[2].length;
}

/** 按 Markdown 围栏规则扫描文本；普通代码块只用来跳过后面的内容 */
function scanFences(text: string): FenceBlock[] {
  const blocks: FenceBlock[] = [];
  let current: { start: number; marker: string; length: number; card: boolean } | null = null;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");

    if (current) {
      if (closingFenceEnd(line, current.marker, current.length) !== null) {
        blocks.push({
          start: current.start, contentEnd: lineStart, end: lineEnd, card: current.card, closed: true,
        });
        current = null;
      }
    } else {
      const open = OPEN_FENCE.exec(line);
      // 反引号围栏的语言说明里不能再出现反引号，否则只是普通行内代码
      if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
        const language = open[3].trim().split(/\s+/)[0] ?? "";
        // 只有标准的三反引号围栏才快进；波浪线和更长围栏仍当普通代码块跳过其中的伪卡片
        const card = open[2] === "```" && CARD_LANGUAGES.has(language);
        current = {
          start: lineStart,
          marker: open[2][0],
          length: open[2].length,
          card,
        };
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (current) {
    blocks.push({
      start: current.start, contentEnd: text.length, end: text.length, card: current.card, closed: false,
    });
  }
  return blocks;
}

/**
 * 流式文字里已经开始的卡片直接跳到 full 中的当前完整内容：
 * 卡片 JSON 逐字增长会让卡片反复重排，而平滑显示只需要平滑正文。
 * 返回的仍是 full 的前缀，卡片之后的正文不会被提前放出。
 */
export function fastForwardWidgets(shown: string, full: string): string {
  if (shown === full || !full.startsWith(shown)) return shown;

  // shown 末尾可能正好停在语言名中间：只有 shown 自己认出的围栏才算已经开始
  let started: FenceBlock | null = null;
  for (const block of scanFences(shown)) {
    if (block.card) started = block;
  }
  if (!started) return shown;

  // shown 是 full 的前缀，同一位置上的块按出现顺序一一对应
  const start = started.start;
  const fullBlock = scanFences(full).find((block) => block.card && block.start === start);
  if (!fullBlock) return shown;

  const end = fullBlock.closed ? fullBlock.end : fullBlock.contentEnd;
  return end > shown.length ? full.slice(0, end) : shown;
}

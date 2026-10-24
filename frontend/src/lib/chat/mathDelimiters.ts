// 把 \( … \) 和 \[ … \] 写法的公式改成 remark-math 认识的 $…$ 与 $$…$$。
// GPT 一类模型习惯 LaTeX 的括号写法，而 Markdown 会把 \( 当成转义，结果显示成「(L)」「[ \text{…} ]」。
// 围栏代码块和行内代码里的内容原样保留。

const FENCE = /^( {0,3})(`{3,}|~{3,})/;

/** 把文本切成「普通文字」和「代码」两类，只对普通文字做替换。围栏没闭合（流式输出中）时，后面都算代码。 */
function splitCode(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const lines = text.split("\n");
  let buffer: string[] = [];
  let fence: { char: string; size: number } | null = null;
  const flush = (code: boolean) => {
    if (buffer.length) parts.push({ code, text: buffer.join("") });
    buffer = [];
  };
  lines.forEach((line, index) => {
    const tail = index < lines.length - 1 ? "\n" : "";
    const match = FENCE.exec(line);
    if (fence) {
      buffer.push(line + tail);
      if (match && match[2][0] === fence.char && match[2].length >= fence.size && line.trim() === match[2]) {
        flush(true);
        fence = null;
      }
    } else if (match) {
      flush(false);
      fence = { char: match[2][0], size: match[2].length };
      buffer.push(line + tail);
    } else {
      buffer.push(line + tail);
    }
  });
  flush(fence !== null);
  return parts;
}

/** 行内代码（含多个反引号的写法）不参与替换。 */
function replaceOutsideInlineCode(text: string, replace: (plain: string) => string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const open = /`+/.exec(text.slice(index));
    if (!open) {
      result += replace(text.slice(index));
      break;
    }
    const start = index + open.index;
    const ticks = open[0];
    const close = text.indexOf(ticks, start + ticks.length);
    if (close === -1) {
      result += replace(text.slice(index));
      break;
    }
    result += replace(text.slice(index, start)) + text.slice(start, close + ticks.length);
    index = close + ticks.length;
  }
  return result;
}

const DISPLAY = /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g;
const INLINE = /(?<!\\)\\\(([^\n]+?)(?<!\\)\\\)/g;

function convert(plain: string): string {
  const display = plain.replace(DISPLAY, (whole, body: string, offset: number, source: string) => {
    const content = body.trim();
    if (!content) return whole;
    const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
    const before = source.slice(lineStart, offset);
    const nextBreak = source.indexOf("\n", offset + whole.length);
    const after = source.slice(offset + whole.length, nextBreak === -1 ? source.length : nextBreak);
    // 独占一行（前后只有空白）才是公式块；夹在句子中间的按行内公式处理
    if (before.trim() === "" && after.trim() === "") return `$$\n${content}\n$$`.replace(/\n/g, `\n${before}`);
    return `$${content.replace(/\n/g, " ")}$`;
  });
  return display.replace(INLINE, (whole, body: string) => (body.trim() ? `$${body.trim()}$` : whole));
}

export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  return splitCode(text)
    .map((part) => (part.code ? part.text : replaceOutsideInlineCode(part.text, convert)))
    .join("");
}

// 提问导航的数据：每条提问配上它那一轮回答的开头，悬停卡片直接用，不再请求后端。

export interface NavTurn {
  id: string;
  question: string;
  /** 这一轮回答的开头；回答还没生成或只有卡片时为空 */
  answer: string;
  /** 这一轮回答里有随堂小测卡 */
  hasQuiz: boolean;
}

interface NavMessage {
  id: string;
  role: "user" | "assistant";
  kind: string;
  content: string;
}

const CARD_BLOCK = /```(?:knowgap-widget|widget|knowgap-visual)[\s\S]*?(?:```|$)/g;
const QUIZ_CARD = /```(?:knowgap-widget|widget)[\s\S]*?"type"\s*:\s*"micro_quiz"/;

export function hasQuizCard(markdown: string): boolean {
  return QUIZ_CARD.test(markdown);
}

/** 回答开头的纯文字：去掉卡片、代码、公式、链接和 Markdown 记号 */
export function answerPreview(markdown: string, max = 120): string {
  const flat = markdown
    .replace(CARD_BLOCK, " ")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/[*_`~|$\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/**
 * 按提问切分对话：每条可导航的提问，配上它之后、下一条提问之前的第一段有文字的回答。
 * include 决定哪些用户消息算提问，question 负责把提问变成一行展示文字。
 */
export function navTurns<T extends NavMessage>(
  messages: T[],
  include: (message: T) => boolean,
  question: (message: T) => string,
): NavTurn[] {
  const turns: NavTurn[] = [];
  let current: NavTurn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = null;
      if (!include(message)) continue;
      current = { id: message.id, question: question(message), answer: "", hasQuiz: false };
      turns.push(current);
      continue;
    }
    if (!current || message.kind !== "text") continue;
    if (!current.hasQuiz && hasQuizCard(message.content)) current.hasQuiz = true;
    if (!current.answer) current.answer = answerPreview(message.content);
  }
  return turns;
}

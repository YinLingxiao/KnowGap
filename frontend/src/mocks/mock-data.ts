/**
 * ⚠️ MOCK 数据 —— 仅供后端接口契约到位前演示页面使用。
 *
 * 题目、判定规则与追问脚本都是前端临时编写的示例：
 * - 未经 AI 教学负责人审定，不是正式题库或参考答案；
 * - 判定只是简单的关键词匹配，不代表任何模型能力；
 * - 接入真实后端后应整体删除 src/mocks/ 目录。
 */

import type { Problem } from "@/lib/types";

export type Verdict = "correct" | "incorrect" | "unclear";

export interface MockProblemScript {
  problem: Problem;
  issueKey: string;
  /** 诊断卡片中展示的疑似误区 */
  issue: string;
  /** 写入学习记忆的摘要 */
  memorySummary: string;
  judge: (text: string) => Verdict;
  reachedInsight: (text: string) => boolean;
  incorrectEvidence: (answer: string, reasoning: string) => string;
  correctEvidence: (answer: string, reasoning: string) => string;
  /** 首次学习：由浅入深的追问 */
  hints: string[];
  /** 有相关历史记忆时：换一种引导策略 */
  memoryHints: string[];
  confirmation: string;
  explanation: string;
  correctPraise: string;
  correctFollowUp: string;
  unclearReply: string;
}

/**
 * 与后端契约一致：诊断依据必须是学生原文中的一段（逐字），
 * 这里取第一句命中关键词的话，没有则取第一句。
 */
export function quoteFrom(text: string, pattern?: RegExp): string | null {
  const sentences = text
    .split(/(?<=[。！？!?；;\n])/)
    .map((sentence) => sentence.trim().replace(/[。！？!?；;]+$/, ""))
    .filter(Boolean);
  if (sentences.length === 0) return null;
  return (pattern && sentences.find((sentence) => pattern.test(sentence))) || sentences[0];
}

function quoteAnswer(answer: string, reasoning: string, pattern?: RegExp): string {
  return quoteFrom(reasoning, pattern) ?? quoteFrom(answer) ?? answer.trim();
}

export function excerpt(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(/[。！？，、；.!?,;]+$/, "");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/* ---------- 栈：合法出栈序列 ---------- */

const STACK_NEGATIVE = /(不合法|非法|不可能|不能|无法|不成立|不行|invalid|illegal|^\s*(否|不是)\s*$)/i;
const STACK_POSITIVE = /(合法|可以|能|成立|valid|legal|^\s*(是|对)\s*$)/i;

function judgeStackLegality(text: string): Verdict {
  if (STACK_NEGATIVE.test(text)) return "correct";
  if (STACK_POSITIVE.test(text)) return "incorrect";
  return "unclear";
}

function stackInsight(text: string): boolean {
  return STACK_NEGATIVE.test(text) || /(压在.{0,6}下面|不在栈顶)/.test(text);
}

function stackIncorrectEvidence(answer: string, reasoning: string): string {
  return quoteAnswer(answer, reasoning, /(合法|都能|依次|可以)/);
}

function stackCorrectEvidence(answer: string, reasoning: string): string {
  return quoteAnswer(answer, reasoning, /(栈顶|top|压在|模拟|push|pop)/i);
}

const STACK_MEMORY_HINTS = [
  "上次判断出栈序列时，你曾忽略「只能弹出栈顶」这个约束。这次我们换个方法：请按 `push 1 → [1]`、`pop → 1` 的格式把每一步写下来，直到遇到第一个做不到的操作为止。",
  "很好，就是要这样一步步写。现在对照你写出的栈状态：序列要求的下一个元素，正好在栈顶吗？",
  "如果目标元素被压在下面，想让它出栈就得先弹出它上面的元素——但那样出栈序列就变了。这说明了什么？",
  "回想上次的结论：任一时刻只能弹出栈顶。用这条规则检查你卡住的那一步，序列还能继续吗？",
];

const stackSequence1: MockProblemScript = {
  problem: {
    id: "stack-sequence-001",
    title: "判断合法出栈序列（一）",
    topicKey: "stack.lifo",
    topicLabel: "栈 · 后进先出",
    difficulty: "基础",
    statement:
      "元素 `1`、`2`、`3`、`4`、`5` 按顺序依次入栈，入栈过程中可以随时出栈。请判断出栈序列 `4, 3, 5, 1, 2` 是否合法，并写出你的理由。",
    inputSequence: [1, 2, 3, 4, 5],
    outputSequence: [4, 3, 5, 1, 2],
  },
  issueKey: "ignore_top_constraint",
  issue: "可能忽略了「只能弹出栈顶元素」的后进先出（LIFO）约束",
  memorySummary: "判断出栈序列时，容易忽略「只能弹出栈顶」的 LIFO 约束",
  judge: judgeStackLegality,
  reachedInsight: stackInsight,
  incorrectEvidence: stackIncorrectEvidence,
  correctEvidence: stackCorrectEvidence,
  hints: [
    "我们先不急着下结论，一起模拟一遍。要让 `4` 第一个出栈，`1`～`4` 必须先全部入栈。弹出 `4` 之后，栈里从栈底到栈顶依次是什么？",
    "接着弹出 `3`，再压入 `5` 并立即弹出。此刻栈里还剩哪些元素？哪一个在栈顶？",
    "序列里下一个要出栈的是 `1`。按照「每次只能弹出栈顶」的规则，`1` 现在能出栈吗？",
    "换个角度想：如果 `1` 要比 `2` 先出栈，那么 `1` 应该比 `2` 晚入栈才行。题目的入栈顺序满足这一点吗？",
  ],
  memoryHints: STACK_MEMORY_HINTS,
  confirmation:
    "完全正确！弹出 `4`、`3`、`5` 后，栈中是 `[1, 2]`，栈顶是 `2`；`1` 被压在下面，不可能先于 `2` 出栈，所以 `4, 3, 5, 1, 2` 不合法。\n\n记住这条规则：任一时刻只能弹出栈顶元素。",
  explanation:
    "我们把过程完整走一遍：\n`push 1, 2, 3, 4` → 栈为 `[1, 2, 3, 4]`，`pop` 得到 `4`\n`pop` 得到 `3` → 栈为 `[1, 2]`\n`push 5`，`pop` 得到 `5` → 栈仍为 `[1, 2]`\n此时序列要求弹出 `1`，但栈顶是 `2`，做不到。\n\n结论：`4, 3, 5, 1, 2` 不是合法的出栈序列。判断这类题的关键，是每一步都检查目标元素是否正好在栈顶。",
  correctPraise: "判断正确，你没有被「看起来每个元素都能出栈」迷惑。",
  correctFollowUp: "为了确认理解扎实：你是在第几步发现序列走不下去的？那一刻栈顶是哪个元素？",
  unclearReply:
    "我还不能确定你的判断。你认为这个出栈序列是「合法」还是「不合法」？如果不确定，可以先把入栈、出栈的过程一步步写出来。",
};

const stackSequence2: MockProblemScript = {
  problem: {
    id: "stack-sequence-002",
    title: "判断合法出栈序列（二）",
    topicKey: "stack.lifo",
    topicLabel: "栈 · 后进先出",
    difficulty: "同类变式",
    statement:
      "元素 `1`、`2`、`3`、`4`、`5` 按顺序依次入栈，入栈过程中可以随时出栈。请判断出栈序列 `2, 5, 3, 4, 1` 是否合法，并写出你的理由。",
    inputSequence: [1, 2, 3, 4, 5],
    outputSequence: [2, 5, 3, 4, 1],
  },
  issueKey: "ignore_top_constraint",
  issue: "可能忽略了「只能弹出栈顶元素」的后进先出（LIFO）约束",
  memorySummary: "判断出栈序列时，容易忽略「只能弹出栈顶」的 LIFO 约束",
  judge: judgeStackLegality,
  reachedInsight: stackInsight,
  incorrectEvidence: stackIncorrectEvidence,
  correctEvidence: stackCorrectEvidence,
  hints: [
    "我们一起来模拟。要让 `2` 第一个出栈，需要先压入哪些元素？弹出 `2` 之后，栈里还剩什么？",
    "接下来要让 `5` 出栈，需要把 `3`、`4`、`5` 依次压入再弹出 `5`。此时栈从栈底到栈顶是什么？",
    "序列的下一个元素是 `3`，可当前栈顶是谁？`3` 能直接出栈吗？",
    "如果 `3` 要比 `4` 先出栈，`3` 就必须比 `4` 晚入栈。题目的入栈顺序满足吗？",
  ],
  memoryHints: STACK_MEMORY_HINTS,
  confirmation:
    "没错！弹出 `2`、`5` 之后，栈中是 `[1, 3, 4]`，栈顶是 `4`；`3` 被压在 `4` 下面，无法先出栈，所以 `2, 5, 3, 4, 1` 不合法。\n\n每一步都先确认「目标元素在不在栈顶」，这类题就不会被迷惑。",
  explanation:
    "完整过程如下：\n`push 1, 2`，`pop` 得到 `2` → 栈为 `[1]`\n`push 3, 4, 5`，`pop` 得到 `5` → 栈为 `[1, 3, 4]`\n此时序列要求弹出 `3`，但栈顶是 `4`，做不到。\n\n结论：`2, 5, 3, 4, 1` 不是合法的出栈序列。",
  correctPraise: "判断正确！",
  correctFollowUp: "能说说你是在哪一步发现矛盾的吗？那时栈里从底到顶是什么？",
  unclearReply:
    "我还不能确定你的判断。你认为 `2, 5, 3, 4, 1` 是「合法」还是「不合法」的出栈序列？可以把过程一步步写出来。",
};

/* ---------- 队列：先进先出 ---------- */

function firstElement(text: string): string | null {
  const match = text.toLowerCase().match(/[a-d]/);
  return match ? match[0] : null;
}

const queueFifo: MockProblemScript = {
  problem: {
    id: "queue-fifo-001",
    title: "队列的出队顺序",
    topicKey: "queue.fifo",
    topicLabel: "队列 · 先进先出",
    difficulty: "基础",
    statement:
      "一个初始为空的队列依次执行：入队 `a`、入队 `b`、入队 `c`、出队、入队 `d`、出队。此时的队头元素是什么？请写出每一步之后的队列状态。",
  },
  issueKey: "confused_with_lifo",
  issue: "可能把队列的先进先出（FIFO）与栈的后进先出混淆",
  memorySummary: "判断出队元素时，容易把队列 FIFO 与栈 LIFO 的规则混淆",
  judge: (text) => {
    const element = firstElement(text);
    if (!element) return "unclear";
    return element === "c" ? "correct" : "incorrect";
  },
  reachedInsight: (text) => /队头[^a-d]{0,8}c/i.test(text) || /^\s*c\b/i.test(text) || /是\s*c\b/i.test(text),
  incorrectEvidence: (answer) => quoteFrom(answer) ?? answer.trim(),
  correctEvidence: (answer, reasoning) => quoteAnswer(answer, reasoning, /(\[|队头|出队)/),
  hints: [
    "先回忆队列的规则：执行第一次「出队」时，被移出的是最早入队的元素，还是最晚入队的元素？",
    "那么在入队 `a`、`b`、`c` 并出队一次之后，再入队 `d`，此时队列从队头到队尾依次是什么？",
    "最后再出队一次，会移走哪个元素？之后排在队头的是谁？",
  ],
  memoryHints: [
    "上次你把队列和栈的出入规则混在了一起。这次请先把每一步操作后的队列写成 `[队头 … 队尾]` 的形式，再判断队头是谁。",
    "写得不错。对照你写的状态：每次出队移走的，是不是都是方括号最左边的元素？",
    "按这个规则走完最后一步，队头剩下的是谁？",
  ],
  confirmation: "完全正确！队列遵循先进先出：`a`、`b` 依次出队后，队列为 `[c, d]`，队头是 `c`。",
  explanation:
    "完整过程如下：\n入队 `a`、`b`、`c` → `[a, b, c]`\n出队（移走最早入队的 `a`）→ `[b, c]`\n入队 `d` → `[b, c, d]`\n出队（移走 `b`）→ `[c, d]`\n\n所以队头是 `c`。队列的关键是「先进先出」：出队总是移走排在最前面的元素，这和栈的「后进先出」正好相反。",
  correctPraise: "答对了！你准确地按先进先出处理了每次出队。",
  correctFollowUp: "再想深一步：如果把这个结构换成栈，执行同样的操作之后，栈顶会是哪个元素？",
  unclearReply: "我还不能确定你的结论。你认为最后的队头是哪个元素？可以把每一步操作后的队列状态写出来。",
};

export const MOCK_SCRIPTS: MockProblemScript[] = [stackSequence1, stackSequence2, queueFifo];

export function findScript(problemId: string): MockProblemScript | undefined {
  return MOCK_SCRIPTS.find((script) => script.problem.id === problemId);
}

"use client";

import { memo } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters } from "@/lib/chat/mathDelimiters";
import styles from "./Markdown.module.css";

/**
 * KaTeX 配置：公式写错时显示原文而不是抛错；trust 保持默认 false，禁用 \href、\url 等命令。
 * remark-math 识别 $…$（行内）与 $$…$$（块级）；\( … \)、\[ … \] 在渲染前由 normalizeMathDelimiters 转成这两种。
 * remark-cjk-friendly 让「**……。**你」这类紧挨汉字的加粗也能识别，否则星号会原样显示。
 */
export const mathRemarkPlugins: Options["remarkPlugins"] = [remarkCjkFriendly, remarkMath];
export const mathRehypePlugins: Options["rehypePlugins"] = [[rehypeKatex, { throwOnError: false, strict: false }]];

// 微件里的文字会放进 <button>、<strong> 等行内容器，只保留行内结构，段落等块级元素拆成纯内容
const INLINE_ALLOWED = ["span", "em", "strong", "code", "del", "br", "math", "semantics", "mrow", "mi", "mo", "mn", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mtext", "mspace", "mover", "munder", "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom", "menclose", "annotation", "svg", "path", "line", "rect", "g"];

const inlineComponents: Components = {
  // 和正文里的行内代码同一套样式
  code({ children }) {
    return <code className={styles.inline}>{children}</code>;
  },
};

/** 带公式的短文本（题干、选项、解析、卡片里的说明）。不渲染原始 HTML，也不渲染链接、图片和列表。 */
export const MathText = memo(function MathText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={mathRemarkPlugins}
      rehypePlugins={mathRehypePlugins}
      allowedElements={INLINE_ALLOWED}
      unwrapDisallowed
      components={inlineComponents}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  );
});

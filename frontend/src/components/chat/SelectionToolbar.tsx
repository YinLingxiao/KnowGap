"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Lightbulb, MessageSquareQuote, NotebookPen } from "lucide-react";
import styles from "./SelectionToolbar.module.css";

/** 把引用块插入指定会话输入框顶部并聚焦（不发送） */
export const QUOTE_TO_COMPOSER_EVENT = "knowgap:quote-to-composer";
/** 让指定会话的输入框直接发送一段文本 */
export const SEND_TO_COMPOSER_EVENT = "knowgap:send-to-composer";
const SAVE_TO_PAGE_EVENT = "knowgap:save-to-page";

export interface ComposerTextDetail {
  conversationId: string;
  text: string;
}

/** 可划词的 AI 回复正文容器需带上该属性 */
export const SELECTABLE_ATTR = "data-selectable-reply";

const MIN_CHARS = 2;
const MAX_CHARS = 400;
const EDGE = 8;
const GAP = 8;
const BLOCK_TAGS = new Set(["P", "DIV", "LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "TABLE", "UL", "OL"]);

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** 选区转文本：KaTeX 公式取 LaTeX 源，块级元素之间补换行 */
function rangeToText(source: Range): string {
  const range = source.cloneRange();
  const startMath = elementOf(range.startContainer)?.closest(".katex");
  if (startMath) range.setStartBefore(startMath);
  const endMath = elementOf(range.endContainer)?.closest(".katex");
  if (endMath) range.setEndAfter(endMath);

  const fragment = range.cloneContents();
  fragment.querySelectorAll(".katex").forEach((math) => {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    const display = math.parentElement?.classList.contains("katex-display");
    const text = tex ? (display ? `$$${tex}$$` : `$${tex}$`) : math.textContent ?? "";
    math.replaceWith(document.createTextNode(text));
  });
  fragment.querySelectorAll("button, [aria-hidden='true']").forEach((node) => node.remove());

  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node instanceof Element && node.tagName === "BR") {
      out += "\n";
      return;
    }
    const block = node instanceof Element && BLOCK_TAGS.has(node.tagName);
    if (block && out && !out.endsWith("\n")) out += "\n";
    node.childNodes.forEach(walk);
    if (block && !out.endsWith("\n")) out += "\n";
  };
  walk(fragment);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Markdown 引用块：每行加 `> ` 前缀 */
export function toQuote(text: string): string {
  return text.split("\n").map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
}

interface Anchor {
  text: string;
  rect: { top: number; bottom: number; left: number; right: number };
}

interface SelectionToolbarProps {
  /** 监听划词的范围（消息列表滚动容器） */
  scopeRef: RefObject<HTMLElement | null>;
  conversationId: string;
  /** 是否在学习空间内（决定能否摘录到空间笔记） */
  canSaveToPage: boolean;
  /** 当前会话是否空闲可直接发送 */
  canSend: boolean;
}

export function SelectionToolbar({ scopeRef, conversationId, canSaveToPage, canSend }: SelectionToolbarProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setAnchor(null);
    setPos(null);
  }, []);

  const readSelection = useCallback(() => {
    const scope = scopeRef.current;
    const selection = window.getSelection();
    if (!scope || !selection || selection.isCollapsed || selection.rangeCount === 0) return close();
    const range = selection.getRangeAt(0);
    const startReply = elementOf(range.startContainer)?.closest(`[${SELECTABLE_ATTR}]`);
    const endReply = elementOf(range.endContainer)?.closest(`[${SELECTABLE_ATTR}]`);
    if (!startReply || startReply !== endReply || !scope.contains(startReply)) return close();
    const text = rangeToText(range);
    const length = [...text].length;
    if (length < MIN_CHARS || length > MAX_CHARS) return close();
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
    const box = rects.length > 0
      ? {
          top: Math.min(...rects.map((rect) => rect.top)),
          bottom: Math.max(...rects.map((rect) => rect.bottom)),
          left: Math.min(...rects.map((rect) => rect.left)),
          right: Math.max(...rects.map((rect) => rect.right)),
        }
      : range.getBoundingClientRect();
    setAnchor({ text, rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right } });
  }, [scopeRef, close]);

  // 划词结束（鼠标抬起 / 键盘扩选）后读取选区
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(readSelection, 0);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.shiftKey || event.key === "Shift") schedule();
    };
    scope.addEventListener("mouseup", schedule);
    scope.addEventListener("keyup", onKeyUp);
    return () => {
      window.clearTimeout(timer);
      scope.removeEventListener("mouseup", schedule);
      scope.removeEventListener("keyup", onKeyUp);
    };
  }, [scopeRef, readSelection]);

  // 浮条可见时：滚动、点空白、Esc、选区变空、窗口变化都关闭
  useEffect(() => {
    if (!anchor) return;
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) close();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!barRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        window.getSelection()?.removeAllRanges();
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor, close]);

  // 切换会话时收起
  useEffect(() => close, [conversationId, close]);

  // 量出浮条尺寸后定位：优先放在选区上方，空间不足放到下方，并夹在视口内
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!anchor || !bar) return;
    const { width, height } = bar.getBoundingClientRect();
    const center = (anchor.rect.left + anchor.rect.right) / 2;
    const left = Math.min(Math.max(center - width / 2, EDGE), window.innerWidth - width - EDGE);
    const above = anchor.rect.top - height - GAP;
    const top = above >= EDGE ? above : Math.min(anchor.rect.bottom + GAP, window.innerHeight - height - EDGE);
    setPos({ top, left });
  }, [anchor]);

  if (!anchor) return null;

  const finish = () => {
    close();
    window.getSelection()?.removeAllRanges();
  };
  const quote = toQuote(anchor.text);
  const dispatch = (type: string, text: string) =>
    window.dispatchEvent(new CustomEvent<ComposerTextDetail>(type, { detail: { conversationId, text } }));

  const ask = () => {
    dispatch(QUOTE_TO_COMPOSER_EVENT, `${quote}\n\n`);
    finish();
  };
  const example = () => {
    if (!canSend) return;
    dispatch(SEND_TO_COMPOSER_EVENT, `请针对这句话换一个直观的生活例子解释：\n\n${quote}`);
    finish();
  };
  const save = () => {
    if (!canSaveToPage) return;
    window.dispatchEvent(new CustomEvent(SAVE_TO_PAGE_EVENT, { detail: { content: quote } }));
    finish();
  };

  return createPortal(
    <div
      ref={barRef}
      className={styles.bar}
      role="toolbar"
      aria-label="划词操作"
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999, visibility: "hidden" }}
      // 保持选区不被按钮点击清掉
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" className={styles.item} onClick={ask} title="把选中内容作为引用放进输入框">
        <MessageSquareQuote size={13} aria-hidden />
        <span>追问这句</span>
      </button>
      <button
        type="button"
        className={styles.item}
        onClick={example}
        aria-disabled={!canSend}
        title={canSend ? "直接请 AI 用生活例子解释这句" : "正在生成回复，稍后再试"}
      >
        <Lightbulb size={13} aria-hidden />
        <span>举个通俗例子</span>
      </button>
      <span className={styles.divider} aria-hidden />
      <button
        type="button"
        className={styles.item}
        onClick={save}
        aria-disabled={!canSaveToPage}
        title={canSaveToPage ? "摘录到当前学习空间的笔记页" : "仅在学习空间的对话里可以摘录到空间笔记"}
      >
        <NotebookPen size={13} aria-hidden />
        <span>摘录到空间笔记</span>
      </button>
    </div>,
    document.body,
  );
}

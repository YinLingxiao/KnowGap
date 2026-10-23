"use client";

import { useEffect, useRef, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { WorkingGlyph, formatElapsed, useElapsedSeconds } from "./WorkingIndicator";
import { cx } from "@/lib/cx";
import { useSmoothText } from "@/hooks/useSmoothText";
import styles from "./ReasoningBlock.module.css";

interface ReasoningBlockProps {
  text: string;
  /** 这条回复还在生成 */
  streaming: boolean;
  /** 正文已经开始输出：思考结束，默认收起 */
  answering: boolean;
}

/**
 * 模型的思考过程。生成中、正文还没开始时默认展开，让人看到它在想什么；
 * 正文开始后自动收起成一行摘要，点开可以回看。学生手动展开 / 收起之后不再自动变动。
 */
export function ReasoningBlock({ text, streaming, answering }: ReasoningBlockProps) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const thinking = streaming && !answering;
  const open = chosen ?? thinking;
  const shown = useSmoothText(text, streaming);
  const body = useRef<HTMLDivElement>(null);
  const seconds = useElapsedSeconds(thinking);

  useEffect(() => {
    const node = body.current;
    if (open && thinking && node) node.scrollTop = node.scrollHeight;
  }, [open, thinking, shown]);

  const size = text.replace(/\s/g, "").length;
  return (
    <section className={cx(styles.block, thinking && styles.live)} aria-label="思考过程">
      <button
        type="button"
        className={styles.head}
        onClick={() => setChosen(!open)}
        aria-expanded={open}
      >
        {thinking ? <WorkingGlyph size={14} /> : <Brain size={13} aria-hidden />}
        <span className={styles.title}>{thinking ? "正在思考" : "思考过程"}</span>
        {thinking ? (
          seconds >= 3 && <span className={styles.count}>{formatElapsed(seconds)}</span>
        ) : (
          <span className={styles.count}>约 {size} 字</span>
        )}
        <ChevronRight size={13} className={cx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
      </button>
      {open && (
        <div ref={body} className={styles.body} tabIndex={0}>
          {shown}
        </div>
      )}
    </section>
  );
}

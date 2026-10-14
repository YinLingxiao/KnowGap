"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { Button } from "./ui/Button";
import styles from "./ChatComposer.module.css";

const QUICK_REPLIES = ["我需要一点提示", "我想看完整解答"];

interface ChatComposerProps {
  sending: boolean;
  onSend: (content: string) => void;
}

export function ChatComposer({ sending, onSend }: ChatComposerProps) {
  const [text, setText] = useState("");
  const [emptyHint, setEmptyHint] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 输入框随内容自动增高
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    const border = element.offsetHeight - element.clientHeight;
    const height = Math.min(element.scrollHeight + border, 180);
    element.style.height = `${height}px`;
    element.style.overflowY = element.scrollHeight + border > 180 ? "auto" : "hidden";
  }, [text]);

  const send = () => {
    if (sending) return;
    const content = text.trim();
    if (!content) {
      setEmptyHint(true);
      textareaRef.current?.focus();
      return;
    }
    onSend(content);
    setText("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className={styles.composer}>
      <div className={styles.box}>
        <label htmlFor="chat-input" className="sr-only">
          回复导师
        </label>
        <textarea
          id="chat-input"
          ref={textareaRef}
          className={styles.input}
          rows={1}
          maxLength={2000}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (emptyHint) setEmptyHint(false);
          }}
          onKeyDown={handleKeyDown}
          placeholder="回答导师的问题…"
          aria-invalid={emptyHint || undefined}
        />
        <Button variant="primary" size="md" onClick={send} loading={sending} icon={<Send size={15} />}>
          发送
        </Button>
      </div>
      <div className={styles.foot}>
        <div className={styles.quick}>
          {QUICK_REPLIES.map((reply) => (
            <button key={reply} className={styles.quickButton} onClick={() => onSend(reply)} disabled={sending}>
              {reply}
            </button>
          ))}
        </div>
        {emptyHint ? (
          <span className={styles.warn} role="alert">
            先写下你的想法再发送
          </span>
        ) : (
          <span className={styles.hint}>Enter 发送 · Shift + Enter 换行</span>
        )}
      </div>
    </div>
  );
}

"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { History, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "./ui/Button";
import styles from "./AnswerForm.module.css";

const MAX_LENGTH = 2000;

interface AnswerFormProps {
  relatedMemoryCount: number;
  submitting: boolean;
  onSubmit: (answer: string, reasoning: string) => void;
}

export function AnswerForm({ relatedMemoryCount, submitting, onSubmit }: AnswerFormProps) {
  const [answer, setAnswer] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  const answerMissing = answer.trim().length === 0;
  const showAnswerError = attempted && answerMissing;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setAttempted(true);
    if (answerMissing) {
      answerRef.current?.focus();
      return;
    }
    onSubmit(answer, reasoning);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  return (
    <form ref={formRef} className={styles.form} onSubmit={handleSubmit} noValidate aria-busy={submitting}>
      <div className={styles.header}>
        <h3 className={styles.title}>写下你的答案和思路</h3>
        <p className={styles.sub}>提交后，导师会先做认知诊断，再用提问一步步引导你。</p>
      </div>

      <div className={styles.field}>
        <label htmlFor="answer-input" className={styles.label}>
          答案 <span className={styles.required}>必填</span>
        </label>
        <textarea
          id="answer-input"
          ref={answerRef}
          className={styles.textarea}
          rows={2}
          maxLength={MAX_LENGTH}
          value={answer}
          readOnly={submitting}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="例如：不合法 / 合法，或直接写出结果"
          aria-invalid={showAnswerError}
          aria-describedby={showAnswerError ? "answer-error" : undefined}
        />
        {showAnswerError && (
          <span id="answer-error" className={styles.error}>
            <TriangleAlert size={13} aria-hidden />
            请先写下你的答案，再提交诊断
          </span>
        )}
      </div>

      <div className={styles.field}>
        <label htmlFor="reasoning-input" className={styles.label}>
          解题思路 <span className={styles.optional}>建议填写</span>
        </label>
        <textarea
          id="reasoning-input"
          className={styles.textarea}
          rows={5}
          maxLength={MAX_LENGTH}
          value={reasoning}
          readOnly={submitting}
          onChange={(event) => setReasoning(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="说说你是怎么想的——哪怕不确定也没关系。思路写得越具体，诊断越准确。"
        />
        <span className={styles.counter}>
          {reasoning.length} / {MAX_LENGTH}
        </span>
      </div>

      {relatedMemoryCount > 0 && (
        <div className={styles.memoryNote}>
          <History size={15} aria-hidden />
          <span>
            你在这个知识点上有 <strong>{relatedMemoryCount}</strong> 条学习记忆，导师可能会参考它们调整提问方式。
          </span>
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.shortcut}>
          <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 提交
        </span>
        <Button variant="primary" size="lg" type="submit" loading={submitting} icon={<Sparkles size={16} />}>
          {submitting ? "诊断中…" : "提交并诊断"}
        </Button>
      </div>
    </form>
  );
}

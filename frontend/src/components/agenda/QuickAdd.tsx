"use client";

import { forwardRef, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { parseQuickAdd, quickAddToInput, type QuickAddToken } from "@/lib/agenda/quickAdd";
import type { TaskInput } from "@/lib/agenda/types";
import { cx } from "@/lib/cx";
import styles from "./QuickAdd.module.css";

interface QuickAddProps {
  subjects: { id: string; name: string; color: string }[];
  /** 当前按空间筛选时，新任务默认归到该空间 */
  defaultSubjectId: string | null;
  initialText?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onCreate: (input: TaskInput) => Promise<boolean>;
}

const CHIP_CLASS: Record<QuickAddToken["kind"], string> = {
  date: styles.chipDate,
  time: styles.chipDate,
  duration: styles.chipNeutral,
  priority: styles.chipPriority,
  deadline: styles.chipDeadline,
  subject: styles.chipSubject,
  label: styles.chipNeutral,
};

const KIND_NAME: Record<QuickAddToken["kind"], string> = {
  date: "日期", time: "时间", duration: "时长", priority: "优先级", deadline: "截止", subject: "空间", label: "标签",
};

export const QuickAdd = forwardRef<HTMLInputElement, QuickAddProps>(function QuickAdd(
  { subjects, defaultSubjectId, initialText = "", autoFocus = false, onCancel, onCreate }, ref,
) {
  const [text, setText] = useState(initialText);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!autoFocus) return;
    const node = typeof ref === "function" ? null : ref?.current;
    node?.focus();
  }, [autoFocus, ref]);

  // now 每次输入时重新取，跨午夜也不会算错
  const parsed = useMemo(
    () => parseQuickAdd(text, new Date(), subjects, ignored),
    [text, subjects, ignored],
  );
  const canSubmit = parsed.title.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    const input = quickAddToInput(parsed.fields);
    if (!input.subjectId && defaultSubjectId) input.subjectId = defaultSubjectId;
    setBusy(true);
    const ok = await onCreate(input);
    setBusy(false);
    if (ok) {
      setText("");
      setIgnored([]);
    }
  };

  return (
    <div className={styles.quick}>
      <div className={cx(styles.field, busy && styles.fieldBusy)}>
        <Plus size={15} aria-hidden className={styles.plus} />
        <input
          ref={ref}
          className={styles.input}
          value={text}
          disabled={busy}
          maxLength={400}
          placeholder="添加任务，如：明天下午3点 复习戴维南定理 #电路原理 p1 45分钟"
          aria-label="快速添加任务"
          onChange={(event) => {
            setText(event.target.value);
            if (!event.target.value) setIgnored([]);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              if (onCancel) onCancel();
              else event.currentTarget.blur();
            }
          }}
        />
        {text && <kbd className={styles.enterHint}>回车</kbd>}
      </div>

      {parsed.tokens.length > 0 && (
        <div className={styles.chips} aria-label="已识别的内容，点击可取消">
          {parsed.tokens.map((token) => (
            <button
              key={`${token.key}:${token.start}`}
              type="button"
              className={cx(styles.chip, CHIP_CLASS[token.kind])}
              style={token.kind === "subject"
                ? { "--chip-dot": subjects.find((item) => item.id === token.subjectId)?.color } as React.CSSProperties
                : undefined}
              title={`${KIND_NAME[token.kind]}：${token.raw}（点击取消，文字会回到标题）`}
              onClick={() => setIgnored((items) => [...items, token.key])}
            >
              {token.kind === "subject" && <span className={styles.dot} aria-hidden />}
              <span>{token.label}</span>
              <span className={styles.chipX} aria-hidden>×</span>
            </button>
          ))}
          <span className={styles.titlePreview} title={parsed.title}>
            标题：{parsed.title || "（空）"}
          </span>
        </div>
      )}
      {ignored.length > 0 && (
        <button type="button" className={styles.restore} onClick={() => setIgnored([])}>
          恢复已取消的识别（{ignored.length}）
        </button>
      )}
    </div>
  );
});

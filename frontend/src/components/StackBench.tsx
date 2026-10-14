"use client";

import { useState } from "react";
import { Button } from "./ui/Button";
import styles from "./StackBench.module.css";

interface StackBenchProps {
  input: number[];
  output: number[];
}

interface LogEntry {
  id: number;
  text: string;
}

/** 学生自己入栈、出栈。只记录操作，不判断序列是否合法。 */
export function StackBench({ input, output }: StackBenchProps) {
  const [stack, setStack] = useState<number[]>([]);
  const [nextIn, setNextIn] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logId, setLogId] = useState(0);

  const push = () => {
    if (nextIn >= input.length) return;
    const value = input[nextIn];
    setStack((current) => [...current, value]);
    setNextIn((index) => index + 1);
    setLogId((id) => id + 1);
    setLog((entries) => [...entries, { id: logId, text: `入栈 ${value}` }]);
  };

  const pop = () => {
    setLogId((id) => id + 1);
    if (stack.length === 0) {
      setLog((entries) => [...entries, { id: logId, text: "无法出栈：栈是空的" }]);
      return;
    }
    const value = stack[stack.length - 1];
    setStack((current) => current.slice(0, -1));
    setLog((entries) => [...entries, { id: logId, text: `出栈 ${value}` }]);
  };

  const reset = () => {
    setStack([]);
    setNextIn(0);
    setLog([]);
  };

  const nextValue = input[nextIn];

  return (
    <div className={styles.bench}>
      <div>
        <p className={styles.label}>入栈顺序</p>
        <ol className={styles.seq}>
          {input.map((value, index) => (
            <li key={`in-${index}`} className={index < nextIn ? styles.used : undefined}>
              {value}
            </li>
          ))}
        </ol>
        <p className={styles.label}>待判序列</p>
        <ol className={styles.seq}>
          {output.map((value, index) => (
            <li key={`out-${index}`} className={styles.target}>
              {value}
            </li>
          ))}
        </ol>
      </div>

      <div>
        <p className={styles.label}>当前栈</p>
        <div className={styles.stack} aria-label={stack.length ? `栈顶是 ${stack[stack.length - 1]}` : "空栈"}>
          {stack.length === 0 ? (
            <span className={styles.empty}>空栈</span>
          ) : (
            [...stack].reverse().map((value, index) => (
              <span key={`${stack.length - index}-${value}`} className={index === 0 ? styles.top : undefined}>
                {value}
                {index === 0 && <small>栈顶</small>}
              </span>
            ))
          )}
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" onClick={push} disabled={nextValue == null}>
            {nextValue == null ? "没有可入栈的数" : `入栈 ${nextValue}`}
          </Button>
          <Button size="sm" variant="secondary" onClick={pop}>
            出栈
          </Button>
          <Button size="sm" variant="ghost" onClick={reset} disabled={stack.length === 0 && nextIn === 0}>
            重置
          </Button>
        </div>
      </div>

      <div>
        <p className={styles.label}>操作记录</p>
        {log.length === 0 ? (
          <p className={styles.emptyLog}>还没有操作。对照待判序列，自己决定下一步。</p>
        ) : (
          <ol className={styles.log}>
            {log.map((entry, index) => (
              <li key={entry.id}>
                <span>{index + 1}</span>
                {entry.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

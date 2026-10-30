"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/components/LanguageProvider";
import type { TokenUsage } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import styles from "./UsageStats.module.css";

const number = new Intl.NumberFormat("zh-CN");

export function UsageStats({
  usage,
  label,
  align = "left",
}: {
  usage?: TokenUsage;
  label?: string;
  align?: "left" | "right";
}) {
  const { tx } = useI18n();
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) {
        ref.current.open = false;
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (!usage) return null;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const summaryText = usage.reportedRequests > 0
    ? `${number.format(totalTokens)} tokens`
    : usage.requests ? tx("未回报") : tx("暂无请求");

  return (
    <details ref={ref} className={cx(styles.usage, align === "right" && styles.alignRight)}>
      <summary className={styles.trigger}>
        {label ?? tx("用量")} · {summaryText}
      </summary>
      <div className={styles.detail}>
        <dl>
          <div><dt>{tx("输入")}</dt><dd>{usage.reportedRequests ? number.format(usage.inputTokens) : tx("未回报")}</dd></div>
          <div><dt>{tx("其中缓存命中")}</dt><dd>{usage.cachedTokens === null ? tx("未回报") : number.format(usage.cachedTokens)}</dd></div>
          <div><dt>{tx("输出")}</dt><dd>{usage.reportedRequests ? number.format(usage.outputTokens) : tx("未回报")}</dd></div>
          <div><dt>{tx("已回报的请求")}</dt><dd>{usage.reportedRequests} / {usage.requests}</dd></div>
        </dl>
        <p>{tx("仅统计功能启用后的实际回报，含对话、学情分析和小结等请求。缓存属于输入，不重复计入总量。未回报部分不估算，不代表完整账单。")}</p>
      </div>
    </details>
  );
}

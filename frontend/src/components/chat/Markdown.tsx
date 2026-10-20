"use client";

import { isValidElement, memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { LearningWidget } from "./LearningWidget";
import { mathRehypePlugins, mathRemarkPlugins } from "./math";
import styles from "./Markdown.module.css";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API is unavailable in some embedded browsers; fall back to a temporary selection.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function CopyButton({ text, label = "复制", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className ?? styles.copy}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        }
      }}
      aria-label={copied ? "已复制" : label}
      title={copied ? "已复制" : label}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      <span>{copied ? "已复制" : label}</span>
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const components: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const className = isValidElement<{ className?: string }>(child) ? child.props.className ?? "" : "";
    const language = /language-([\w+-]+)/.exec(className)?.[1] ?? "";
    const code = textOf(children).replace(/\n$/, "");
    if (language === "knowgap-widget" || language === "widget") {
      return <LearningWidget rawCode={code} />;
    }
    return (
      <div className={styles.codeBlock}>
        <div className={styles.codeHead}>
          <span className={styles.lang}>{language || "代码"}</span>
          <CopyButton text={code} label="复制代码" />
        </div>
        <pre className={styles.pre}>
          <code>{code}</code>
        </pre>
      </div>
    );
  },
  code({ children, className }) {
    return <code className={className ? undefined : styles.inline}>{children}</code>;
  },
  a({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className={styles.tableWrap}>
        <table>{children}</table>
      </div>
    );
  },
};

const remarkPlugins = [remarkGfm, ...(mathRemarkPlugins ?? [])];

/** 模型回复的 Markdown（GFM + $…$ / $$…$$ 公式）。不渲染原始 HTML。 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={mathRehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

"use client";

import { isValidElement, memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight, { type Options as HighlightOptions } from "rehype-highlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import { Check, Copy } from "lucide-react";
import { LearningWidget } from "./LearningWidget";
import { mathRehypePlugins, mathRemarkPlugins } from "./math";
import styles from "./Markdown.module.css";

const highlightOptions: HighlightOptions = {
  languages: { python, javascript, typescript, c, cpp, java, json, bash, sql },
  aliases: {
    javascript: ["js", "jsx"],
    typescript: ["ts", "tsx"],
    python: ["py"],
    cpp: ["c++", "cc"],
    bash: ["sh", "shell", "zsh"],
  },
  plainText: ["knowgap-widget", "widget"],
};

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
      data-copied={copied ? "true" : undefined}
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
          <span className={styles.codeMeta}>
            <span className={styles.dots} aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className={styles.lang}>{language || "代码"}</span>
          </span>
          <CopyButton text={code} label="复制代码" />
        </div>
        <pre className={styles.pre}>{children}</pre>
      </div>
    );
  },
  code({ children, className }) {
    if (!className) return <code className={styles.inline}>{children}</code>;
    return <code className={className}>{children}</code>;
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
const rehypePlugins: Options["rehypePlugins"] = [...(mathRehypePlugins ?? []), [rehypeHighlight, highlightOptions]];

/** 模型回复的 Markdown（GFM + $…$ / $$…$$ 公式）。不渲染原始 HTML。 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

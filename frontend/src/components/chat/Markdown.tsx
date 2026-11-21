"use client";

import { isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight, { type Options as HighlightOptions } from "rehype-highlight";
import { useI18n } from "@/components/LanguageProvider";
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
import { normalizeMathDelimiters } from "@/lib/chat/mathDelimiters";
import { LearningWidget, WidgetLiveContext } from "./LearningWidget";
import { VisualCard } from "./widgets/VisualCard";
import { mathRehypePlugins, mathRemarkPlugins } from "./math";
import type { SourceReference } from "@/lib/types";
import previewStyles from "../MaterialPreviewPanel.module.css";
import styles from "./Markdown.module.css";

export interface CitationPreviewTarget {
  documentId: string;
  title: string;
}

export interface CitationOpenRequest extends CitationPreviewTarget {
  page: number;
  excerpt: string;
}

export type OpenCitation = (request: CitationOpenRequest) => void;

export function toCitationOpenRequest(source: SourceReference): CitationOpenRequest {
  return {
    documentId: source.documentId,
    title: source.title,
    page: typeof source.page === "number" && Number.isInteger(source.page) && source.page > 0 ? source.page : 1,
    excerpt: source.excerpt,
  };
}

const highlightOptions: HighlightOptions = {
  languages: { python, javascript, typescript, c, cpp, java, json, bash, sql },
  aliases: {
    javascript: ["js", "jsx"],
    typescript: ["ts", "tsx"],
    python: ["py"],
    cpp: ["c++", "cc"],
    bash: ["sh", "shell", "zsh"],
  },
  plainText: ["knowgap-widget", "widget", "knowgap-visual"],
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

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const title = label ?? t("common.copy");
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
      aria-label={copied ? t("common.copied") : title}
      title={copied ? t("common.copied") : title}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      <span>{copied ? t("common.copied") : title}</span>
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
      return <div className={styles.widgetSlot}><LearningWidget rawCode={code} /></div>;
    }
    if (language === "knowgap-visual") {
      return <div className={styles.widgetSlot}><VisualCard rawCode={code} /></div>;
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
            <span className={styles.lang}>{language || "code"}</span>
          </span>
          <CopyButton text={code} />
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

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const citationPattern = /\[(?:空间资料|通用资料|资料)[1-9]\d*\]/g;

function citationPlugin(sourceMap: ReadonlyMap<string, SourceReference>) {
  return () => {
    const visit = (node: HastNode) => {
      if (node.type === "element" && (node.tagName === "pre" || node.tagName === "code" || node.tagName === "a")) return;
      if (!node.children) return;
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          continue;
        }
        const replacement: HastNode[] = [];
        let cursor = 0;
        for (const match of child.value.matchAll(citationPattern)) {
          const raw = match[0];
          const start = match.index;
          const source = sourceMap.get(raw.slice(1, -1));
          if (!source) continue;
          if (start > cursor) replacement.push({ type: "text", value: child.value.slice(cursor, start) });
          replacement.push({
            type: "element",
            tagName: "button",
            properties: {
              type: "button",
              className: [previewStyles.citationMark],
              "data-citation-label": source.label,
            },
            children: [{ type: "text", value: raw }],
          });
          cursor = start + raw.length;
        }
        if (replacement.length === 0) continue;
        if (cursor < child.value.length) replacement.push({ type: "text", value: child.value.slice(cursor) });
        node.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
    };
    return (tree: HastNode) => visit(tree);
  };
}

export interface MarkdownProps {
  text: string;
  live?: boolean;
  sources?: readonly SourceReference[];
  onOpenCitation?: OpenCitation;
}

/**
 * 模型回复的 Markdown（GFM + $…$ / $$…$$ 公式，也认 \(…\) / \[…\]）。不渲染原始 HTML。
 * live：文字还在流式写入。学习卡片据此区分「还没写完」和「写坏了」。
 */
export const Markdown = memo(function Markdown({ text, live = false, sources, onOpenCitation }: MarkdownProps) {
  const { t } = useI18n();
  const sourceMap = useMemo(() => {
    const map = new Map<string, SourceReference>();
    for (const source of sources ?? []) if (!map.has(source.label)) map.set(source.label, source);
    return map;
  }, [sources]);
  const citationComponents = useMemo<Components>(() => ({
    ...components,
    button({ node, ...props }) {
      void node;
      const label = props["data-citation-label"] as string | undefined;
      const source = label ? sourceMap.get(label) : undefined;
      if (!source || !onOpenCitation) return <button {...props} />;
      return (
        <button
          {...props}
          aria-label={t("sources.openInline", { label: source.label })}
          title={source.excerpt || t("sources.open", { title: source.title })}
          onClick={() => onOpenCitation(toCitationOpenRequest(source))}
        />
      );
    },
  }), [onOpenCitation, sourceMap, t]);
  const activeRehypePlugins = useMemo<Options["rehypePlugins"]>(() => (
    sources && onOpenCitation ? [...(rehypePlugins ?? []), citationPlugin(sourceMap)] : rehypePlugins
  ), [onOpenCitation, sourceMap, sources]);
  return (
    <div className={styles.markdown}>
      <WidgetLiveContext.Provider value={live}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={activeRehypePlugins} components={sources && onOpenCitation ? citationComponents : components}>
          {normalizeMathDelimiters(text)}
        </ReactMarkdown>
      </WidgetLiveContext.Provider>
    </div>
  );
});

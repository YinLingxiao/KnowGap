"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, RotateCcw, Shapes } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { VISUAL_MSG, buildVisualSrcdoc, extractVisualBody, readThemeVars } from "@/lib/chat/visualSandbox";
import { WidgetLiveContext } from "../LearningWidget";
import { askInComposer, useWidgetScope } from "./widgetEvents";
import styles from "./VisualCard.module.css";

function pushTheme(frame: HTMLIFrameElement | null) {
  frame?.contentWindow?.postMessage({
    type: VISUAL_MSG.theme,
    vars: readThemeVars(),
    motionReduced: document.documentElement.dataset.motion === "reduced",
  }, "*");
}

/** ```knowgap-visual``` 的 HTML 放进 sandbox iframe。流式未写完只出骨架，不挂 iframe。 */
export function VisualCard({ rawCode }: { rawCode: string }) {
  const { tx } = useI18n();
  const live = useContext(WidgetLiveContext);
  const conversationId = useWidgetScope();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const [failed, setFailed] = useState(false);
  // 重置：换 key 重建 iframe，动画和滑块回到初始状态
  const [runId, setRunId] = useState(0);
  // 挂载后才建 iframe：SSR 读不到主题变量，且 iframe 的首批消息会早于监听器
  const [mounted, setMounted] = useState(false);
  const body = useMemo(() => extractVisualBody(rawCode), [rawCode]);
  // 只在原文变化时重建文档；之后的主题变化走 postMessage。
  const srcdoc = useMemo(() => (mounted ? buildVisualSrcdoc(
    rawCode,
    readThemeVars(),
    document.documentElement.dataset.motion === "reduced",
  ) : ""), [rawCode, mounted]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setFailed(false);
    setHeight(160);
  }, [rawCode]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== "object") return;
      const message = data as { type?: string; height?: unknown; text?: unknown };
      if (message.type === VISUAL_MSG.height) {
        const next = Math.min(1200, Math.max(40, Math.round(Number(message.height))));
        if (Number.isFinite(next)) setHeight(next);
        return;
      }
      if (message.type === VISUAL_MSG.ask) {
        askInComposer(conversationId, String(message.text ?? ""));
        return;
      }
      if (message.type === VISUAL_MSG.error) setFailed(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [conversationId]);

  useEffect(() => {
    const observer = new MutationObserver(() => pushTheme(iframeRef.current));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-text-size", "data-read-font", "data-motion"],
    });
    return () => observer.disconnect();
  }, []);

  if (live || !mounted) {
    // 标题通常最先写出来：读到了就先显示，等的人知道这张图要画什么
    const title = /<h3\b[^>]*>([^<]{1,60})<\/h3>/i.exec(rawCode)?.[1]?.trim();
    return (
      <div className={styles.building} role="status">
        <div className={styles.kindRow}>
          <span className={styles.kindIcon} aria-hidden><Shapes size={13} /></span>
          <span>{tx("交互图示")}</span>
          <span className={styles.liveTag}><span className={styles.liveDot} aria-hidden />{tx("生成中")}</span>
        </div>
        {title && <strong className={styles.buildingTitle}>{title}</strong>}
        <div className={styles.buildingStage} aria-hidden />
        <span className="sr-only">{tx("正在生成图示…")}</span>
      </div>
    );
  }

  if (!body.trim() || failed) {
    return (
      <details className={styles.failCard}>
        <summary>
          <CircleAlert size={13} aria-hidden />
          <span>{tx("图示没能生成")}</span>
          <span>· {tx("查看原文")}</span>
        </summary>
        <pre>{rawCode}</pre>
      </details>
    );
  }

  return (
    <section className={styles.visualCard} aria-label={tx("交互图示")}>
      <div className={styles.kindRow}>
        <span className={styles.kindIcon} aria-hidden><Shapes size={13} /></span>
        <span>{tx("交互图示")}</span>
        <button type="button" className={styles.resetBtn} onClick={() => { setFailed(false); setHeight(160); setRunId((value) => value + 1); }}>
          <RotateCcw size={12} aria-hidden />
          <span>{tx("重置")}</span>
        </button>
      </div>
      <iframe
        key={runId}
        ref={iframeRef}
        className={styles.frame}
        sandbox="allow-scripts"
        srcDoc={srcdoc}
        title={tx("交互图示")}
        style={{ height }}
        onLoad={() => pushTheme(iframeRef.current)}
      />
    </section>
  );
}

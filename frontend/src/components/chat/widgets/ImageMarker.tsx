"use client";

import { useMemo, useState } from "react";
import { CircuitBoard } from "lucide-react";
import { cx } from "@/lib/cx";
import { useImageUrl } from "./VisionBits";
import { splitVisionMarkers } from "./visionData";
import styles from "./VisionWidgets.module.css";

/** Thumbnail of an uploaded image; click to enlarge. */
export function ImageThumb({ imageId }: { imageId: string }) {
  const { url, failed } = useImageUrl(imageId);
  const [open, setOpen] = useState(false);
  if (!url) {
    return <span className={cx(styles.thumb, styles.thumbLoading)}>{failed ? "图片无法加载" : "图片加载中…"}</span>;
  }
  return (
    <button
      type="button"
      className={cx(styles.thumb, open && styles.thumbOpen)}
      aria-expanded={open}
      aria-label={open ? "收起上传的图片" : "放大查看上传的图片"}
      onClick={() => setOpen((value) => !value)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- authenticated blob: URL, not optimizable by next/image */}
      <img src={url} alt="上传的图片" />
    </button>
  );
}

/**
 * Renders a user message that contains [[kg-image:...]] / [[kg-netlist:...@v]] markers.
 * Use it in place of the plain text when hasVisionMarker(content) is true.
 */
export function VisionMarkedText({ text }: { text: string }) {
  const segments = useMemo(() => splitVisionMarkers(text), [text]);
  return (
    <>
      {segments.map((segment, i) => {
        if (segment.kind === "image") return <ImageThumb key={i} imageId={segment.imageId} />;
        if (segment.kind === "netlist") {
          return (
            <span key={i} className={styles.markerChip}>
              <CircuitBoard size={11} aria-hidden />
              已确认的电路拓扑 · 第 {segment.version} 版
            </span>
          );
        }
        // Markers sit on their own lines; drop the line breaks around them.
        const body = segment.text.replace(/^\n+|\n+$/g, "");
        return body ? <span key={i} className={styles.markerText}>{body}</span> : null;
      })}
    </>
  );
}

"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cx } from "@/lib/cx";
import styles from "./WorkingIndicator.module.css";

/** 同一组六个粒子在四种形态间移动，不替换图标，文字位置始终稳定。 */
const DOTS = Array.from({ length: 6 }, (_, index) => {
  const angle = index * Math.PI / 3 - Math.PI / 2;
  const diamond = [[0, -5], [5, 0], [0, 5], [-5, 0], [-1.5, 0], [1.5, 0]][index];
  return {
    "--ring-x": `${Math.cos(angle) * 5}px`,
    "--ring-y": `${Math.sin(angle) * 5}px`,
    "--wave-x": `${(index - 2.5) * 2.3}px`,
    "--wave-y": `${Math.sin(index * Math.PI / 2) * 2.5}px`,
    "--diamond-x": `${diamond[0]}px`,
    "--diamond-y": `${diamond[1]}px`,
    "--petal-angle": `${index * 60}deg`,
    "--delay": `${index * -0.18}s`,
  } as CSSProperties;
});

export function WorkingGlyph({ size = 16, className }: { size?: number; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let visible = true;
    const update = () => setPaused(document.hidden || !visible);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    if (ref.current) observer.observe(ref.current);
    document.addEventListener("visibilitychange", update);
    update();
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return (
    <svg ref={ref} className={cx(styles.glyph, className)} data-paused={paused || undefined}
      width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <g className={styles.orbit}>
        {DOTS.map((dot, index) => (
          <g key={index} className={styles.particle} style={dot}>
            <circle className={styles.dot} cx="8" cy="8" r="1.2" />
          </g>
        ))}
      </g>
    </svg>
  );
}

/** 「1分4秒」「12秒」：等待越久，越需要知道它确实还在工作 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分${seconds % 60}秒`;
}

/** 从挂载起计时；挂载时间就是这次等待开始的时间 */
export function useElapsedSeconds(active = true): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const tick = () => setSeconds(Math.floor((Date.now() - started) / 1000));
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return seconds;
}

interface WorkingIndicatorProps {
  /** 正在做什么，如「正在思考」「正在执行终端命令」 */
  label: string;
}

/** 等待回复时的一行状态：动效图形 + 正在做什么 + 已等待多久 */
export function WorkingIndicator({ label }: WorkingIndicatorProps) {
  const seconds = useElapsedSeconds();
  return (
    <p className={styles.line} role="status">
      <WorkingGlyph />
      <span className={styles.label}>{label}</span>
      {seconds >= 3 && <span className={styles.time} aria-live="off">{formatElapsed(seconds)}</span>}
    </p>
  );
}

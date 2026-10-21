"use client";

import { useEffect, useState } from "react";
import { focusApi } from "@/lib/focus/api";
import type { FocusHeatmap as Heatmap } from "@/lib/focus/types";
import styles from "./FocusHeatmap.module.css";

function level(minutes: number) {
  if (minutes <= 0) return 0;
  if (minutes < 25) return 1;
  if (minutes < 60) return 2;
  if (minutes < 120) return 3;
  return 4;
}

function formatFocus(minutes: number) {
  const seconds = Math.round(minutes * 60);
  if (seconds <= 0) return "0 分钟";
  if (seconds < 60) return `${seconds} 秒`;
  const whole = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${whole} 分 ${rest} 秒` : `${whole} 分钟`;
}

function tip(day: Heatmap["days"][number]) {
  return `${day.date} · 专注 ${formatFocus(day.focusMinutes)} · 攻克误区 ${day.misconceptionsResolved} · 归档 Thread ${day.threadsResolved}`;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

export function FocusHeatmap() {
  const [data, setData] = useState<Heatmap | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void focusApi.heatmap(12)
      .then((heatmap) => { if (!cancelled) setData(heatmap); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className={styles.empty}>热力图加载失败</p>;
  if (!data) return <p className={styles.empty}>加载中</p>;

  const empty = data.days.every((day) => day.focusMinutes <= 0 && day.misconceptionsResolved === 0 && day.threadsResolved === 0);
  if (empty) return <p className={styles.empty}>这 12 周还没有专注记录。完成一次番茄钟后，当天的格子会亮起来。</p>;

  return (
    <div className={styles.board}>
      <div className={styles.days} aria-hidden>
        {WEEKDAYS.map((label) => <span key={label}>{label}</span>)}
      </div>
      <div className={styles.grid}>
        {data.days.map((day) => (
          <div
            key={day.date}
            className={styles.cell}
            data-level={level(day.focusMinutes)}
            title={tip(day)}
            role="img"
            aria-label={tip(day)}
          />
        ))}
      </div>
    </div>
  );
}

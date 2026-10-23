"use client";

import { useEffect, useRef, useState } from "react";

/** 两次刷新的间隔：Markdown 每次都要重新解析，约 30 次/秒已经足够顺滑 */
const FRAME_MS = 32;
/** 每次最多追加的字符数，避免大段文字一下子涌出来 */
const MAX_STEP = 48;

function motionReduced(): boolean {
  return document.documentElement.dataset.motion === "reduced"
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 流式文字的平滑显示：服务端按 token 一团一团地送，直接渲染会一跳一跳。
 * 这里把还没显示的部分按比例匀速放出，积压越多放得越快，几百毫秒内一定追平。
 * 不是已显示文字的延续（重新生成、存储后的核对结果替换）时直接换成新文字。
 */
export function useSmoothText(target: string, live: boolean): string {
  const [shown, setShown] = useState(target);
  const latest = useRef(target);
  latest.current = target;
  const continues = target.startsWith(shown);
  const behind = continues && shown.length < target.length;
  const snap = !continues || (behind && !live && shown === "");

  useEffect(() => {
    if (snap) setShown(target);
  }, [snap, target]);

  useEffect(() => {
    if (!behind || snap) return;
    if (document.hidden || motionReduced()) {
      setShown(latest.current);
      return;
    }
    // 定时器只在「已显示的文字变了」时重新计时：服务端来得再密，也不会把它一直推迟。
    // 不用 requestAnimationFrame：内嵌窗口或被遮挡时它会被降到每秒一两帧，文字会严重滞后。
    const timer = window.setTimeout(() => {
      setShown((current) => {
        const full = latest.current;
        if (!full.startsWith(current)) return full;
        const backlog = full.length - current.length;
        if (backlog <= 0) return current;
        let end = current.length + Math.min(MAX_STEP, Math.max(1, Math.round(backlog * 0.16)));
        // 不把一个 emoji / 生僻字的两个代码单元拆开显示
        const code = full.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff && end < full.length) end += 1;
        return full.slice(0, end);
      });
    }, FRAME_MS);
    return () => window.clearTimeout(timer);
  }, [behind, snap, shown]);

  return snap ? target : shown;
}

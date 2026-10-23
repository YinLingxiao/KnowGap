"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface Thumb {
  x: number;
  width: number;
  /** 第一次定位之后才允许滑动，避免打开面板时从 0 位置飞过来 */
  animate: boolean;
}

/**
 * 分段控制器的滑块：量出当前选中项（aria-selected="true"）的位置，
 * 切换时让滑块滑过去，而不是每个按钮各自闪一下背景。
 * 标签文字显示 / 隐藏会改变按钮宽度，所以容器尺寸变化时也要重新量。
 */
export function useSlidingThumb(container: RefObject<HTMLElement | null>, deps: readonly unknown[]): Thumb | null {
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!active) {
        setThumb(null);
        placed.current = false;
        return;
      }
      const next = { x: active.offsetLeft, width: active.offsetWidth };
      setThumb((previous) => (previous && previous.x === next.x && previous.width === next.width
        ? previous
        : { ...next, animate: placed.current }));
      placed.current = true;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 由调用方给出会改变选中项或宽度的依赖
  }, [container, ...deps]);

  return thumb;
}

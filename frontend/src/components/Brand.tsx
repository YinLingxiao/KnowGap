import type { CSSProperties } from "react";
import styles from "./Brand.module.css";

/** Approved 02B book mark. Inherits the surrounding theme's foreground. */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 80" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d="M0 80V10Q0 0 10 0C24 0 36 5 46 11V80Z" />
      <path d="M54 80V11C64 5 76 0 90 0Q100 0 100 10V80Z" />
    </svg>
  );
}

/** Fixed vector lettering, not a system-font substitution. */
export function BrandWordmark({ width = 112 }: { width?: number }) {
  return <span role="img" aria-label="KnowGap" className={styles.wordmark} style={{ "--brand-width": `${width}px` } as CSSProperties} />;
}

/** Horizontal symbol + wordmark. The wordmark scales with the mark unless a width is given. */
export function BrandLockup({ size = 24, wordmarkWidth }: { size?: number; wordmarkWidth?: number }) {
  return (
    <span className={styles.lockup} style={{ "--brand-gap": `${Math.round(size / 3)}px` } as CSSProperties}>
      <BrandMark size={size} />
      <BrandWordmark width={wordmarkWidth ?? Math.round(size * 3.9)} />
    </span>
  );
}

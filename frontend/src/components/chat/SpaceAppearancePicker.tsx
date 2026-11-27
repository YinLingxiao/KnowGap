"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RotateCcw, Search, X } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { SPACE_COLORS } from "@/lib/chat/space";
import { cx } from "@/lib/cx";
import { DEFAULT_SPACE_ICON, SpaceIcon, filterSpaceIcons } from "./SpaceIcon";
import styles from "./SpaceAppearancePicker.module.css";

const PICKER_WIDTH = 276;
const PICKER_EDGE = 12;
const PICKER_GAP = 8;
const PICKER_ESTIMATED_HEIGHT = 320;

export interface PickerPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/** 按锚点与视口尺寸计算 fixed 弹层坐标：优先放下方，放不下翻到上方，水平与垂直都不超出视口。 */
export function computePickerPosition(
  anchor: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
  popoverHeight = PICKER_ESTIMATED_HEIGHT,
): PickerPosition {
  const maxWidth = Math.max(0, viewport.width - PICKER_EDGE * 2);
  const width = Math.min(PICKER_WIDTH, maxWidth);
  const left = Math.max(PICKER_EDGE, Math.min(anchor.left - 6, viewport.width - PICKER_EDGE - width));
  const maxHeight = Math.max(120, viewport.height - PICKER_EDGE * 2);
  const height = Math.min(popoverHeight, maxHeight);
  const availBelow = viewport.height - anchor.bottom - PICKER_GAP - PICKER_EDGE;
  const availAbove = anchor.top - PICKER_GAP - PICKER_EDGE;
  let top: number;
  if (height <= availBelow) {
    top = anchor.bottom + PICKER_GAP;
  } else if (height <= availAbove) {
    top = anchor.top - PICKER_GAP - height;
  } else {
    top = Math.max(PICKER_EDGE, viewport.height - PICKER_EDGE - height);
  }
  return { top, left, width, maxHeight };
}

interface SpaceAppearancePickerProps {
  icon: string;
  color: string;
  onChange: (next: { icon: string; color: string }) => void;
}

/**
 * 学习空间的图标与颜色：一个色块按钮，点开是挂到 body 上的弹层，
 * 所以放在会滚动的弹窗里也不会被裁剪。Esc 先关弹层，不会连带关掉外面的弹窗。
 */
export function SpaceAppearancePicker({ icon, color, onChange }: SpaceAppearancePickerProps) {
  const { t, tx } = useI18n();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PickerPosition | null>(null);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const visibleIcons = useMemo(() => filterSpaceIcons(query), [query]);
  const isDefault = icon === DEFAULT_SPACE_ICON && color === SPACE_COLORS[0];

  const place = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!anchor || typeof window === "undefined") return;
    // offsetHeight 不受弹出动画的 scale 影响
    const measured = popoverRef.current?.offsetHeight || PICKER_ESTIMATED_HEIGHT;
    setPos(computePickerPosition(anchor, { width: window.innerWidth, height: window.innerHeight }, measured));
  }, []);

  // 搜索结果变多变少时弹层高度会变：重新定位，免得往上翻开后悬空
  useLayoutEffect(() => {
    if (open) place();
  }, [open, visibleIcons.length, place]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setPos(null);
      return;
    }
    searchRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      // 点在外面只关掉选择器：捕获阶段拦下，外层弹窗的遮罩不会因为这一下把整个弹窗关掉
      event.stopPropagation();
      setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (popoverRef.current?.contains(event.target as Node)) return; // 图标网格自己滚动不用重新定位
      place();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      // 捕获阶段拦下：只关弹层，外层弹窗的 Esc 处理收不到这次按键。
      event.stopPropagation();
      setOpen(false);
      anchorRef.current?.querySelector("button")?.focus(); // 焦点回到图标按钮
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  const popover = open ? (
    <div
      ref={popoverRef}
      className={styles.pickerPopover}
      role="dialog"
      aria-label={tx("图标与颜色选择器")}
      style={pos ? {
        top: `${pos.top}px`,
        left: `${pos.left}px`,
        width: `${pos.width}px`,
        maxHeight: `${pos.maxHeight}px`,
      } : undefined}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className={styles.pickerSearch}>
        <Search size={13} aria-hidden />
        <input
          ref={searchRef}
          type="text"
          value={query}
          placeholder={tx("搜索图标…")}
          aria-label={tx("搜索图标")}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className={styles.searchClear}
            aria-label={tx("清空搜索")}
            onClick={() => { setQuery(""); searchRef.current?.focus(); }}
          >
            <X size={12} aria-hidden />
          </button>
        )}
      </div>

      <div className={styles.colorRow} role="radiogroup" aria-label={t("createSpace.colorAria")}>
        {SPACE_COLORS.map((item) => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={color === item}
            className={color === item ? styles.dotOn : styles.dot}
            style={{ background: item }}
            onClick={() => onChange({ icon, color: item })}
            aria-label={tx("颜色 {value}", { value: item })}
          />
        ))}
      </div>

      {visibleIcons.length === 0 ? (
        <p className={styles.pickerEmpty}>{tx("没有匹配的图标")}</p>
      ) : (
        <div className={styles.iconGrid} role="listbox" aria-label={tx("可选图标")}>
          {visibleIcons.map((entry) => {
            const active = icon === entry.id;
            const IconComp = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={active}
                className={cx(styles.iconCell, active && styles.iconCellActive)}
                style={active ? { color } : undefined}
                title={tx(entry.label)}
                aria-label={tx(entry.label)}
                onClick={() => onChange({ icon: entry.id, color })}
              >
                <IconComp size={15} aria-hidden />
              </button>
            );
          })}
        </div>
      )}

      <div className={styles.pickerFoot}>
        <button
          type="button"
          className={styles.resetBtn}
          disabled={isDefault}
          onClick={() => onChange({ icon: DEFAULT_SPACE_ICON, color: SPACE_COLORS[0] })}
        >
          <RotateCcw size={12} aria-hidden />
          <span>{tx("重置图标与颜色")}</span>
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div className={styles.colorAnchor} ref={anchorRef}>
      <button
        type="button"
        className={cx(styles.iconSwatch, open && styles.iconSwatchOpen)}
        style={{ color }}
        onClick={() => {
          if (!open) place();
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={tx("选择图标和颜色")}
        title={tx("选择图标和颜色")}
      >
        <span key={`${icon}-${color}`} className={styles.swatchGlyph}>
          <SpaceIcon name={icon} size={15} />
        </span>
      </button>
      {popover && (typeof document !== "undefined" ? createPortal(popover, document.body) : popover)}
    </div>
  );
}

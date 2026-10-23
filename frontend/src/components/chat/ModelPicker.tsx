"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Cpu, Settings } from "lucide-react";
import { toApiError } from "@/lib/api/errors";
import {
  MODELS_CHANGED_EVENT, modelLibraryApi, type CatalogModel, type ModelLibraryClient, type ModelTags, type ReasoningLevel,
} from "@/lib/api/model-library";
import { cx } from "@/lib/cx";
import styles from "./ModelPicker.module.css";

export const OPEN_SETTINGS_EVENT = "knowgap:open-settings";

const REASONING_TEXT: Record<ReasoningLevel, string | null> = {
  none: null, low: "低", medium: "中", high: "高",
};

export function reasoningLabel(level: ReasoningLevel): string | null {
  return REASONING_TEXT[level] ?? null;
}

export function supportsReasoning(model: CatalogModel | null): boolean {
  return model?.tags.reasoning === "low" || model?.tags.reasoning === "medium" || model?.tags.reasoning === "high";
}

export function shortModelName(name: string): string {
  const text = name.trim();
  if (text.length <= 8) return text;
  const tail = text.split(/[-_/.:]/).filter(Boolean).pop() ?? text;
  if (tail.length >= 2 && tail.length <= 8 && tail !== text) return tail;
  return `${text.slice(0, 7)}…`;
}

export function filterCatalog(models: CatalogModel[], query: string): CatalogModel[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) =>
    model.name.toLowerCase().includes(needle)
    || model.modelId.toLowerCase().includes(needle)
    || model.providerName.toLowerCase().includes(needle));
}

export function groupCatalog(models: CatalogModel[]): Array<{ providerId: string; providerName: string; models: CatalogModel[] }> {
  const groups: Array<{ providerId: string; providerName: string; models: CatalogModel[] }> = [];
  for (const model of models) {
    const last = groups[groups.length - 1];
    if (last && last.providerId === model.providerId) last.models.push(model);
    else groups.push({ providerId: model.providerId, providerName: model.providerName, models: [model] });
  }
  return groups;
}

export function effectiveModel(models: CatalogModel[], modelKey: string | null): CatalogModel | null {
  if (modelKey) {
    const chosen = models.find((model) => model.key === modelKey);
    if (chosen) return chosen;
  }
  return models.find((model) => model.isDefault) ?? null;
}

export function usesDefaultModel(models: CatalogModel[], modelKey: string | null): boolean {
  const fallback = models.find((model) => model.isDefault);
  if (!modelKey) return true;
  if (fallback && modelKey === fallback.key) return true;
  return !models.some((model) => model.key === modelKey);
}

export function choiceFor(model: CatalogModel, models: CatalogModel[]): string | null {
  const fallback = models.find((item) => item.isDefault);
  if (fallback && model.key === fallback.key) return null;
  return model.key;
}

export function nextIndex(current: number, key: "ArrowDown" | "ArrowUp", count: number): number {
  if (count <= 0) return 0;
  if (key === "ArrowDown") return Math.min(count - 1, current + 1);
  return Math.max(0, current - 1);
}

export interface ModelPickerProps {
  modelKey: string | null;
  conversationId?: string | null;
  client?: ModelLibraryClient;
  disabled?: boolean;
  disabledReason?: string;
  suspended?: boolean;
  error?: string;
  defaultOpen?: boolean;
  initialQuery?: string;
  onSelect: (modelKey: string | null) => Promise<boolean> | boolean;
  onManage?: () => void;
  onResolved?: (model: CatalogModel | null) => void;
  onOpenChange?: (open: boolean) => void;
}

function TagList({ tags }: { tags: ModelTags }) {
  const reasoning = reasoningLabel(tags.reasoning);
  if (!reasoning && !tags.vision && !tags.label) return null;
  return (
    <span className={styles.tags}>
      {reasoning && <span className={styles.tag} title={`推理强度：${reasoning}`}>{reasoning}</span>}
      {tags.vision && <span className={styles.tag}>视觉</span>}
      {tags.label && <span className={cx(styles.tag, tags.label === "Pro" && styles.tagPro)}>{tags.label}</span>}
    </span>
  );
}

export function ModelPicker({
  modelKey, conversationId, client = modelLibraryApi, disabled = false,
  disabledReason = "正在生成，请等这条回复完成后再切换模型", suspended = false, error = "",
  defaultOpen = false, initialQuery = "", onSelect, onManage, onResolved, onOpenChange,
}: ModelPickerProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ below: boolean; room: number }>({ below: false, room: 280 });
  const onResolvedRef = useRef(onResolved);
  const onOpenChangeRef = useRef(onOpenChange);
  const seenConversation = useRef(conversationId);
  onResolvedRef.current = onResolved;
  onOpenChangeRef.current = onOpenChange;
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);

  const setMenu = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChangeRef.current?.(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.listSelectableModels()
      .then((items) => {
        if (cancelled) return;
        setModels(items);
        setLoadError("");
      })
      .catch((reason) => {
        if (!cancelled) setLoadError(toApiError(reason).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    const reload = () => {
      client.listSelectableModels().then(setModels).catch(() => undefined);
    };
    window.addEventListener(MODELS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, reload);
  }, [client]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    client.listSelectableModels()
      .then((items) => { if (!cancelled) setModels(items); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, client]);

  useEffect(() => {
    if (seenConversation.current === conversationId) return;
    seenConversation.current = conversationId;
    setMenu(false);
  }, [conversationId, setMenu]);
  useEffect(() => { if (disabled || suspended) setMenu(false); }, [disabled, suspended, setMenu]);

  const resolved = loading ? null : effectiveModel(models, modelKey);
  useEffect(() => {
    onResolvedRef.current?.(resolved);
  }, [resolved]);

  const visible = filterCatalog(models, query);
  const groups = groupCatalog(visible);
  const rowCount = visible.length + 1;

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(rowCount - 1, 0)));
  }, [rowCount]);

  // The menu opens upward by default; flip it below the trigger when the window has no room above
  // (the home composer sits near the top edge), and cap the list to the room that is left.
  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const popover = popoverRef.current;
    if (!root || !popover) return;
    const rect = root.getBoundingClientRect();
    const margin = 12;
    const above = rect.top - margin;
    const below = window.innerHeight - rect.bottom - margin;
    const chrome = popover.offsetHeight - (popover.querySelector<HTMLElement>("[role='listbox']")?.offsetHeight ?? 0);
    const needed = popover.offsetHeight + 6;
    const flip = needed > above && below > above;
    const space = Math.max(flip ? below : above, 0);
    setPlacement({ below: flip, room: Math.max(Math.floor(space - chrome - 6), 96) });
  }, [open, query, models]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [open, active, query]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setMenu]);

  const manage = () => {
    setMenu(false);
    if (onManage) onManage();
    else window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { tab: "models" } }));
  };

  const pick = async (model: CatalogModel) => {
    if (disabled || saving) return;
    const next = choiceFor(model, models);
    if ((next ?? null) === (modelKey ?? null)) {
      setMenu(false);
      return;
    }
    setSaving(true);
    try {
      const ok = await onSelect(next);
      if (ok) setMenu(false);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => nextIndex(current, key, rowCount));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenu(false);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (active >= visible.length) manage();
    else {
      const model = visible[active];
      if (model) void pick(model);
    }
  };

  if (!loading && models.length === 0) {
    return (
      <div className={styles.root}>
        <button type="button" className={cx(styles.trigger, styles.configure)} onClick={manage} title={loadError || "配置模型"}>
          配置模型
        </button>
        {error && <p className={styles.failure} role="alert">{error}</p>}
      </div>
    );
  }

  const current = effectiveModel(models, modelKey);
  const name = current?.name || "模型";
  const usingDefault = !loading && usesDefaultModel(models, modelKey);
  const persisted = usingDefault ? null : modelKey;
  const title = disabled ? disabledReason : loading ? "正在加载模型" : usingDefault ? "默认" : name;
  const label = disabled ? disabledReason : usingDefault ? `默认模型 ${name}` : `当前模型 ${name}`;
  let index = 0;
  const blocks: ReactNode[] = [];
  for (const group of groups) {
    blocks.push(<p key={`group-${group.providerId}`} className={styles.group}>{group.providerName}</p>);
    for (const model of group.models) {
      const rowIndex = index;
      index += 1;
      const selected = choiceFor(model, models) === persisted;
      blocks.push(
        <button
          key={model.key}
          id={`${listId}-opt-${rowIndex}`}
          type="button"
          role="option"
          aria-selected={selected}
          data-active={rowIndex === active ? "true" : "false"}
          className={cx(styles.row, rowIndex === active && styles.rowActive)}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(rowIndex)}
          onClick={() => void pick(model)}
        >
          <span className={styles.rowMain}>
            <span className={styles.rowName} title={model.name}>{model.name}</span>
            <TagList tags={model.tags} />
          </span>
          <span className={styles.rowMeta}>
            {model.isDefault && <span className={styles.defaultBadge}>默认</span>}
            {selected && <Check size={13} className={styles.check} aria-hidden />}
          </span>
        </button>,
      );
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={cx(styles.trigger, open && styles.triggerOpen)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        aria-busy={saving || undefined}
        aria-label={label}
        title={title}
        onClick={() => { if (!disabled && !saving) setMenu(!open); }}
      >
        <span className={styles.wide}>{name}</span>
        <span className={styles.compact}>
          <Cpu size={13} aria-hidden />
          <span>{shortModelName(name)}</span>
        </span>
        <ChevronDown size={12} className={styles.chevron} aria-hidden />
      </button>
      {error && <p className={styles.failure} role="alert">{error}</p>}
      {open && (
        <div
          ref={popoverRef}
          className={cx(styles.popover, placement.below && styles.popoverBelow)}
          style={{ "--picker-room": `${placement.room}px` } as CSSProperties}
          role="dialog"
          aria-label="选择模型"
          onKeyDown={onKeyDown}
        >
          <input
            ref={searchRef}
            className={styles.search}
            value={query}
            placeholder="搜索模型"
            aria-label="搜索模型"
            aria-controls={listId}
            aria-activedescendant={`${listId}-opt-${active}`}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          <div id={listId} className={styles.list} role="listbox" aria-label="模型">
            {blocks}
            {visible.length === 0 && <p className={styles.empty}>没有匹配的模型</p>}
          </div>
          <button
            id={`${listId}-opt-${visible.length}`}
            type="button"
            data-active={active === visible.length ? "true" : "false"}
            className={cx(styles.manage, active === visible.length && styles.rowActive)}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(visible.length)}
            onClick={manage}
          >
            <Settings size={13} aria-hidden />
            管理模型…
          </button>
        </div>
      )}
    </div>
  );
}

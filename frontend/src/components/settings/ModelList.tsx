"use client";

import { useMemo, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import type { LibraryModel, ModelLabel, ModelTags, ReasoningLevel } from "@/lib/api/model-library";
import { EMPTY_TAGS } from "@/lib/api/model-library";
import { cx } from "@/lib/cx";
import { Button } from "../ui/Button";
import { EditorDialog } from "./EditorDialog";
import styles from "./ModelLibrary.module.css";

const REASONING: Array<{ id: ReasoningLevel; label: string }> = [
  { id: "none", label: "无" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
];

const REASONING_LABEL: Record<ReasoningLevel, string> = { none: "无", low: "低", medium: "中", high: "高" };

interface ModelListProps {
  models: LibraryModel[];
  busy: boolean;
  onToggle: (model: LibraryModel, enabled: boolean) => void;
  onDelete: (model: LibraryModel) => void;
  onTags: (model: LibraryModel, tags: ModelTags) => void;
}

export function ModelList({ models, busy, onToggle, onDelete, onTags }: ModelListProps) {
  const { tx } = useI18n();
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<LibraryModel | null>(null);
  const [tags, setTags] = useState<ModelTags>(EMPTY_TAGS);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => models.filter((model) => !needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle)),
    [models, needle],
  );

  const openTags = (model: LibraryModel) => {
    setEditing(model);
    setTags(model.tags);
  };

  return (
    <div>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={13} aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={tx("搜索模型")} placeholder={tx("搜索模型")} />
        </label>
      </div>
      {models.length === 0 ? (
        <p className={styles.note}>{tx("还没有模型。可以获取列表，或手动添加。")}</p>
      ) : visible.length === 0 ? (
        <p className={styles.note}>{tx("没有匹配的模型。")}</p>
      ) : (
        <div className={styles.models}>
          {visible.map((model) => (
            <div key={model.id} className={styles.modelRow}>
              <label className={styles.switch}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={model.enabled}
                  disabled={busy}
                  aria-label={tx("启用模型 {name}", { name: model.name })}
                  onChange={(event) => onToggle(model, event.target.checked)}
                />
                <span aria-hidden />
              </label>
              <div className={styles.modelMain}>
                <div className={styles.modelName}>{model.name}</div>
                <div className={styles.modelId}>{model.id}</div>
              </div>
              <div className={styles.modelSide}>
                <button type="button" className={cx(styles.tag, model.tags.reasoning !== "none" && styles.tagOn)} disabled={busy} onClick={() => openTags(model)}>
                  {tx("推理 {level}", { level: tx(REASONING_LABEL[model.tags.reasoning]) })}
                </button>
                <button type="button" className={cx(styles.tag, model.tags.vision && styles.tagOn)} aria-pressed={model.tags.vision} disabled={busy} onClick={() => openTags(model)}>
                  {tx("视觉")}
                </button>
                <button type="button" className={cx(styles.tag, model.tags.tools && styles.tagOn)} aria-pressed={model.tags.tools} disabled={busy} onClick={() => openTags(model)}>
                  {tx("工具")}
                </button>
                <button type="button" className={cx(styles.tag, model.tags.label && styles.tagOn)} disabled={busy} onClick={() => openTags(model)}>
                  {model.tags.label ? tx(model.tags.label) : tx("无角标")}
                </button>
                <button
                  type="button"
                  className={cx(styles.textButton, styles.textButtonDanger)}
                  disabled={busy}
                  aria-label={pendingId === model.id ? tx("确认删除模型 {name}", { name: model.name }) : tx("删除模型 {name}", { name: model.name })}
                  onClick={() => {
                    if (pendingId !== model.id) {
                      setPendingId(model.id);
                      return;
                    }
                    setPendingId(null);
                    onDelete(model);
                  }}
                  onBlur={() => setPendingId((current) => (current === model.id ? null : current))}
                >
                  <Trash2 size={12} aria-hidden />
                  {pendingId === model.id ? tx("确认删除") : tx("删除")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <EditorDialog open={editing !== null} title={editing ? tx("编辑 {name} 的标签", { name: editing.name }) : tx("编辑标签")} description={tx("推理强度、视觉、工具和角标都可以改。")} onClose={() => setEditing(null)}>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>{tx("推理强度")}</span>
            <select
              className={styles.select}
              aria-label={tx("推理强度")}
              value={tags.reasoning}
              onChange={(event) => setTags((current) => ({ ...current, reasoning: event.target.value as ReasoningLevel }))}
            >
              {REASONING.map((item) => <option key={item.id} value={item.id}>{tx(item.label)}</option>)}
            </select>
          </label>
          <label className={styles.checkRow}>
            <input type="checkbox" checked={tags.vision} aria-label={tx("支持视觉")} onChange={(event) => setTags((current) => ({ ...current, vision: event.target.checked }))} />
            {tx("支持视觉")}
          </label>
          <label className={styles.checkRow}>
            <input type="checkbox" checked={tags.tools} aria-label={tx("支持工具")} onChange={(event) => setTags((current) => ({ ...current, tools: event.target.checked }))} />
            {tx("支持工具")}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{tx("角标")}</span>
            <select
              className={styles.select}
              aria-label={tx("角标")}
              value={tags.label ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                const label: ModelLabel | null = value === "新" || value === "Pro" ? value : null;
                setTags((current) => ({ ...current, label }));
              }}
            >
              <option value="">{tx("无")}</option>
              <option value="新">{tx("新")}</option>
              <option value="Pro">Pro</option>
            </select>
          </label>
          <div className={styles.actions}>
            <Button size="sm" onClick={() => setEditing(null)}>{tx("关闭")}</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!editing || busy}
              onClick={() => {
                if (!editing) return;
                onTags(editing, tags);
                setEditing(null);
              }}
            >
              {tx("保存标签")}
            </Button>
          </div>
        </div>
      </EditorDialog>
    </div>
  );
}

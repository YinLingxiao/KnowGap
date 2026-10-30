"use client";

import { Plus } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import type { ProviderPublic } from "@/lib/api/model-library";
import { findProvider } from "@/lib/modelProviders";
import { cx } from "@/lib/cx";
import styles from "./ModelLibrary.module.css";

interface ProviderListProps {
  providers: ProviderPublic[];
  busy: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onAdd: () => void;
}

export function ProviderList({ providers, busy, onOpen, onToggle, onAdd }: ProviderListProps) {
  const { tx } = useI18n();
  const ordered = providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => Number(b.provider.enabled) - Number(a.provider.enabled) || a.index - b.index)
    .map(({ provider }) => provider);

  return (
    <div className={styles.providerGrid} role="list">
      {ordered.map((provider) => {
        const enabledCount = provider.models.filter((model) => model.enabled).length;
        return (
          <div
            key={provider.id}
            role="listitem"
            className={cx(styles.providerCard, !provider.enabled && styles.providerCardOff)}
          >
            <button
              type="button"
              className={styles.providerOpen}
              disabled={busy}
              aria-label={tx("{name}，{state}，{count} 个模型", {
                name: provider.name,
                state: tx(provider.enabled ? "已启用" : "已停用"),
                count: provider.models.length,
              })}
              onClick={() => onOpen(provider.id)}
            >
              <span className={styles.providerName}>{provider.name}</span>
              <span className={styles.providerMeta}>
                {tx(findProvider(provider.preset).name)} · {provider.enabled ? `${enabledCount}/${provider.models.length}` : tx("已停用")}
              </span>
            </button>
            <label className={styles.switch}>
              <input
                type="checkbox"
                role="switch"
                checked={provider.enabled}
                disabled={busy}
                aria-label={tx("启用 {name}", { name: provider.name })}
                onChange={(event) => onToggle(provider.id, event.target.checked)}
              />
              <span aria-hidden />
            </label>
          </div>
        );
      })}
      <button type="button" className={styles.addCard} disabled={busy} onClick={onAdd}>
        <Plus size={15} aria-hidden />
        {tx("添加服务商")}
      </button>
    </div>
  );
}

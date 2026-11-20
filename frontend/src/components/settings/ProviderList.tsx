"use client";

import { ChevronRight } from "lucide-react";
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
}

function providerGlyph(name: string, preset: string): string {
  const clean = (name || preset || "M").trim();
  return clean.slice(0, 1).toUpperCase();
}

export function ProviderList({ providers, busy, onOpen, onToggle }: ProviderListProps) {
  const { tx } = useI18n();
  const ordered = providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => Number(b.provider.enabled) - Number(a.provider.enabled) || a.index - b.index)
    .map(({ provider }) => provider);

  return (
    <div className={styles.providerGrid} role="list">
      {ordered.map((provider) => {
        const enabledCount = provider.models.filter((model) => model.enabled).length;
        const presetLabel = tx(findProvider(provider.preset).name);
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
              <span className={cx(styles.providerBadge, provider.enabled && styles.providerBadgeOn)} aria-hidden>
                {providerGlyph(provider.name, provider.preset)}
              </span>
              <span className={styles.providerInfo}>
                <span className={styles.providerName}>{provider.name}</span>
                <span className={styles.providerMeta}>
                  {presetLabel} · {provider.enabled ? `${enabledCount}/${provider.models.length}` : tx("已停用")}
                </span>
              </span>
              <ChevronRight size={14} className={styles.providerChevron} aria-hidden />
            </button>
            <span className={styles.providerDivider} aria-hidden />
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
    </div>
  );
}

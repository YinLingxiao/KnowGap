"use client";

import { useEffect, useRef } from "react";
import { Database, Palette, X } from "lucide-react";
import type { HealthState } from "@/hooks/useWorkbench";
import { API_BASE_URL, type DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { THEME_ICON, THEME_LABEL, useThemeChoice, type ThemeChoice } from "../ThemeToggle";
import type { AIConfigStatus } from "@/lib/api/ai-config";
import { ModelAccessCard, type ModelSignal } from "./ModelAccessCard";
import styles from "./Settings.module.css";

const THEME_OPTIONS: ThemeChoice[] = ["system", "light", "dark"];

interface SettingsDialogProps {
  source: DataSource;
  health: HealthState;
  studentId: string;
  modelSignal: ModelSignal;
  onCheckHealth: () => void;
  onConfigChange: (config: AIConfigStatus, saved: boolean) => void;
  onClose: () => void;
}

/** 设置：以功能卡片排列。打开即模态，Esc 或点击遮罩关闭 */
export function SettingsDialog({ source, health, studentId, modelSignal, onCheckHealth, onConfigChange, onClose }: SettingsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useThemeChoice();

  // 卸载时节点随之移除，模态层自动释放；不在清理里 close()，否则开发模式的双重挂载会触发 onClose
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className={styles.frame}>
        <header className={styles.head}>
          <h2 id="settings-title" className={styles.title}>
            设置
          </h2>
          <span className={styles.headHint}>
            <kbd>Esc</kbd> 关闭
          </span>
          <button className={styles.close} onClick={onClose} aria-label="关闭设置">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.groupLabel}>功能</p>
          <div className={styles.grid}>
            <ModelAccessCard
              source={source}
              health={health}
              signal={modelSignal}
              onCheckHealth={onCheckHealth}
              onConfigChange={onConfigChange}
            />

            <section className={styles.card} aria-labelledby="settings-theme">
              <header className={styles.cardHead}>
                <span className={styles.cardIcon} aria-hidden>
                  <Palette size={16} />
                </span>
                <div className={styles.cardTitleBlock}>
                  <h3 id="settings-theme" className={styles.cardTitle}>
                    外观
                  </h3>
                  <p className={styles.cardDesc}>选择保存在本机浏览器。</p>
                </div>
              </header>
              <div className={styles.segmented} role="radiogroup" aria-label="主题">
                {THEME_OPTIONS.map((option) => {
                  const Icon = THEME_ICON[option];
                  return (
                    <button
                      key={option}
                      role="radio"
                      aria-checked={theme === option}
                      className={cx(styles.segment, theme === option && styles.segmentOn)}
                      onClick={() => setTheme(option)}
                    >
                      <Icon size={14} aria-hidden />
                      {THEME_LABEL[option]}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className={styles.card} aria-labelledby="settings-data">
              <header className={styles.cardHead}>
                <span className={styles.cardIcon} aria-hidden>
                  <Database size={16} />
                </span>
                <div className={styles.cardTitleBlock}>
                  <h3 id="settings-data" className={styles.cardTitle}>
                    数据与身份
                  </h3>
                  <p className={styles.cardDesc}>
                    由 <code>frontend/.env.local</code> 决定，修改后重启前端。
                  </p>
                </div>
              </header>
              <dl className={styles.statusGrid}>
                <div className={styles.statusRow}>
                  <dt>来源</dt>
                  <dd>
                    {source === "mock" ? <span className={styles.mockText}>Mock 模拟数据</span> : "后端 API"}
                  </dd>
                </div>
                <div className={styles.statusRow}>
                  <dt>后端地址</dt>
                  <dd>
                    <code className={styles.inlineCode}>{API_BASE_URL}</code>
                  </dd>
                </div>
                <div className={styles.statusRow}>
                  <dt>演示身份</dt>
                  <dd>
                    <code className={styles.inlineCode}>{studentId}</code>
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        </div>
      </div>
    </dialog>
  );
}

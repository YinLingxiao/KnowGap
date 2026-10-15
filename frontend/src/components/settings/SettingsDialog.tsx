"use client";

import { useEffect, useRef, useState } from "react";
import { Database, FolderOpen, Palette, X } from "lucide-react";
import { chatApi } from "@/lib/chat/api";
import type { HealthState } from "@/hooks/useWorkbench";
import { API_BASE_URL, type DataSource } from "@/lib/config";
import { cx } from "@/lib/cx";
import { THEME_ICON, THEME_LABEL, useThemeChoice, type ThemeChoice } from "../ThemeToggle";
import type { AIConfigStatus } from "@/lib/api/ai-config";
import { ModelAccessCard, type ModelSignal } from "./ModelAccessCard";
import styles from "./Settings.module.css";

declare global {
  interface Window {
    knowgap?: { selectFolder: () => Promise<string | null> };
  }
}

const THEME_OPTIONS: ThemeChoice[] = ["system", "light", "dark"];

function WorkspaceCard() {
  const [workspace, setWorkspace] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [memoryApproval, setMemoryApproval] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void chatApi.agentSettings().then((settings) => {
      setWorkspace(settings.workspace);
      setAutoApprove(settings.autoApprove);
      setMemoryApproval(settings.memoryWriteApproval);
    }).catch(() => setNote("读不到工作区设置"));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const saved = await chatApi.saveAgentSettings({ workspace, autoApprove, memoryWriteApproval: memoryApproval });
      setWorkspace(saved.workspace);
      setAutoApprove(saved.autoApprove);
      setMemoryApproval(saved.memoryWriteApproval);
      setNote("已保存");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="settings-workspace">
      <header className={styles.cardHead}>
        <span className={styles.cardIcon} aria-hidden>
          <FolderOpen size={16} />
        </span>
        <div className={styles.cardTitleBlock}>
          <h3 id="settings-workspace" className={styles.cardTitle}>工作区</h3>
          <p className={styles.cardDesc}>文件工具只读写这个文件夹。命令可以访问文件夹外的内容，每次执行前都需确认。</p>
        </div>
      </header>
      <div className={styles.fields}>
        <label className={styles.fieldFull}>
          <span className={styles.fieldLabel}>文件夹</span>
          <input className={styles.input} value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="选择或粘贴路径" />
        </label>
      </div>
      <div className={styles.segmented}>
        <button type="button" className={styles.segment} onClick={async () => {
          const picked = await window.knowgap?.selectFolder();
          if (picked) setWorkspace(picked);
        }}>选择文件夹</button>
        <button type="button" className={styles.segment} onClick={() => void save()} disabled={saving}>{saving ? "保存中" : "保存"}</button>
      </div>
      <label className={styles.fieldHint}>
        <input type="checkbox" checked={autoApprove} onChange={(event) => setAutoApprove(event.target.checked)} />
        {" "}自动批准写文件（命令仍需逐次确认）
      </label>
      <label className={styles.fieldHint}>
        <input type="checkbox" checked={memoryApproval} onChange={(event) => setMemoryApproval(event.target.checked)} />
        {" "}记忆写入需确认
      </label>
      {note && <p className={styles.fieldHint}>{note}</p>}
    </section>
  );
}

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

            <WorkspaceCard />

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

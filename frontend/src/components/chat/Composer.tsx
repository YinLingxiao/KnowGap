"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronDown, CornerDownLeft, Dumbbell, FolderOpen, Mic, Plus, ShieldCheck, Square } from "lucide-react";
import type { StreamPhase } from "@/hooks/useChat";
import { getAIConfig } from "@/lib/api/ai-config";
import { chatApi } from "@/lib/chat/api";
import { cx } from "@/lib/cx";
import type { Problem } from "@/lib/types";
import { WIDGET_ASK_EVENT } from "./LearningWidget";
import styles from "./Composer.module.css";

export type ThinkingEffort = "off" | "low" | "medium" | "high";

const EFFORT_OPTIONS: Array<{
  id: ThinkingEffort;
  label: string;
  shortLabel: string;
  desc: string;
  segments: number;
}> = [
  { id: "off", label: "标准（关闭深度思考）", shortLabel: "标准", desc: "直接快速回答，不做额外推演", segments: 0 },
  { id: "low", label: "低（Low）", shortLabel: "低", desc: "轻量梳理要点，兼顾响应速度", segments: 1 },
  { id: "medium", label: "中（Medium）", shortLabel: "中", desc: "平衡响应速度与推导深度", segments: 2 },
  { id: "high", label: "高（High）", shortLabel: "高", desc: "多步严谨推演，适合复杂原理与难题", segments: 3 },
];

const EFFORT_STORAGE_KEY = "knowgap.thinking.effort.v1";
const MODEL_STORAGE_KEY = "knowgap.ai.model.v1";
const EFFORT_EVENT = "knowgap:thinking-effort";
const AGENT_ENV_EVENT = "knowgap:agent-env";

/** 参照 Claude 右下角的三段式圆环思考深度图标 */
function ThinkingGauge({ segments }: { segments: number }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className={styles.gaugeSvg}>
      {/* 右上弧段 (1/3) */}
      <path
        d="M 8 2 A 6 6 0 0 1 13.2 11"
        stroke={segments >= 1 ? "var(--accent)" : "currentColor"}
        strokeOpacity={segments >= 1 ? 1 : 0.3}
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* 底部弧段 (2/3) */}
      <path
        d="M 11.8 12.6 A 6 6 0 0 1 4.2 12.6"
        stroke={segments >= 2 ? "var(--accent)" : "currentColor"}
        strokeOpacity={segments >= 2 ? 1 : 0.3}
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* 左上弧段 (3/3) */}
      <path
        d="M 2.8 11 A 6 6 0 0 1 8 2"
        stroke={segments >= 3 ? "var(--accent)" : "currentColor"}
        strokeOpacity={segments >= 3 ? 1 : 0.3}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  phase: StreamPhase | null;
  busy: boolean;
  problems: Problem[];
  onStartExercise: (problemId: string) => void;
  autoFocusKey: string;
  inputId?: string;
  placeholder?: string;
  /** 首页居中的大输入框 */
  hero?: boolean;
}

export const COMPOSER_ID = "chat-input";
const MAX_HEIGHT = 220;

export function Composer({
  value, onChange, onSend, onStop, phase, busy, problems, onStartExercise, autoFocusKey,
  placeholder = "继续提问，或说说你的理解…", hero = false, inputId = COMPOSER_ID,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [effort, setEffort] = useState<ThinkingEffort>("medium");
  const [modelName, setModelName] = useState<string>("");
  const [workspace, setWorkspace] = useState<string>("");
  const [wsDraft, setWsDraft] = useState<string>("");
  const [autoApprove, setAutoApprove] = useState<boolean>(false);
  const [memApproval, setMemApproval] = useState<boolean>(false);
  const [wsNote, setWsNote] = useState<string>("");
  const menuRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<HTMLDivElement>(null);
  const generating = phase === "connecting" || phase === "streaming";
  const locked = busy || phase === "connecting";

  useEffect(() => {
    try {
      const savedEffort = localStorage.getItem(EFFORT_STORAGE_KEY);
      if (savedEffort === "off" || savedEffort === "low" || savedEffort === "medium" || savedEffort === "high") {
        setEffort(savedEffort);
      }
      const savedModel = localStorage.getItem(MODEL_STORAGE_KEY);
      if (savedModel) setModelName(savedModel);
    } catch { /* ignore */ }

    chatApi.agentSettings()
      .then((res) => {
        setEffort(res.reasoningEffort);
        setWorkspace(res.workspace);
        setWsDraft(res.workspace);
        setAutoApprove(res.autoApprove);
        setMemApproval(res.memoryWriteApproval);
        try { localStorage.setItem(EFFORT_STORAGE_KEY, res.reasoningEffort); } catch { /* ignore */ }
      })
      .catch(() => {});

    getAIConfig()
      .then((cfg) => {
        if (cfg.model) {
          setModelName(cfg.model);
          try { localStorage.setItem(MODEL_STORAGE_KEY, cfg.model); } catch { /* ignore */ }
        }
      })
      .catch(() => {});

    const onSync = (event: Event) => {
      const next = (event as CustomEvent<ThinkingEffort>).detail;
      if (next) setEffort(next);
    };
    const onWidgetAsk = (event: Event) => {
      const prompt = (event as CustomEvent<string>).detail;
      if (prompt) {
        onChange(prompt);
        textareaRef.current?.focus();
      }
    };
    const onEnvSync = (event: Event) => {
      const detail = (event as CustomEvent<{ workspace: string; autoApprove: boolean; memoryWriteApproval: boolean }>).detail;
      if (detail) {
        setWorkspace(detail.workspace);
        setWsDraft(detail.workspace);
        setAutoApprove(detail.autoApprove);
        setMemApproval(detail.memoryWriteApproval);
      }
    };
    window.addEventListener(EFFORT_EVENT, onSync);
    window.addEventListener(WIDGET_ASK_EVENT, onWidgetAsk);
    window.addEventListener(AGENT_ENV_EVENT, onEnvSync);
    return () => {
      window.removeEventListener(EFFORT_EVENT, onSync);
      window.removeEventListener(WIDGET_ASK_EVENT, onWidgetAsk);
      window.removeEventListener(AGENT_ENV_EVENT, onEnvSync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once
  }, []);

  const selectEffort = (next: ThinkingEffort) => {
    setEffort(next);
    setEffortOpen(false);
    try { localStorage.setItem(EFFORT_STORAGE_KEY, next); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent<ThinkingEffort>(EFFORT_EVENT, { detail: next }));
    void chatApi.saveReasoningEffort(next).catch(() => {});
  };

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const fit = () => {
      if (!element.value) {
        element.style.height = "";
        element.style.overflowY = "hidden";
        return;
      }
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
      element.style.overflowY = element.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    };
    fit();
    const observer = new ResizeObserver(() => {
      if (element.value) fit();
    });
    observer.observe(element.parentElement ?? element);
    return () => observer.disconnect();
  }, [value]);

  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) textareaRef.current?.focus();
  }, [autoFocusKey]);

  useEffect(() => {
    if (!menuOpen && !effortOpen && !wsOpen) return;
    const close = (event: MouseEvent) => {
      if (menuOpen && !menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
      if (effortOpen && !effortRef.current?.contains(event.target as Node)) setEffortOpen(false);
      if (wsOpen && !wsRef.current?.contains(event.target as Node)) setWsOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setEffortOpen(false);
        setWsOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, effortOpen, wsOpen]);

  const saveEnv = async (nextWs: string, nextAuto: boolean) => {
    setWsNote("");
    try {
      const saved = await chatApi.saveAgentSettings({
        workspace: nextWs,
        autoApprove: nextAuto,
        memoryWriteApproval: memApproval,
      });
      setWorkspace(saved.workspace);
      setWsDraft(saved.workspace);
      setAutoApprove(saved.autoApprove);
      window.dispatchEvent(new CustomEvent(AGENT_ENV_EVENT, { detail: saved }));
      setWsOpen(false);
    } catch (err) {
      setWsNote(err instanceof Error ? err.message : "工作区路径无效");
    }
  };

  const wsShortName = workspace
    ? workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || workspace
    : "未选择工作区";

  const canSend = Boolean(value.trim()) && !generating && !locked;
  const activeEffort = EFFORT_OPTIONS.find((item) => item.id === effort) ?? EFFORT_OPTIONS[2];

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  return (
    <div className={cx(styles.composer, hero && styles.hero)}>
      <div className={cx(styles.box, locked && styles.locked)}>
        <div className={styles.inputRow}>
          <label htmlFor={inputId} className="sr-only">
            发送消息
          </label>
          <textarea
            id={inputId}
            ref={textareaRef}
            className={styles.input}
            rows={1}
            maxLength={12000}
            value={value}
            readOnly={locked}
            onChange={(event) => onChange(event.target.value)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
          />
          {!hero && (
            generating ? (
              <button className={cx(styles.send, styles.stop, styles.inlineSend)} onClick={onStop} aria-label="停止生成" title="停止生成">
                <Square size={10} fill="currentColor" aria-hidden />
              </button>
            ) : (
              <button className={cx(styles.send, styles.inlineSend)} onClick={onSend} disabled={!canSend} aria-label="发送" title="发送 (Enter)">
                <CornerDownLeft size={14} aria-hidden />
              </button>
            )
          )}
        </div>

        <div className={styles.toolbar}>
          <div className={styles.menuAnchor} ref={menuRef}>
            <button
              type="button"
              className={styles.tool}
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="更多：带入练习题"
              title="带入练习题"
              disabled={generating || problems.length === 0}
            >
              <Plus size={16} aria-hidden />
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu">
                <p className={styles.menuLabel}>
                  <Dumbbell size={12} aria-hidden />
                  带入一道练习题
                </p>
                {problems.map((problem) => (
                  <button
                    key={problem.id}
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setMenuOpen(false);
                      onStartExercise(problem.id);
                    }}
                  >
                    <span>{problem.title}</span>
                    {problem.inputSequence && problem.outputSequence && (
                      <code>{problem.inputSequence.join("")} → {problem.outputSequence.join("")}</code>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={styles.rightTools}>
            <div className={styles.effortAnchor} ref={effortRef}>
              <button
                type="button"
                className={styles.effortBtn}
                onClick={() => setEffortOpen((v) => !v)}
                aria-expanded={effortOpen}
                aria-haspopup="menu"
                title={`模型思考深度：${activeEffort.label}`}
              >
                {modelName && <span className={styles.effortModel}>{modelName}</span>}
                <span className={styles.effortLevel}>{activeEffort.shortLabel}</span>
                <ThinkingGauge segments={activeEffort.segments} />
              </button>

              {effortOpen && (
                <div className={styles.effortMenu} role="menu" aria-label="思考深度">
                  <p className={styles.menuLabel}>思考深度（Reasoning Effort）</p>
                  {EFFORT_OPTIONS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={effort === item.id}
                      className={cx(styles.effortOption, effort === item.id && styles.effortOptionOn)}
                      onClick={() => selectEffort(item.id)}
                    >
                      <ThinkingGauge segments={item.segments} />
                      <div className={styles.effortOptionBody}>
                        <span className={styles.effortOptionTitle}>{item.label}</span>
                        <span className={styles.effortOptionDesc}>{item.desc}</span>
                      </div>
                      {effort === item.id && <Check size={13} className={styles.effortCheck} aria-hidden />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {hero && (
              generating ? (
                <button className={cx(styles.send, styles.stop)} onClick={onStop} aria-label="停止生成" title="停止生成">
                  <Square size={11} fill="currentColor" aria-hidden />
                </button>
              ) : (
                <button className={styles.send} onClick={onSend} disabled={!canSend} aria-label="发送" title="发送">
                  <ArrowUp size={15} aria-hidden />
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* 参照 LobeHub 输入框底部微型环境状态栏（工作区目录 / 费曼自测 / 自动批准） */}
      {!hero && (
        <div className={styles.envStrip}>
          <div className={styles.envStripLeft}>
            <div className={styles.menuAnchor} ref={wsRef}>
              <button
                type="button"
                className={cx(styles.envPill, workspace && styles.envPillActive)}
                onClick={() => setWsOpen((v) => !v)}
                aria-expanded={wsOpen}
                title={workspace ? `当前工作区：${workspace}` : "绑定本地工作区文件夹"}
              >
                <FolderOpen size={12} aria-hidden />
                <span className={styles.envPillText}>{wsShortName}</span>
                <ChevronDown size={11} aria-hidden />
              </button>

              {wsOpen && (
                <div className={styles.wsPopover} role="dialog" aria-label="工作区文件夹">
                  <p className={styles.menuLabel}>工作区文件夹（Agent 读写目录）</p>
                  <input
                    className={styles.wsInput}
                    value={wsDraft}
                    placeholder="粘贴本地已存在的文件夹路径…"
                    onChange={(e) => setWsDraft(e.target.value)}
                  />
                  {wsNote && <p className={styles.wsError}>{wsNote}</p>}
                  <div className={styles.wsActions}>
                    {typeof window !== "undefined" && window.knowgap?.selectFolder && (
                      <button
                        type="button"
                        className={styles.wsBtn}
                        onClick={() => {
                          void window.knowgap?.selectFolder().then((picked) => {
                            if (picked) setWsDraft(picked);
                          });
                        }}
                      >
                        浏览…
                      </button>
                    )}
                    {workspace && (
                      <button
                        type="button"
                        className={styles.wsBtn}
                        onClick={() => void saveEnv("", autoApprove)}
                      >
                        解绑
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.wsBtnPrimary}
                      onClick={() => void saveEnv(wsDraft.trim(), autoApprove)}
                    >
                      保存
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              className={styles.envPill}
              onClick={() => {
                onChange("我想用费曼学习法自测：请你扮演一位认真但有疑惑的同桌听我讲，并在我讲得含糊或漏掉边界条件的地方追问我。我现在开始讲：");
                textareaRef.current?.focus();
              }}
              title="切换为费曼反转自测：由你讲给 AI 听，AI 负责挑刺追问"
            >
              <Mic size={12} aria-hidden />
              <span>费曼自测</span>
            </button>
          </div>

          <div className={styles.envStripRight}>
            <button
              type="button"
              className={cx(styles.envPill, autoApprove && styles.envPillActive)}
              onClick={() => void saveEnv(workspace, !autoApprove)}
              title="开启后 Agent 写入工作区文件无需逐次弹窗确认（终端命令仍需确认）"
            >
              <ShieldCheck size={12} aria-hidden />
              <span>{autoApprove ? "自动批准：已开启" : "自动批准：手动确认"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

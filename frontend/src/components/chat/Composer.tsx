"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowLeftRight, ArrowUp, AtSign, Check, ChevronDown, Dumbbell, FileText, FolderOpen, ListChecks, Mic,
  NotebookPen, Plus, ShieldCheck, Sparkles, Square, Workflow,
} from "lucide-react";
import type { StreamPhase } from "@/hooks/useChat";
import { getAIConfig } from "@/lib/api/ai-config";
import { chatApi } from "@/lib/chat/api";
import type { ChatMessage } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import type { Problem } from "@/lib/types";
import { WIDGET_ASK_EVENT } from "./LearningWidget";
import { ImageAttach } from "./widgets/ImageAttach";
import { withImageMarker } from "./widgets/visionData";
import { WIDGET_SEND_EVENT, type WidgetSendDetail } from "./widgets/widgetEvents";
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
const FEYNMAN_PROMPT = "我想用费曼学习法自测：请你扮演一位认真但有疑惑的同桌听我讲，并在我讲得含糊或漏掉边界条件的地方追问我。我现在开始讲：";

interface SlashCommand {
  id: string;
  label: string;
  desc: string;
  prompt: string;
  icon: ReactNode;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "transfer",
    label: "对比迁移学习",
    desc: "用已学过的知识类比理解当前概念",
    prompt: "我之前学过 [某基础]，请用对比迁移的方式帮我理解当前概念，并列出异同点：",
    icon: <ArrowLeftRight size={14} aria-hidden />,
  },
  {
    id: "feynman",
    label: "费曼反转自测",
    desc: "你讲给 AI 听，由 AI 挑刺追问",
    prompt: "我想用费曼学习法自测：请你扮演有疑惑的同桌听我讲，并在我讲漏边界条件时追问我：",
    icon: <Mic size={14} aria-hidden />,
  },
  {
    id: "quiz",
    label: "随堂微测验",
    desc: "出一道交互式检测题考考我",
    prompt: "请针对刚才讲的核心概念，出一道带 `micro_quiz` 交互微件的随堂检测题考考我。",
    icon: <ListChecks size={14} aria-hidden />,
  },
  {
    id: "sim",
    label: "分步推演模拟",
    desc: "一步步演示机制的状态变化",
    prompt: "请用 `step_simulator` 分步推演微件，一步步演示这个机制的状态变化过程。",
    icon: <Workflow size={14} aria-hidden />,
  },
  {
    id: "note",
    label: "结构化讲义整理",
    desc: "把讨论要点整理成复习讲义",
    prompt: "请把我们讨论的要点整理成一份带对比表与微测验的结构化复习讲义。",
    icon: <NotebookPen size={14} aria-hidden />,
  },
];

interface MentionItem {
  key: string;
  kind: "skill" | "file";
  name: string;
  hint: string;
}

interface InputTrigger {
  kind: "slash" | "at";
  /** 触发符号 `/` 或 `@` 在文本中的下标 */
  start: number;
  query: string;
}

/** 光标前紧邻的 `/xxx`（行首或空格后）或 `@xxx` 片段 */
function detectTrigger(text: string, caret: number): InputTrigger | null {
  const before = text.slice(0, caret);
  const slash = /(?:^|\s)\/([A-Za-z]*)$/.exec(before);
  if (slash) return { kind: "slash", start: caret - slash[1].length - 1, query: slash[1].toLowerCase() };
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "at", start: caret - at[1].length - 1, query: at[1].toLowerCase() };
  return null;
}

const MENTION_TTL_MS = 30_000;

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
  /** 当前会话 ID 与消息列表（用于生成 AI 回复后的智能灰字追问预测） */
  conversationId?: string | null;
  messages?: ChatMessage[];
}

export const COMPOSER_ID = "chat-input";
const MAX_HEIGHT = 220;
const GHOST_CACHE = new Map<string, string>();

/** 0ms 本地启发式追问生成（在后端 LLM 预测返回前立即提供上下文相关的第一人称灰字补全） */
function deriveInstantSuggestion(messages?: ChatMessage[]): string {
  if (!messages || messages.length === 0) return "";
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.status !== "complete") return "";
  const raw = (last.content || "").trim();
  if (!raw) return "";

  if (last.threadProposals && last.threadProposals.some((p) => !p.threadId)) {
    return "那就按你规划的 Thread 路线推进，我们先从第一个方向开始拆解，结合具体例子讲讲。";
  }
  if (raw.includes("```knowgap-widget")) {
    if (raw.includes('"step_simulator"')) {
      return "我看完上面的分步推演了，能针对最关键的那一步变化，再给我出一个变式例子考考我吗？";
    }
    if (raw.includes('"comparison_matrix"')) {
      return "对比表很清楚，那就顺着这几者的核心区别，带我看看实际应用中最容易踩的坑有哪些？";
    }
    if (raw.includes('"parameter_lab"')) {
      return "我试着拖动了参数滑块观察曲线，能帮我推导一下当参数取极值时为什么会出现这种现象吗？";
    }
    if (raw.includes('"micro_quiz"')) {
      return "我已经完成了上面的随堂微测，请结合这道题考察的易错点再带我往深处推进一层。";
    }
  }

  const stripped = raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#>*_`~]/g, "")
    .trim();
  const paragraphs = stripped
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 6);
  const tail = paragraphs[paragraphs.length - 1] || "";

  // 若结尾包含「先看 A 还是 B」或「第一轮 / 第一步」等建议
  const choiceMatch = tail.match(/(?:先从|先看|先聊|先讲|比如|例如)([^，。！？?；\n]{3,24})/);
  if (choiceMatch?.[1]) {
    const topic = choiceMatch[1].replace(/^[「『"“]|["”』」]$/g, "").trim();
    return `那就按你说的来，我们先从「${topic}」开始，结合具体例子深入讲讲，然后再出题考我。`;
  }

  if (/[？?]$/.test(tail)) {
    return "我目前的初步理解还不够扎实，请你先用一个直观的例子帮我搭个框架，再一步步引导我推导。";
  }

  return "那就按你说的思路往下推进，结合具体例子把核心机制展开讲讲，顺便出个小问题检验我。";
}

export function Composer({
  value, onChange, onSend, onStop, phase, busy, problems, onStartExercise, autoFocusKey,
  placeholder = "继续提问，或说说你的理解…", hero = false, inputId = COMPOSER_ID,
  conversationId, messages,
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
  const [llmGhost, setLlmGhost] = useState<string>("");
  const [trigger, setTrigger] = useState<InputTrigger | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [mentions, setMentions] = useState<MentionItem[]>([]);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const dismissedStart = useRef(-1);
  const mentionsFetchedAt = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<HTMLDivElement>(null);
  const generating = phase === "connecting" || phase === "streaming";
  const locked = busy || phase === "connecting";

  const lastMessage = messages && messages.length > 0 ? messages[messages.length - 1] : null;
  const lastCompletedAssistantId =
    !generating && lastMessage && lastMessage.role === "assistant" && lastMessage.status === "complete"
      ? lastMessage.id
      : null;

  const instantGhost = useMemo(
    () => (lastCompletedAssistantId ? deriveInstantSuggestion(messages) : ""),
    [lastCompletedAssistantId, messages],
  );

  useEffect(() => {
    if (!conversationId || !lastCompletedAssistantId || hero) {
      setLlmGhost("");
      return;
    }
    const cached = GHOST_CACHE.get(lastCompletedAssistantId);
    if (cached) {
      setLlmGhost(cached);
      return;
    }
    setLlmGhost("");
    let cancelled = false;
    void chatApi
      .suggestReply(conversationId)
      .then((res) => {
        if (cancelled) return;
        const clean = res.suggestion.trim();
        if (clean) {
          GHOST_CACHE.set(lastCompletedAssistantId, clean);
          setLlmGhost(clean);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, lastCompletedAssistantId, hero]);

  const activeGhost = !hero && !generating && !locked && lastCompletedAssistantId
    ? (llmGhost || instantGhost)
    : "";

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
    const onWidgetSend = (event: Event) => {
      const detail = (event as CustomEvent<WidgetSendDetail>).detail;
      if (!detail?.text) return;
      if (detail.effort) {
        setEffort(detail.effort);
        try { localStorage.setItem(EFFORT_STORAGE_KEY, detail.effort); } catch { /* ignore */ }
        window.dispatchEvent(new CustomEvent<ThinkingEffort>(EFFORT_EVENT, { detail: detail.effort }));
        void chatApi.saveReasoningEffort(detail.effort).catch(() => {});
      }
      onChange(detail.text);
      textareaRef.current?.focus();
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
    window.addEventListener(WIDGET_SEND_EVENT, onWidgetSend);
    window.addEventListener(AGENT_ENV_EVENT, onEnvSync);
    return () => {
      window.removeEventListener(EFFORT_EVENT, onSync);
      window.removeEventListener(WIDGET_ASK_EVENT, onWidgetAsk);
      window.removeEventListener(WIDGET_SEND_EVENT, onWidgetSend);
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

  const acceptGhost = () => {
    if (!activeGhost || locked || generating) return;
    onChange(activeGhost);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(activeGhost.length, activeGhost.length);
      }
    });
  };

  const loadMentions = () => {
    if (Date.now() - mentionsFetchedAt.current < MENTION_TTL_MS) return;
    mentionsFetchedAt.current = Date.now();
    setMentionsLoading(true);
    void Promise.allSettled([chatApi.listCustomSkills(), chatApi.workspaceTree()]).then(([skillsRes, treeRes]) => {
      const items: MentionItem[] = [];
      if (skillsRes.status === "fulfilled") {
        for (const skill of skillsRes.value) {
          if (skill.enabled) items.push({ key: `skill:${skill.id}`, kind: "skill", name: skill.name, hint: skill.triggerKeywords || "自定义 Skill" });
        }
      }
      if (treeRes.status === "fulfilled") {
        for (const entry of treeRes.value.entries) {
          if (entry.kind === "file") items.push({ key: `file:${entry.path}`, kind: "file", name: entry.path, hint: "工作区文件" });
          for (const child of entry.children ?? []) {
            if (child.kind === "file") items.push({ key: `file:${child.path}`, kind: "file", name: child.path, hint: "工作区文件" });
          }
        }
      }
      if (skillsRes.status === "rejected" && treeRes.status === "rejected") mentionsFetchedAt.current = 0;
      setMentions(items);
      setMentionsLoading(false);
    });
  };

  const syncTrigger = (text: string, caret: number) => {
    const next = locked ? null : detectTrigger(text, caret);
    if (!next) dismissedStart.current = -1;
    if (next && next.start === dismissedStart.current) {
      setTrigger(null);
      return;
    }
    if (next?.kind === "at") loadMentions();
    const same = trigger && next && trigger.kind === next.kind && trigger.start === next.start && trigger.query === next.query;
    if (same) return;
    setTrigger(next);
    setActiveIdx(0);
  };

  const slashItems = trigger?.kind === "slash"
    ? SLASH_COMMANDS.filter((cmd) => cmd.id.startsWith(trigger.query))
    : [];
  const mentionItems = trigger?.kind === "at"
    ? [
        ...mentions.filter((m) => m.kind === "skill" && m.name.toLowerCase().includes(trigger.query)).slice(0, 6),
        ...mentions.filter((m) => m.kind === "file" && m.name.toLowerCase().includes(trigger.query)).slice(0, 10),
      ]
    : [];
  const popupOpen = trigger !== null && (trigger.kind === "at" || slashItems.length > 0);
  const popupCount = trigger?.kind === "slash" ? slashItems.length : mentionItems.length;

  const insertAtTrigger = (insert: string, selectPlaceholder = false) => {
    if (!trigger) return;
    const end = trigger.start + 1 + trigger.query.length;
    onChange(value.slice(0, trigger.start) + insert + value.slice(end));
    setTrigger(null);
    dismissedStart.current = -1;
    const base = trigger.start;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const holder = selectPlaceholder ? insert.indexOf("[某基础]") : -1;
      if (holder >= 0) el.setSelectionRange(base + holder, base + holder + "[某基础]".length);
      else el.setSelectionRange(base + insert.length, base + insert.length);
    });
  };

  const pickSlash = (cmd: SlashCommand) => insertAtTrigger(cmd.prompt, true);
  const pickMention = (item: MentionItem) => insertAtTrigger(`@[${item.name}] `);
  const pickActive = (index: number) => {
    if (trigger?.kind === "slash") {
      const cmd = slashItems[index];
      if (cmd) pickSlash(cmd);
    } else {
      const item = mentionItems[index];
      if (item) pickMention(item);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && !composing.current && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissedStart.current = trigger.start;
        setTrigger(null);
        return;
      }
      if (popupCount > 0) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActiveIdx((idx) => (idx + step + popupCount) % popupCount);
          return;
        }
        if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) {
          event.preventDefault();
          pickActive(Math.min(activeIdx, popupCount - 1));
          return;
        }
      }
    }
    if (event.key === "Tab" && !event.shiftKey && !value && activeGhost && !locked && !generating) {
      event.preventDefault();
      acceptGhost();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  const approveLabel = autoApprove ? "帮我批准 · 已开启" : "帮我批准";
  const popupId = `${inputId}-popup`;

  return (
    <div className={cx(styles.composer, hero && styles.hero)}>
      <div className={cx(styles.box, locked && styles.locked)}>
        {popupOpen && trigger && (
          <div className={styles.cmdMenu} role="listbox" id={popupId} aria-label={trigger.kind === "slash" ? "快捷指令" : "引用"}>
            {trigger.kind === "slash" ? (
              <>
                <p className={styles.menuLabel}>
                  <Sparkles size={12} aria-hidden />
                  快捷指令
                </p>
                {slashItems.map((cmd, idx) => (
                  <button
                    key={cmd.id}
                    type="button"
                    role="option"
                    aria-selected={idx === activeIdx}
                    className={cx(styles.cmdItem, idx === activeIdx && styles.cmdItemActive)}
                    ref={(el) => { if (el && idx === activeIdx) el.scrollIntoView({ block: "nearest" }); }}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => pickSlash(cmd)}
                  >
                    <span className={styles.cmdIcon}>{cmd.icon}</span>
                    <span className={styles.cmdBody}>
                      <span className={styles.cmdTitle}>{cmd.label}</span>
                      <span className={styles.cmdDesc}>{cmd.desc}</span>
                    </span>
                    <code className={styles.cmdKey}>/{cmd.id}</code>
                  </button>
                ))}
              </>
            ) : (
              <>
                <p className={styles.menuLabel}>
                  <AtSign size={12} aria-hidden />
                  引用 Skill 或工作区文件
                </p>
                {mentionItems.map((item, idx) => (
                  <button
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={idx === activeIdx}
                    className={cx(styles.cmdItem, idx === activeIdx && styles.cmdItemActive)}
                    ref={(el) => { if (el && idx === activeIdx) el.scrollIntoView({ block: "nearest" }); }}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => pickMention(item)}
                  >
                    <span className={styles.cmdIcon}>
                      {item.kind === "skill" ? <Sparkles size={14} aria-hidden /> : <FileText size={14} aria-hidden />}
                    </span>
                    <span className={styles.cmdBody}>
                      <span className={styles.cmdTitle}>{item.name}</span>
                      <span className={styles.cmdDesc}>{item.hint}</span>
                    </span>
                    <span className={styles.cmdTag}>{item.kind === "skill" ? "Skill" : "文件"}</span>
                  </button>
                ))}
                {popupCount === 0 && (
                  <p className={styles.cmdEmpty}>{mentionsLoading ? "正在读取 Skills 与工作区文件…" : "没有匹配的 Skill 或文件"}</p>
                )}
              </>
            )}
          </div>
        )}

        <div className={styles.inputRow}>
          <label htmlFor={inputId} className="sr-only">
            发送消息
          </label>
          <div className={styles.inputStack}>
            <textarea
              id={inputId}
              ref={textareaRef}
              className={styles.input}
              rows={1}
              maxLength={12000}
              value={value}
              readOnly={locked}
              aria-controls={popupOpen ? popupId : undefined}
              onChange={(event) => {
                onChange(event.target.value);
                syncTrigger(event.target.value, event.target.selectionStart);
              }}
              onSelect={(event) => syncTrigger(event.currentTarget.value, event.currentTarget.selectionStart)}
              onBlur={() => setTrigger(null)}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={(event) => {
                composing.current = false;
                syncTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
              }}
              onKeyDown={handleKeyDown}
              placeholder={activeGhost ? "" : placeholder}
            />
            {!value && activeGhost && (
              <div className={styles.ghostOverlay} aria-hidden="true">
                <span className={styles.ghostText}>{activeGhost}</span>
                <button
                  type="button"
                  tabIndex={-1}
                  className={styles.ghostTabBadge}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptGhost();
                  }}
                  title="按 Tab 键或点击直接采纳这条追问建议"
                >
                  Tab
                </button>
              </div>
            )}
          </div>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.leftTools}>
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

            <ImageAttach
              disabled={generating || locked}
              onUploaded={(img) => {
                onChange(withImageMarker(value, img.marker));
                textareaRef.current?.focus();
              }}
            />

            <button
              type="button"
              className={cx(styles.pill, autoApprove && styles.pillOn)}
              onClick={() => void saveEnv(workspace, !autoApprove)}
              aria-pressed={autoApprove}
              title="开启后 Agent 写入工作区文件无需逐次弹窗确认（终端命令仍需确认）"
            >
              <ShieldCheck size={12} aria-hidden />
              <span className={styles.pillText}>{approveLabel}</span>
            </button>

            <div className={styles.menuAnchor} ref={wsRef}>
              <button
                type="button"
                className={cx(styles.pill, workspace && styles.pillActive)}
                onClick={() => setWsOpen((v) => !v)}
                aria-expanded={wsOpen}
                title={workspace ? `当前工作区：${workspace}` : "绑定本地工作区文件夹"}
              >
                <FolderOpen size={12} aria-hidden />
                <span className={cx(styles.pillText, styles.pillTextShrink)}>{wsShortName}</span>
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
              className={styles.pill}
              onClick={() => {
                onChange(FEYNMAN_PROMPT);
                textareaRef.current?.focus();
              }}
              title="切换为费曼反转自测：由你讲给 AI 听，AI 负责挑刺追问"
            >
              <Mic size={12} aria-hidden />
              <span className={cx(styles.pillText, styles.pillTextHide)}>费曼自测</span>
            </button>
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
                <ChevronDown size={12} aria-hidden />
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

            {generating ? (
              <button className={cx(styles.send, styles.stop)} onClick={onStop} aria-label="停止生成" title="停止生成">
                <Square size={11} fill="currentColor" aria-hidden />
              </button>
            ) : (
              <button className={styles.send} onClick={onSend} disabled={!canSend} aria-label="发送" title="发送 (Enter)">
                <ArrowUp size={15} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

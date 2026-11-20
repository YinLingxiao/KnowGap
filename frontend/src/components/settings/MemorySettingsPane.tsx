"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowUp, ChevronRight, LoaderCircle } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { SpaceIcon } from "@/components/chat/SpaceIcon";
import { MEMORY_CHANGED_EVENT } from "@/components/chat/widgets/memoryContext";
import { toApiError } from "@/lib/api/errors";
import { chatApi } from "@/lib/chat/api";
import {
  environmentRow, splitEntries, stripLayer, topicRows, userNotesWithout, userRows,
  type MemoryGroupId, type MemoryRow, type MemoryState, type TopicRow, type UserGroupId,
} from "@/lib/chat/memoryGroups";
import type { LearnerMemory, Subject } from "@/lib/chat/types";
import { cx } from "@/lib/cx";
import styles from "./MemorySettingsPane.module.css";

type Tx = (text: string, vars?: Record<string, string | number>) => string;

interface PendingItem {
  id: string;
  content: string;
  oldText: string;
}

const CONFIRM_RESET_MS = 3000;

function relativeUpdate(iso: string | null, tx: Tx): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return "";
  const days = Math.floor(Math.max(0, Date.now() - time) / 86_400_000);
  if (days === 0) return tx("今天更新");
  if (days === 1) return tx("昨天更新");
  if (days < 30) return tx("{days} 天前更新", { days });
  const date = new Date(time);
  return tx("{month}月{day}日更新", { month: date.getMonth() + 1, day: date.getDate() });
}

function fullDate(iso: string | null, tx: Tx): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return tx("暂无");
  const date = new Date(time);
  return tx("{year}年{month}月{day}日", { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });
}

function stateLabel(state: MemoryState, tx: Tx): string {
  if (state === "mastered") return tx("已掌握");
  if (state === "improving") return tx("改善中");
  return tx("待巩固");
}

const isTopic = (row: MemoryRow): row is TopicRow => row.id.startsWith("topic:");

/** 设置 · 记忆：一张列表（标题 · 一行概要 · 更新时间），点进去看详情或删除；改动交给底部一句话。 */
export function MemorySettingsPane() {
  const { tx } = useI18n();
  const [openId, setOpenId] = useState<MemoryGroupId | null>(null);
  const [loading, setLoading] = useState(true);
  const [approval, setApproval] = useState<boolean | null>(null);
  const [userNotes, setUserNotes] = useState<string[]>([]);
  const [memoryNotes, setMemoryNotes] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<{ user: string | null; memory: string | null }>({ user: null, memory: null });
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [learnerMemories, setLearnerMemories] = useState<LearnerMemory[]>([]);
  const [instruction, setInstruction] = useState("");
  const [instructing, setInstructing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState<MemoryGroupId | null>(null);
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const confirmTimer = useRef(0);

  const applyNotes = (notes: { user: string; memory: string; updatedAt: { user: string | null; memory: string | null } }) => {
    setUserNotes(splitEntries(notes.user));
    setMemoryNotes(splitEntries(notes.memory));
    setUpdatedAt(notes.updatedAt);
  };

  const loadAll = useCallback(async () => {
    const [settingsRes, notesRes, pendingRes, subjectsRes, memoriesRes] = await Promise.allSettled([
      chatApi.agentSettings(),
      chatApi.agentNotes(),
      chatApi.pendingNotes(),
      chatApi.listSubjects(),
      chatApi.listMemories(),
    ]);
    if (settingsRes.status === "fulfilled") setApproval(settingsRes.value.memoryWriteApproval);
    if (notesRes.status === "fulfilled") applyNotes(notesRes.value);
    if (pendingRes.status === "fulfilled") setPending(pendingRes.value);
    if (subjectsRes.status === "fulfilled") setSubjects(subjectsRes.value);
    if (memoriesRes.status === "fulfilled") setLearnerMemories(memoriesRes.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();
    return () => window.clearTimeout(confirmTimer.current);
  }, [loadAll]);

  const notifyMemoryChanged = () => window.dispatchEvent(new Event(MEMORY_CHANGED_EVENT));

  const rows = useMemo(() => ({
    about: userRows(userNotes, updatedAt.user),
    topics: topicRows(learnerMemories, subjects.map((subject) => subject.id)),
    environment: environmentRow(memoryNotes, updatedAt.memory),
  }), [learnerMemories, memoryNotes, subjects, updatedAt, userNotes]);

  const allRows: MemoryRow[] = [...rows.about, ...rows.topics, ...(rows.environment ? [rows.environment] : [])];
  const open = openId ? allRows.find((row) => row.id === openId) ?? null : null;

  const subjectOf = (row: TopicRow) => subjects.find((subject) => subject.id === row.subjectId) ?? null;

  const titleOf = (row: MemoryRow): string => {
    if (isTopic(row)) return subjectOf(row)?.name ?? tx("通用知识点");
    if (row.id === "profile") return tx("基础档案");
    if (row.id === "preferences") return tx("讲解与偏好");
    if (row.id === "goals") return tx("目标与近况");
    return tx("路径与约定");
  };

  const summaryOf = (row: MemoryRow): string => {
    if (!isTopic(row)) return row.details.join(" · ") || tx("还没有内容，和 AI 聊几轮会慢慢记下来。");
    const count = (state: MemoryState) => row.points.filter((point) => point.state === state).length;
    const parts = [
      count("review") ? tx("{count} 个待巩固", { count: count("review") }) : "",
      count("improving") ? tx("{count} 个改善中", { count: count("improving") }) : "",
      count("mastered") ? tx("{count} 个已掌握", { count: count("mastered") }) : "",
    ].filter(Boolean);
    return [...parts, ...row.details.slice(0, 3)].join(" · ");
  };

  const saveApproval = async (next: boolean) => {
    setApproval(next);
    try {
      setApproval(await chatApi.saveMemoryApproval(next));
    } catch (error) {
      setApproval(!next);
      setBanner({ tone: "error", text: toApiError(error).message });
    }
  };

  const handleInstruct = async (event: FormEvent) => {
    event.preventDefault();
    const text = instruction.trim();
    if (!text || instructing) return;
    setInstructing(true);
    setBanner(null);
    try {
      const res = await chatApi.instructAgentMemory(text);
      applyNotes(res);
      setInstruction("");
      setBanner({ tone: res.applied === 0 && res.failed.length > 0 ? "error" : "ok", text: res.summary || tx("记忆已更新") });
      if (res.applied > 0) notifyMemoryChanged();
    } catch (error) {
      setBanner({ tone: "error", text: toApiError(error).message });
    } finally {
      setInstructing(false);
    }
  };

  const handlePending = async (id: string, allow: boolean) => {
    try {
      await chatApi.decidePending(id, allow);
      setPending((current) => current.filter((item) => item.id !== id));
      applyNotes(await chatApi.agentNotes());
      notifyMemoryChanged();
    } catch (error) {
      setBanner({ tone: "error", text: toApiError(error).message });
    }
  };

  const deleteRow = async (row: MemoryRow) => {
    setDeleting(true);
    setBanner(null);
    try {
      if (isTopic(row)) {
        for (const point of row.points) await chatApi.deleteMemory(point.id);
        const removed = new Set(row.points.map((point) => point.id));
        setLearnerMemories((current) => current.filter((item) => !removed.has(item.id)));
      } else if (row.id === "environment") {
        applyNotes(await chatApi.saveAgentNote("memory", ""));
      } else {
        applyNotes(await chatApi.saveAgentNote("user", userNotesWithout(row.id as UserGroupId, userNotes).join("\n§\n")));
      }
      notifyMemoryChanged();
      setOpenId(null);
      setBanner({ tone: "ok", text: tx("已删除「{title}」", { title: titleOf(row) }) });
    } catch (error) {
      setBanner({ tone: "error", text: toApiError(error).message });
    } finally {
      setDeleting(false);
      setConfirming(null);
    }
  };

  const onDelete = (row: MemoryRow) => {
    window.clearTimeout(confirmTimer.current);
    if (confirming === row.id) {
      void deleteRow(row);
      return;
    }
    setConfirming(row.id);
    confirmTimer.current = window.setTimeout(() => setConfirming(null), CONFIRM_RESET_MS);
  };

  const openRow = (id: MemoryGroupId | null) => {
    window.clearTimeout(confirmTimer.current);
    setConfirming(null);
    setBanner(null);
    setOpenId(id);
  };

  const renderRow = (row: MemoryRow) => {
    const subject = isTopic(row) ? subjectOf(row) : null;
    return (
      <li key={row.id}>
        <button type="button" className={styles.row} onClick={() => openRow(row.id)}>
          <span className={styles.rowTitle}>
            {subject && (
              <span className={styles.rowIcon} style={{ color: subject.color }}>
                <SpaceIcon name={subject.icon} size={14} />
              </span>
            )}
            {titleOf(row)}
          </span>
          <span className={styles.rowSummary}>{summaryOf(row)}</span>
          <span className={styles.rowDate}>{relativeUpdate(row.updatedAt, tx)}</span>
          <ChevronRight size={14} className={styles.rowChevron} aria-hidden />
        </button>
      </li>
    );
  };

  const section = (title: string, list: MemoryRow[]) => list.length > 0 && (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <ul className={styles.rows}>{list.map(renderRow)}</ul>
    </section>
  );

  const detailItems = (row: MemoryRow): string[] => isTopic(row)
    ? row.points.map((point) => `${point.topic}：${point.summary}（${stateLabel(point.state, tx)}）`)
    : row.details;

  return (
    <section className={styles.pane}>
      {open ? (
        <div key={open.id} className={styles.stage}>
          <button type="button" className={styles.back} onClick={() => openRow(null)}>
            <ArrowLeft size={14} aria-hidden />
            {tx("记忆")}
          </button>
          <header className={styles.detailHead}>
            <h2 className={styles.detailTitle}>{titleOf(open)}</h2>
            <button
              type="button"
              className={cx(styles.deleteBtn, confirming === open.id && styles.deleteBtnConfirm)}
              disabled={deleting || (open.id === "profile" && userNotesWithout("profile", userNotes).length === userNotes.length)}
              onClick={() => onDelete(open)}
            >
              {deleting ? <LoaderCircle size={13} className={styles.spin} aria-hidden /> : null}
              {confirming === open.id ? tx("确认删除") : tx("删除")}
            </button>
          </header>
          <dl className={styles.facts}>
            <dt>{tx("最近更新")}</dt>
            <dd>{fullDate(open.updatedAt, tx)}</dd>
            <dt>{tx("概要")}</dt>
            <dd>{summaryOf(open)}</dd>
            {/* 只有一条时概要就是全部内容，不再重复一遍 */}
            {(isTopic(open) ? open.points.length > 0 : open.details.length > 1) && (
              <>
                <dt>{tx("详情")}</dt>
                <dd>
                  <ul className={styles.details}>
                    {detailItems(open).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
                  </ul>
                </dd>
              </>
            )}
          </dl>
          {open.id === "profile" && <p className={styles.hint}>{tx("称呼在「个人资料」里修改，删除时会保留。")}</p>}
        </div>
      ) : (
        <div key="overview" className={styles.stage}>
          <header className={styles.head}>
            <div>
              <h2 className={styles.title}>{tx("记忆")}</h2>
              <p className={styles.subtitle}>{tx("KnowGap 记住的关于你的信息。点进去查看，不需要的可以删掉。")}</p>
            </div>
            {approval !== null && (
              <label className={styles.approval}>
                <span>{tx("写入前确认")}</span>
                <span className={styles.switch}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={approval}
                    aria-label={tx("记忆写入需确认")}
                    onChange={(event) => void saveApproval(event.target.checked)}
                  />
                  <span aria-hidden />
                </span>
              </label>
            )}
          </header>

          {pending.length > 0 && (
            <div className={styles.pending} role="region" aria-label={tx("待确认的记忆修改")}>
              <p className={styles.pendingHead}>{tx("有 {count} 条待确认的记忆修改", { count: pending.length })}</p>
              {pending.map((item) => (
                <div key={item.id} className={styles.pendingRow}>
                  <span className={styles.pendingText}>{stripLayer(item.content || item.oldText)}</span>
                  <button type="button" className={styles.pendingAllow} onClick={() => void handlePending(item.id, true)}>{tx("同意")}</button>
                  <button type="button" className={styles.pendingDeny} onClick={() => void handlePending(item.id, false)}>{tx("拒绝")}</button>
                </div>
              ))}
            </div>
          )}

          {loading ? <p className={styles.empty}>{tx("正在读取记忆…")}</p> : (
            <>
              {section(tx("关于你"), rows.about)}
              {section(tx("学习主题"), rows.topics)}
              {section(tx("环境与资料"), rows.environment ? [rows.environment] : [])}
            </>
          )}
        </div>
      )}

      <div className={styles.dock}>
        {banner && <p className={cx(styles.banner, banner.tone === "error" && styles.bannerError)} role="status">{banner.text}</p>}
        <form className={styles.command} onSubmit={(event) => void handleInstruct(event)}>
          <input
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={tx("告诉 KnowGap 要记住、修改或忘掉什么…")}
            aria-label={tx("用一句话修改记忆")}
            maxLength={500}
            disabled={instructing}
          />
          <button type="submit" className={styles.send} disabled={!instruction.trim() || instructing} aria-label={tx("发送")}>
            {instructing ? <LoaderCircle size={15} className={styles.spin} aria-hidden /> : <ArrowUp size={15} aria-hidden />}
          </button>
        </form>
      </div>
    </section>
  );
}

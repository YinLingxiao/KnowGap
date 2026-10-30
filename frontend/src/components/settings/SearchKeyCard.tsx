"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { CircleCheck, Eye, EyeOff, TriangleAlert } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { toApiError } from "@/lib/api/errors";
import {
  getSearchKeyStatus, saveSearchKey, testSearchKey, type SearchKeySource, type SearchKeyStatus,
} from "@/lib/api/search-config";
import { cx } from "@/lib/cx";
import { Button } from "../ui/Button";
import styles from "./SearchKeyCard.module.css";
import library from "./ModelLibrary.module.css";

const SOURCE_TEXT: Record<SearchKeySource, string> = {
  saved: "已保存（来自这里）",
  environment: "已配置（来自环境变量或 .env）",
  none: "未配置，使用匿名额度",
};

type Outcome = { tone: "ok" | "error"; text: string } | null;

export function SearchKeyCard() {
  const { tx } = useI18n();
  const id = useId();
  const [status, setStatus] = useState<SearchKeyStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getSearchKeyStatus());
    } catch (error) {
      setOutcome({ tone: "error", text: toApiError(error).message });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (task: () => Promise<Outcome>) => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await task());
    } catch (error) {
      setOutcome({ tone: "error", text: toApiError(error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    const next = await saveSearchKey(draft);
    setStatus(next);
    setDraft("");
    setShow(false);
    return { tone: "ok", text: tx("已保存，下一次联网搜索就会使用，不需要重启。") };
  });

  const clear = () => run(async () => {
    const next = await saveSearchKey("");
    setStatus(next);
    setDraft("");
    return { tone: "ok", text: next.hasKey ? tx("已清除这里保存的密钥，改用环境变量里的。") : tx("已清除，回到匿名额度。") };
  });

  const test = () => run(async () => {
    const { results } = await testSearchKey(draft);
    return { tone: "ok", text: tx("连接正常，搜到 {count} 条结果。", { count: results }) };
  });

  return (
    <section className={styles.root} aria-labelledby={`${id}-title`}>
      <div className={styles.head}>
        <h3 id={`${id}-title`}>{tx("联网搜索")}</h3>
        <p>
          {tx("用于对话里的联网检索和「联网搜题」，服务商是 AnySearch。不填会用匿名额度，每天按 IP 计算，很容易用完；用完后搜题只能说没找到。")}
        </p>
      </div>
      <div className={styles.status} role="status">
        <span>{tx("当前：")}</span>
        <strong>{status ? tx(SOURCE_TEXT[status.source]) : tx("读取中…")}</strong>
      </div>
      <label className={library.field} htmlFor={`${id}-key`}>
        <span className={library.label}>AnySearch API Key</span>
        <span className={library.keyInput}>
          <input
            id={`${id}-key`}
            className={library.input}
            aria-label="AnySearch API Key"
            type={show ? "text" : "password"}
            value={draft}
            disabled={busy}
            spellCheck={false}
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            placeholder={status?.source === "saved" ? tx("已保存，留空则保持不变") : tx("填写 AnySearch 提供的 API Key")}
            onChange={(event) => { setDraft(event.target.value); setOutcome(null); }}
          />
          <button type="button" className={library.reveal} aria-label={show ? tx("隐藏密钥") : tx("显示密钥")} disabled={!draft} onClick={() => setShow((value) => !value)}>
            {show ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
          </button>
        </span>
        <span className={library.hint}>{tx("密钥只保存在本机后端，页面不会回显；后端只返回「是否已配置」。")}</span>
      </label>
      <div className={styles.actions}>
        <Button size="sm" variant="primary" loading={busy} disabled={busy || !draft.trim()} onClick={() => void save()}>{tx("保存")}</Button>
        <Button size="sm" disabled={busy || (!draft.trim() && !status?.hasKey)} onClick={() => void test()}>
          {draft.trim() ? tx("测试填写的密钥") : tx("测试当前密钥")}
        </Button>
        <Button size="sm" disabled={busy || status?.source !== "saved"} onClick={() => void clear()}>{tx("清除已保存")}</Button>
      </div>
      {outcome && (
        <p className={cx(library.outcome, outcome.tone === "ok" ? library.ok : library.bad)} role={outcome.tone === "ok" ? "status" : "alert"}>
          {outcome.tone === "ok" ? <CircleCheck size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
          {outcome.text}
        </p>
      )}
    </section>
  );
}

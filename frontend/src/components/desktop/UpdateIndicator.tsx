"use client";

import { useState } from "react";
import { ArrowDownToLine, LoaderCircle } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { desktopUpdateApi, useUpdaterState } from "@/lib/desktop-updater";
import { cx } from "@/lib/cx";
import styles from "./UpdateIndicator.module.css";

/**
 * 新版本下载好后出现在主界面的「更新」按钮（参考 ChatGPT 桌面端）：点一下就重启安装。
 * busy 表示还有回复在生成，这时仍弹一次确认，避免回复被悄悄打断。
 * compact：侧栏顶部放不下文字，只显示圆形图标，完整说明在提示和读屏文字里。
 */
export function UpdateIndicator({ busy = false, compact = false, className }: { busy?: boolean; compact?: boolean; className?: string }) {
  const { tx } = useI18n();
  const state = useUpdaterState();
  const [installing, setInstalling] = useState(false);
  if (!state?.enabled || state.status !== "downloaded") return null;
  const label = tx("KnowGap {version} 已下载，点击重启并安装", { version: state.version ?? "" });

  const install = async () => {
    const api = desktopUpdateApi()?.updater;
    if (!api || installing) return;
    setInstalling(true);
    try {
      // 成功时应用会退出；返回 false（取消或失败）才需要恢复按钮
      if (!(await api.install({ quick: !busy }))) setInstalling(false);
    } catch {
      setInstalling(false);
    }
  };

  return (
    <button
      type="button"
      className={cx(styles.pill, compact && styles.compact, className)}
      onClick={() => void install()}
      disabled={installing}
      aria-label={label}
      title={label}
    >
      {installing
        ? <LoaderCircle size={13} className={styles.spin} aria-hidden />
        : <ArrowDownToLine size={13} aria-hidden />}
      {!compact && <span>{tx("更新")}</span>}
    </button>
  );
}

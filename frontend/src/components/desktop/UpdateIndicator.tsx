"use client";

import { useUpdaterState } from "@/lib/desktop-updater";
import styles from "../settings/UpdateRows.module.css";

export function UpdateIndicator({ onOpenSettings }: { onOpenSettings: () => void }) {
  const state = useUpdaterState();
  if (!state?.enabled || state.status !== "downloaded") return null;
  const label = `新版本 ${state.version} 已下载，重启即可安装。打开设置查看。`;
  return (
    <button type="button" className={styles.indicator} onClick={onOpenSettings} aria-label={label} title={label}>
      <span className={styles.dot} aria-hidden="true" />
    </button>
  );
}

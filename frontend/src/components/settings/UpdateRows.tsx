"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/LanguageProvider";
import { desktopUpdateApi, useUpdaterState, type UpdateSettings } from "@/lib/desktop-updater";
import styles from "./Settings.module.css";
import updateStyles from "./UpdateRows.module.css";

function size(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateRows() {
  const { tx } = useI18n();
  const state = useUpdaterState();
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    let alive = true;
    void desktopUpdateApi()?.getDesktopSettings().then((value) => {
      if (alive) { setSettings(value); setUrl(value.updateUrl); }
    }).catch(() => { if (alive) setNote("无法读取更新设置，请关闭设置后重试。"); });
    return () => { alive = false; };
  }, []);

  if (!state) return null;
  const busy = state.status === "checking" || state.status === "downloading";
  const sourceLocked = state.sourceFromEnv || busy || state.status === "downloaded";
  const text = {
    idle: tx("后台检查不会打断学习。下载完成后由你决定何时安装。"),
    checking: tx("正在检查更新…"),
    available: tx("发现新版本 {version}，等待下载。", { version: state.version ?? "" }),
    downloading: tx("正在下载新版本 {version}…", { version: state.version ?? "" }),
    downloaded: tx("新版本 {version} 已下载，重启即可安装。", { version: state.version ?? "" }),
    none: tx("当前已是最新正式版本。"),
    error: tx(state.error || "检查更新失败，请稍后重试。"),
  }[state.status];

  async function save(patch: Partial<UpdateSettings>) {
    const api = desktopUpdateApi();
    if (!api) return;
    setSaving(true);
    setNote("");
    try {
      const next = await api.setDesktopSettings(patch);
      setSettings(next);
      setUrl(next.updateUrl);
      setNote("更新设置已保存。");
    } catch (error) {
      // The main process returns only fixed Chinese validation errors, never a URL.
      setNote(error instanceof Error ? error.message : "未能保存更新设置，请重试。");
    } finally { setSaving(false); }
  }

  const check = (download = false) => {
    setNote("");
    void desktopUpdateApi()?.updater.check(download ? { download: true } : undefined)
      .catch(() => setNote("无法检查更新，请关闭设置后重试。"));
  };

  return (
    <section aria-labelledby="software-update-title" className={updateStyles.group}>
      <h3 id="software-update-title" className={styles.sectionLabel}>{tx("软件更新")}</h3>
      <div className={styles.settingRow}>
        <div className={styles.settingRowInfo}>
          <p className={styles.settingRowTitle}>{tx("当前版本 {version}", { version: state.currentVersion })}</p>
          <p className={styles.settingRowDesc}>{tx("仅接收正式版本，不降级；下载文件始终校验完整性。")}</p>
        </div>
        <button type="button" className={styles.rowBtn} disabled={!state.enabled || busy || state.status === "downloaded" || installing}
          onClick={() => check()}>{state.status === "checking" ? tx("检查中…") : tx("检查更新")}</button>
      </div>
      <p role="status" className={styles.settingRowDesc}>{state.enabled ? text : tx(state.disabledReason)}</p>
      {state.status === "downloaded" && state.error && <p role="alert" className={updateStyles.error}>{tx(state.error)}</p>}
      {state.status === "downloading" && (
        <div className={updateStyles.download}>
          <progress className={updateStyles.progress} max={100} value={state.progress?.percent} aria-label={tx("更新下载进度")} />
          <p className={styles.settingRowDesc}>{state.progress
            ? tx("{percent}% · {transferred} / {total} · {speed}/秒", {
                percent: state.progress.percent.toFixed(0),
                transferred: size(state.progress.transferred),
                total: size(state.progress.total),
                speed: size(state.progress.bytesPerSecond),
              })
            : tx("正在准备下载…")}</p>
        </div>
      )}
      {state.status === "available" && <button type="button" className={styles.rowBtn} onClick={() => check(true)}>{tx("下载更新")}</button>}
      {state.status === "downloaded" && (
        <button type="button" className={styles.rowBtnPrimary} disabled={installing} onClick={() => {
          setInstalling(true);
          setNote("");
          void desktopUpdateApi()?.updater.install().catch(() => setNote("未能启动安装，请重试。"))
            .finally(() => setInstalling(false));
        }}>{installing ? tx("正在准备安装…") : tx("重启并安装")}</button>
      )}
      {state.releaseNotes && (
        <details className={updateStyles.notes}>
          <summary>{tx("更新说明{version}", { version: state.version ? ` · ${state.version}` : "" })}</summary>
          <p>{state.releaseNotes}</p>
        </details>
      )}
      <p className={`${styles.settingRowDesc} ${updateStyles.warning}`}>
        {tx("安装会中断正在生成的回复。为所有用户安装时，Windows 可能请求管理员权限（UAC），请确认后继续。安装包未签名，可能显示「未知发布者」。")}
      </p>
      {settings && (<>
        {([
          ["autoCheckUpdates", "自动检查更新", "启动约 20 秒后检查，之后每 4 小时检查一次。关闭后仍可手动检查。"],
          ["autoDownloadUpdates", "自动下载", "发现新版本后后台下载；关闭后需点击「下载更新」。"],
          ["autoInstallOnQuit", "退出时自动安装已下载的更新", "默认关闭。关闭窗口到托盘不算退出；开启后，仅在真正退出应用时安装。"],
        ] as const).map(([key, title, desc]) => (
          <div className={styles.settingRow} key={key}>
            <div className={styles.settingRowInfo}>
              <p className={styles.settingRowTitle}>{tx(title)}</p>
              <p className={styles.settingRowDesc}>{tx(desc)}</p>
            </div>
            <button type="button" role="switch" aria-checked={settings[key]} aria-label={tx(title)} disabled={saving || !state.enabled}
              className={`${styles.switch} ${settings[key] ? styles.switchOn : ""}`} onClick={() => void save({ [key]: !settings[key] })}>
              <span className={styles.thumb} />
            </button>
          </div>
        ))}
        <form className={updateStyles.source} onSubmit={(event) => { event.preventDefault(); void save({ updateUrl: url }); }}>
          <label htmlFor="knowgap-update-url" className={styles.settingRowTitle}>{tx("更新地址")}</label>
          <p id="knowgap-update-url-help" className={styles.settingRowDesc}>
            {state.sourceFromEnv ? tx("已由 KNOWGAP_UPDATE_URL 指定，环境变量优先；修改后需重新启动应用。")
              : tx("默认 GitHub Releases。留空恢复默认；自定义地址需是存放 latest.yml 和安装包的 HTTPS 目录。仅本机测试允许 http://127.0.0.1。")}
          </p>
          <div className={updateStyles.sourceInput}>
            <input id="knowgap-update-url" type="text" inputMode="url" spellCheck={false} autoComplete="off" maxLength={2048}
              className={styles.input} value={url} disabled={saving || sourceLocked || !state.enabled} placeholder={tx("默认：GitHub Releases")}
              aria-describedby="knowgap-update-url-help" onChange={(event) => setUrl(event.target.value)} />
            <button type="submit" className={styles.rowBtn} disabled={saving || sourceLocked || !state.enabled || url === settings.updateUrl}>{tx("保存地址")}</button>
          </div>
          {sourceLocked && !state.sourceFromEnv && <p className={styles.settingRowDesc}>{tx("更新处理期间或已下载时不能更换来源。")}</p>}
        </form>
      </>)}
      {note && <p role="status" className={styles.fieldHint}>{tx(note)}</p>}
    </section>
  );
}

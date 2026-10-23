// Electron is injected so the update policy can be tested without starting a desktop.
const UPDATE_DEFAULTS = Object.freeze({
  autoCheckUpdates: true,
  autoDownloadUpdates: true,
  autoInstallOnQuit: false,
  updateUrl: "",
});
const GITHUB = Object.freeze({ provider: "github", owner: "YinLingxiao", repo: "KnowGap" });
const CHANNELS = Object.freeze({ state: "updater:state", get: "updater:get-state", check: "updater:check", install: "updater:install" });
const URL_ERROR = "更新地址必须是 HTTPS 目录地址（本机测试仅允许 http://127.0.0.1），不能含用户名、密码、查询参数或片段。";

function validateUpdateUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error(URL_ERROR);
  const text = value.trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text) || /[\s\\]/.test(text)) throw new Error(URL_ERROR);
  let url;
  try { url = new URL(text); } catch { throw new Error(URL_ERROR); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      url.username || url.password || url.search || url.hash || !url.hostname) throw new Error(URL_ERROR);
  // A directory containing latest.yml, not the manifest itself.
  if (/\.(?:yml|yaml|exe|blockmap)$/i.test(url.pathname)) throw new Error(URL_ERROR);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

function normalizeUpdateSettings(data = {}) {
  let updateUrl = "";
  try { updateUrl = validateUpdateUrl(data.updateUrl ?? ""); } catch { /* corrupted settings fall back to GitHub */ }
  return {
    autoCheckUpdates: data.autoCheckUpdates !== false,
    autoDownloadUpdates: data.autoDownloadUpdates !== false,
    autoInstallOnQuit: data.autoInstallOnQuit === true,
    updateUrl,
  };
}

function validateUpdatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("桌面设置参数无效。");
  const allowed = new Set(["closeToTray", "openAtLogin", ...Object.keys(UPDATE_DEFAULTS)]);
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) throw new Error("不支持的桌面设置项。");
    if (key === "updateUrl") validateUpdateUrl(value);
    else if (typeof value !== "boolean") throw new Error("桌面开关必须是布尔值。");
  }
  return { ...patch, ...("updateUrl" in patch ? { updateUrl: validateUpdateUrl(patch.updateUrl) } : {}) };
}

function releaseText(notes) {
  const text = Array.isArray(notes) ? notes.map((item) => item?.note || "").join("\n") : typeof notes === "string" ? notes : "";
  return text.slice(0, 20000).replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 6000).trim();
}

function chineseError(error) {
  const text = String(error?.message || error || "");
  if (/sha512|checksum|digest/i.test(text)) return "更新文件校验失败，未安装。请稍后重新检查更新。";
  if (/429|403|rate.limit/i.test(text)) return "更新服务访问受限或请求过多，请稍后重试，或在设置中更换更新地址。";
  if (/404|latest.yml|no published versions/i.test(text)) return "更新源暂未提供可用的正式版本，请稍后重试或检查更新地址。";
  return "无法完成更新，请检查网络或更新地址后重试。当前版本仍可正常使用。";
}

function createUpdater({ app, ipcMain, getWindows, isTrustedSender, getSettings, prepareInstall, cancelInstall,
  confirmInstall, env = process.env, platform = process.platform, autoUpdater: injected,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  const enabled = app.isPackaged && platform === "win32" && env.KNOWGAP_DISABLE_UPDATE !== "1";
  const disabledReason = env.KNOWGAP_DISABLE_UPDATE === "1" ? "自动更新已由环境变量关闭。" : "自动更新仅在 Windows 安装版中可用。";
  const engine = enabled ? injected || require("electron-updater").autoUpdater : null;
  let state = { status: "idle", currentVersion: app.getVersion(), enabled, disabledReason: enabled ? "" : disabledReason,
    sourceFromEnv: Boolean(env.KNOWGAP_UPDATE_URL), version: null, progress: null, releaseNotes: "", error: null };
  let checkTask = null;
  let downloadTask = null;
  let installing = false;
  let installLaunched = false;
  let installFailed = false;
  let manual = false;
  let forceDownload = false;
  let baseline = state;
  let initialTimer;
  let intervalTimer;
  const listeners = [];
  const getState = () => ({ ...state, progress: state.progress ? { ...state.progress } : null });
  const publish = (patch) => {
    state = { ...state, ...patch };
    for (const win of getWindows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNELS.state, getState());
      } catch { /* A renderer closing during broadcast must not fail the download. */ }
    }
    return getState();
  };
  const failure = (error) => {
    if (installing) {
      installing = false;
      installFailed = true;
      publish({ status: "downloaded", error: "未能启动安装，将恢复当前版本。请稍后重试。" });
      cancelInstall();
      return getState();
    }
    // Never expose raw URLs, response bodies or filesystem paths to the renderer.
    if (manual) return publish({ status: "error", error: chineseError(error), progress: null });
    return publish({ ...baseline, error: null });
  };
  const on = (event, callback) => { engine.on(event, callback); listeners.push([event, callback]); };
  const settings = () => normalizeUpdateSettings(getSettings());
  const feed = () => {
    // An invalid environment override fails closed; it must not silently contact GitHub.
    const url = validateUpdateUrl(env.KNOWGAP_UPDATE_URL || settings().updateUrl);
    engine.setFeedURL(url ? { provider: "generic", url, useMultipleRangeRequest: true } : { ...GITHUB });
  };
  async function download() {
    if (downloadTask) return downloadTask;
    publish({ status: "downloading", progress: null, error: null });
    downloadTask = Promise.resolve().then(() => engine.downloadUpdate()).catch(failure).finally(() => { downloadTask = null; });
    return downloadTask;
  }
  if (engine) {
    // Downloads are started explicitly after the event, so the user preference is authoritative.
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.autoRunAppAfterInstall = true;
    engine.allowPrerelease = false;
    engine.allowDowngrade = false;
    engine.disableDifferentialDownload = false;
    // Keep the updater's SHA512 verification intact, even for unsigned NSIS installers.
    engine.logger = null;
    on("error", failure);
    on("update-available", (info) => {
      publish({ status: "available", version: info.version, releaseNotes: releaseText(info.releaseNotes), progress: null, error: null });
      if (settings().autoDownloadUpdates || forceDownload) void download();
    });
    on("update-not-available", () => publish(manual
      ? { status: "none", version: null, progress: null, releaseNotes: "", error: null }
      : { ...baseline, error: null }));
    on("download-progress", (info) => {
      const finite = (value) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
      publish({ status: "downloading", progress: { percent: Math.min(100, finite(info.percent)),
        bytesPerSecond: finite(info.bytesPerSecond), transferred: finite(info.transferred), total: finite(info.total) } });
    });
    on("update-downloaded", (info) => publish({ status: "downloaded", version: info.version,
      releaseNotes: releaseText(info.releaseNotes) || state.releaseNotes, progress: null, error: null }));
  }

  async function check(options = {}, userInitiated = true) {
    if (!options || typeof options !== "object" || Array.isArray(options) ||
        Object.keys(options).some((key) => key !== "download") ||
        ("download" in options && typeof options.download !== "boolean")) throw new Error("检查更新参数无效。");
    if (!enabled) return userInitiated ? publish({ status: "error", error: disabledReason }) : getState();
    if (installing || state.status === "downloaded") return getState();
    if (checkTask || downloadTask) {
      if (userInitiated) manual = true;
      return getState();
    }
    manual = userInitiated;
    forceDownload = options.download === true;
    baseline = { ...state, status: "idle", error: null, progress: null };
    if (forceDownload && state.status === "available") {
      await download();
      return getState();
    }
    publish({ status: "checking", error: null });
    checkTask = Promise.resolve().then(() => { feed(); return engine.checkForUpdates(); })
      .catch(failure).finally(() => { checkTask = null; });
    await checkTask;
    return getState();
  }

  async function install({ confirm = true, runAfter = true } = {}) {
    if (!enabled || state.status !== "downloaded" || installing) return false;
    installing = true;
    installLaunched = false;
    installFailed = false;
    let started = false;
    try {
      if (confirm && !(await confirmInstall(state.version))) return false;
      // The main process owns all paths and teardown. Never accept either from IPC.
      await prepareInstall();
      installLaunched = true;
      engine.quitAndInstall(true, runAfter);
      if (installFailed) return false;
      started = true;
      return true;
    } catch {
      installFailed = true;
      installing = false;
      publish({ status: "downloaded", error: "未能启动安装，请关闭占用程序后重试；也可继续使用当前版本。" });
      cancelInstall();
      return false;
    } finally {
      // Keep the latch set after success until the process exits.
      if (!started) installing = false;
    }
  }

  function configure() {
    if (!engine) return;
    // Do not use electron-updater's automatic quit hook: it can race backend teardown.
    engine.autoInstallOnAppQuit = false;
    if (initialTimer) timers.clearTimeout(initialTimer);
    if (intervalTimer) timers.clearInterval(intervalTimer);
    initialTimer = intervalTimer = null;
    if (settings().autoCheckUpdates) {
      initialTimer = timers.setTimeout(() => { void check({}, false); }, 20000);
      intervalTimer = timers.setInterval(() => { void check({}, false); }, 4 * 60 * 60 * 1000);
      initialTimer?.unref?.();
      intervalTimer?.unref?.();
    }
    if (settings().autoDownloadUpdates && state.status === "available") void download();
  }

  function validateSettingsChange(patch) {
    if ("updateUrl" in patch && patch.updateUrl !== settings().updateUrl) {
      if (checkTask || downloadTask || state.status === "downloaded" || installing) {
        throw new Error("更新正在处理或已下载，请重启应用后再更换更新地址。");
      }
      publish({ status: "idle", version: null, releaseNotes: "", error: null, progress: null });
    }
  }

  function handleBeforeQuit(event) {
    // A second tray Quit click must not bypass the in-flight backend teardown.
    if (installing) {
      if (!installLaunched) { event.preventDefault(); return true; }
      return false;
    }
    if (!enabled || installFailed || state.status !== "downloaded" || !settings().autoInstallOnQuit) return false;
    event.preventDefault();
    void install({ confirm: false, runAfter: false });
    return true;
  }

  for (const [channel, handler] of [[CHANNELS.get, getState], [CHANNELS.check, check], [CHANNELS.install, () => install()]]) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error("不允许此页面操作软件更新。");
      if ((channel !== CHANNELS.check && args.length) || args.length > 1) throw new Error("更新参数无效。");
      return handler(...args);
    });
  }
  configure();
  return { getState, check, install, configure, validateSettingsChange, handleBeforeQuit,
    dispose() {
      if (initialTimer) timers.clearTimeout(initialTimer);
      if (intervalTimer) timers.clearInterval(intervalTimer);
      for (const [event, callback] of listeners) engine.removeListener(event, callback);
      for (const channel of [CHANNELS.get, CHANNELS.check, CHANNELS.install]) ipcMain.removeHandler(channel);
    } };
}

module.exports = { createUpdater, UPDATE_DEFAULTS, CHANNELS, normalizeUpdateSettings, validateUpdateUrl, validateUpdatePatch, releaseText };

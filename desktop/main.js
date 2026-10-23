const { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { windowChromeOptions, applyWindowTheme } = require("./window-chrome");
const { createStartup } = require("./startup");
const { createUpdater, UPDATE_DEFAULTS, normalizeUpdateSettings, validateUpdatePatch } = require("./updater");

// 页面 origin 随端口变化，换端口会丢掉 localStorage（登录、演示模式、草稿等），所以优先复用固定端口
const PREFERRED_PORT = 38617;

let backend = null;
let stopping = false;
let mainWindow = null;
let startup = null;
let quickWindow = null;
let quickShortcut = null;
let quickFallbackTried = false;
let appOrigin = "";
let tray = null;
let quitting = false;
let updater = null;
let backendStopTask = null;
let revealOnReady = false;
let settings = { closeToTray: true, openAtLogin: false, backgroundNotified: false, theme: "system", ...UPDATE_DEFAULTS };
let trayStatus = { todayCount: 0 };

const QUICK_SHORTCUTS = ["Alt+Space", "CommandOrControl+Shift+K"];
const QUICK_WIDTH = 640;
const QUICK_MIN_HEIGHT = 120;
const QUICK_MAX_HEIGHT = 560;
if (process.platform === "win32") {
  app.setAppUserModelId("app.knowgap.desktop");
}

function backendPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "backend", "knowgap.exe");
  return path.join(__dirname, "..", "backend", "dist", "knowgap", "knowgap.exe");
}

function staticPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "frontend");
  return path.join(__dirname, "..", "frontend", "out");
}

function freePort(wanted = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(wanted, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portFile() {
  return path.join(app.getPath("userData"), "port.json");
}

function settingsFile() {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

function lastPort() {
  try {
    const port = Number(JSON.parse(fs.readFileSync(portFile(), "utf8")).port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function pickPort() {
  const tried = new Set();
  for (const wanted of [lastPort(), PREFERRED_PORT]) {
    if (!wanted || tried.has(wanted)) continue;
    tried.add(wanted);
    try {
      return await freePort(wanted);
    } catch {
      // 被占用就试下一个
    }
  }
  return freePort();
}

function rememberPort(port) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(portFile(), JSON.stringify({ port }));
  } catch {
    // 记不住只是下次可能换端口，不影响启动
  }
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    settings = {
      closeToTray: data.closeToTray !== false,
      openAtLogin: data.openAtLogin === true,
      backgroundNotified: data.backgroundNotified === true,
      theme: data.theme === "light" || data.theme === "dark" ? data.theme : "system",
      ...normalizeUpdateSettings(data),
    };
  } catch {
    settings = { closeToTray: true, openAtLogin: false, backgroundNotified: false, theme: "system", ...UPDATE_DEFAULTS };
  }
  nativeTheme.themeSource = settings.theme;
}

function saveSettings() {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({
      closeToTray: settings.closeToTray,
      openAtLogin: settings.openAtLogin,
      backgroundNotified: settings.backgroundNotified,
      theme: settings.theme,
      ...normalizeUpdateSettings(settings),
    }));
  } catch {
    // 写失败时本次会话仍用内存里的开关
  }
}

function publicSettings() {
  return { closeToTray: settings.closeToTray, openAtLogin: settings.openAtLogin, ...normalizeUpdateSettings(settings) };
}

function applyLoginItem() {
  app.setLoginItemSettings({
    openAtLogin: settings.openAtLogin,
    args: ["--hidden"],
  });
}

function applySettingsPatch(patch) {
  patch = validateUpdatePatch(patch);
  updater?.validateSettingsChange(patch);
  if (typeof patch.closeToTray === "boolean") settings.closeToTray = patch.closeToTray;
  if (typeof patch.openAtLogin === "boolean") {
    const changed = patch.openAtLogin !== settings.openAtLogin;
    settings.openAtLogin = patch.openAtLogin;
    if (changed) applyLoginItem();
  }
  for (const key of Object.keys(UPDATE_DEFAULTS)) {
    if (key in patch) settings[key] = patch[key];
  }
  saveSettings();
  updater?.configure();
  refreshTrayMenu();
  return publicSettings();
}

function waitHealth(port) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ hostname: "127.0.0.1", port, path: "/health", timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > 30000) {
        const log = path.join(app.getPath("userData"), "logs", "backend.log");
        reject(new Error(`后端没有在 30 秒内启动（端口 ${port}）。\n日志：${log}`));
      } else setTimeout(tick, 300);
    };
    tick();
  });
}

function stopBackend() {
  stopping = true;
  if (backendStopTask) return backendStopTask;
  if (!backend || backend.killed || backend.exitCode !== null) return Promise.resolve(true);
  const child = backend;
  // Updating must await the whole PyInstaller process tree, not just spawn taskkill.
  backendStopTask = new Promise((resolve) => {
    let settled = false;
    let timeout;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (ok && backend === child) backend = null;
      resolve(ok);
    };
    timeout = setTimeout(() => done(false), 8000);
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      killer.once("error", () => done(false));
      killer.once("exit", (code) => done(code === 0 || child.exitCode !== null));
    } else {
      child.once("exit", () => done(true));
      child.kill();
    }
  }).finally(() => { backendStopTask = null; });
  return backendStopTask;
}

function trustedDesktopSender(event) {
  const windows = [mainWindow, quickWindow].filter((win) => win && !win.isDestroyed());
  if (!windows.some((win) => win.webContents === event.sender) || event.senderFrame !== event.sender.mainFrame) return false;
  try { return Boolean(appOrigin && new URL(event.senderFrame.url).origin === appOrigin); } catch { return false; }
}

function setupUpdater() {
  updater = createUpdater({
    app, ipcMain,
    getWindows: () => [mainWindow, quickWindow].filter(Boolean),
    isTrustedSender: trustedDesktopSender,
    getSettings: () => settings,
    confirmInstall: async (version) => {
      // Always confirm: covers replies in both the main window and a hidden quick panel.
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      if (parent) showMain();
      const options = {
        type: "question", title: "重启并安装", buttons: ["取消", "重启并安装"], defaultId: 0, cancelId: 0,
        message: `现在重启并安装 KnowGap ${version}？`,
        detail: "安装会关闭主窗口、快问和后台服务，正在生成的回复会被中断。已保存的学习数据会保留。为所有用户安装时可能出现 Windows 管理员权限（UAC）提示，请确认后继续。",
      };
      const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return result.response === 1;
    },
    prepareInstall: async () => {
      quitting = true;
      if (!(await stopBackend())) throw new Error("后端尚未退出");
      startup?.dispose();
      startup = null;
      if (quickWindow && !quickWindow.isDestroyed()) quickWindow.destroy();
      if (tray) { tray.destroy(); tray = null; }
    },
    cancelInstall: () => {
      if (!backend) {
        // The installer may fail after teardown (e.g. cancelled elevation).
        // Restart the current version rather than leave a live window with a dead backend.
        app.relaunch();
        app.quit();
      } else {
        quitting = false;
        stopping = false;
        createTray();
      }
    },
  });
}

function quitApp() {
  quitting = true;
  app.quit();
}

ipcMain.handle("select-folder", async (_event, defaultPath) => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    defaultPath: typeof defaultPath === "string" && defaultPath ? defaultPath : undefined,
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("set-theme", (_event, theme) => {
  const next = theme === "light" || theme === "dark" ? theme : "system";
  nativeTheme.themeSource = next;
  if (settings.theme !== next) {
    settings.theme = next;
    saveSettings();
  }
  syncMainWindowTheme();
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
});

function syncMainWindowTheme() {
  // 不触碰透明快问窗口；系统主题改变时也同步原生标题栏按钮。
  if (!mainWindow || mainWindow.isDestroyed()) return;
  applyWindowTheme(mainWindow, process.platform, nativeTheme.shouldUseDarkColors);
  startup?.setTheme(nativeTheme.shouldUseDarkColors);
}

nativeTheme.on("updated", syncMainWindowTheme);

function placeQuickWindow() {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const [, height] = quickWindow.getSize();
  const x = Math.round(workArea.x + (workArea.width - QUICK_WIDTH) / 2);
  const y = Math.round(workArea.y + workArea.height * 0.22);
  quickWindow.setBounds({ x, y, width: QUICK_WIDTH, height });
}

function createQuickWindow() {
  quickWindow = new BrowserWindow({
    width: QUICK_WIDTH,
    height: QUICK_MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    title: "KnowGap 快问",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  quickWindow.setAlwaysOnTop(true, "floating");
  quickWindow.on("blur", () => {
    if (quickWindow && !quickWindow.webContents.isDevToolsOpened()) quickWindow.hide();
  });
  quickWindow.on("closed", () => {
    quickWindow = null;
  });
  // 静态导出产物是 quick.html；后端 StaticFiles 不会把 /quick 映射到 quick.html。
  // 若 quick.html 因旧版安装包/静态资源不完整而加载失败，再尝试 SPA 路由 /quick
  //（新版后端会把无扩展名路由回退到同名 .html），避免浮窗只剩一块空白。
  quickFallbackTried = false;
  quickWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    if (quickFallbackTried || !appOrigin || url.endsWith("/quick")) return;
    quickFallbackTried = true;
    console.warn(`[KnowGap] ${url} 加载失败（${code} ${description}），回退到 /quick`);
    void quickWindow.loadURL(`${appOrigin}/quick`);
  });
  void quickWindow.loadURL(`${appOrigin}/quick.html`);
}

function showQuickWindow() {
  if (!appOrigin) return;
  if (!quickWindow || quickWindow.isDestroyed()) createQuickWindow();
  placeQuickWindow();
  quickWindow.show();
  quickWindow.focus();
  quickWindow.webContents.send("quick-shown");
}

function toggleQuickWindow() {
  if (!appOrigin) return;
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible() && quickWindow.isFocused()) {
    quickWindow.hide();
    return;
  }
  showQuickWindow();
}

function registerQuickShortcut() {
  for (const accelerator of QUICK_SHORTCUTS) {
    try {
      if (globalShortcut.register(accelerator, toggleQuickWindow)) {
        quickShortcut = accelerator;
        console.log(`[KnowGap] 快问浮窗快捷键：${accelerator}`);
        return;
      }
      console.warn(`[KnowGap] 快捷键 ${accelerator} 注册失败（可能被系统或其他应用占用），尝试下一个`);
    } catch (error) {
      console.warn(`[KnowGap] 快捷键 ${accelerator} 注册出错：${error.message}`);
    }
  }
  console.warn("[KnowGap] 快问浮窗快捷键全部注册失败，浮窗不可用");
}

function displayShortcut() {
  if (quickShortcut === "CommandOrControl+Shift+K") {
    return process.platform === "darwin" ? "Cmd+Shift+K" : "Ctrl+Shift+K";
  }
  return quickShortcut;
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function mainIsShown() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
}

function notifyBackgroundOnce() {
  if (settings.backgroundNotified) return;
  settings.backgroundNotified = true;
  saveSettings();
  if (!Notification.isSupported()) return;
  try {
    const key = displayShortcut() || "Alt+Space";
    new Notification({
      title: "KnowGap",
      body: `KnowGap 仍在后台运行，${key} 随时快问`,
      icon: path.join(__dirname, "icon.png"),
    }).show();
  } catch {
    // 系统拒绝通知时仍然留在托盘
  }
}

function hideMainToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  notifyBackgroundOnce();
}

function toggleMain() {
  if (mainIsShown()) hideMainToTray();
  else showMain();
}

function setTrayStatus(patch) {
  if (!patch || typeof patch !== "object") return;
  let menuDirty = false;
  if ("todayCount" in patch && typeof patch.todayCount === "number" && Number.isFinite(patch.todayCount)) {
    const next = Math.max(0, Math.round(patch.todayCount));
    if (next !== trayStatus.todayCount) {
      trayStatus.todayCount = next;
      menuDirty = true;
    }
  }
  if (menuDirty) refreshTrayMenu();
}

function sendTrayCommand(command) {
  if (command === "quick-ask") showQuickWindow();
  if (command === "open-agenda") showMain();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("tray-command", command);
}

function buildTrayMenu() {
  const key = displayShortcut();
  return Menu.buildFromTemplate([
    { label: "打开 KnowGap", click: () => showMain() },
    { label: key ? `快问（${key}）` : "快问", click: () => showQuickWindow() },
    { label: `今日待办 ${trayStatus.todayCount} 项`, click: () => sendTrayCommand("open-agenda") },
    { type: "separator" },
    {
      label: "关闭时最小化到托盘",
      type: "checkbox",
      checked: settings.closeToTray,
      click: (item) => {
        settings.closeToTray = Boolean(item.checked);
        saveSettings();
      },
    },
    {
      label: "开机自启",
      type: "checkbox",
      checked: settings.openAtLogin,
      click: (item) => {
        settings.openAtLogin = Boolean(item.checked);
        applyLoginItem();
        saveSettings();
      },
    },
    { label: "退出", click: () => quitApp() },
  ]);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip("KnowGap");
}

function trayImage() {
  const ico = nativeImage.createFromPath(path.join(__dirname, "icon.ico"));
  if (!ico.isEmpty()) return ico;
  return nativeImage.createFromPath(path.join(__dirname, "icon.png"));
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip("KnowGap");
  tray.setIgnoreDoubleClickEvents(true);
  refreshTrayMenu();
  tray.on("click", () => toggleMain());
}

ipcMain.handle("quick-hide", () => {
  if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
});

ipcMain.handle("quick-resize", (_event, height) => {
  if (!quickWindow || quickWindow.isDestroyed()) return;
  const next = Math.max(QUICK_MIN_HEIGHT, Math.min(QUICK_MAX_HEIGHT, Math.round(Number(height) || 0)));
  const [width, current] = quickWindow.getSize();
  if (next !== current) quickWindow.setSize(width, next);
});

ipcMain.handle("quick-shortcut", () => quickShortcut);

ipcMain.handle("open-in-main", (_event, conversationId) => {
  if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
  showMain();
  if (mainWindow && !mainWindow.isDestroyed() && typeof conversationId === "string" && conversationId) {
    mainWindow.webContents.send("open-conversation", conversationId);
  }
});

ipcMain.handle("show-main", () => {
  showMain();
});

ipcMain.handle("set-tray-status", (_event, patch) => {
  setTrayStatus(patch);
});

ipcMain.handle("get-desktop-settings", (event, ...args) => {
  if (!trustedDesktopSender(event) || args.length) throw new Error("桌面设置请求无效。");
  return publicSettings();
});

ipcMain.handle("set-desktop-settings", (event, patch, ...extra) => {
  if (!trustedDesktopSender(event) || extra.length) throw new Error("桌面设置请求无效。");
  return applySettingsPatch(patch);
});

// 外部网页（ChatGPT 授权页、文档链接等）一律交给系统默认浏览器：用户的登录状态都在那里，
// 应用内新开的 Electron 窗口是一个没有任何登录信息的空白环境。
function openInDefaultBrowser(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
  } catch {
    // 非法或 about:blank 之类的地址不处理
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "KnowGap",
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#08080a" : "#ffffff",
    ...windowChromeOptions(process.platform, nativeTheme.shouldUseDarkColors),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: ["--knowgap-main-window"],
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInDefaultBrowser(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let origin = "";
    try { origin = new URL(url).origin; } catch { /* 无法解析的地址一律拦下 */ }
    if (origin && origin === appOrigin) return;
    event.preventDefault();
    openInDefaultBrowser(url);
  });
  mainWindow.on("close", (event) => {
    if (quitting || !settings.closeToTray) return;
    event.preventDefault();
    hideMainToTray();
  });
  mainWindow.on("closed", () => {
    startup?.dispose();
    startup = null;
    mainWindow = null;
    // 隐藏的浮窗也算打开的窗口，主窗口关掉时一并销毁，否则 window-all-closed 不会触发
    if (quickWindow && !quickWindow.isDestroyed()) quickWindow.destroy();
  });
}

async function open() {
  const exe = backendPath();
  const folder = staticPath();
  if (!fs.existsSync(exe)) {
    throw new Error(`找不到后端程序：${exe}\n请重新安装 KnowGap。`);
  }
  if (!fs.existsSync(path.join(folder, "index.html"))) {
    throw new Error(`找不到前端静态资源：${folder}\n请重新安装 KnowGap。`);
  }
  createMainWindow();
  try {
    startup = createStartup(mainWindow, {
      logoPath: path.join(folder, "brand", "knowgap-logo.svg"),
      dark: nativeTheme.shouldUseDarkColors,
      platform: process.platform,
    });
    await startup.ready;
  } catch (error) {
    // Optional animation must never prevent the application from starting.
    console.warn("[KnowGap] 启动动效加载失败，直接打开应用", error);
    startup?.dispose();
    startup = null;
  }
  if (stopping || !mainWindow || mainWindow.isDestroyed()) return;
  if (revealOnReady || !process.argv.includes("--hidden")) showMain();

  const port = await pickPort();
  if (stopping || !mainWindow || mainWindow.isDestroyed()) return;
  console.log(`[KnowGap] 数据目录：${app.getPath("userData")}`);
  backend = spawn(exe, ["--port", String(port), "--static", folder], {
    env: { ...process.env, KNOWGAP_DATA_DIR: app.getPath("userData") },
    windowsHide: true,
  });
  backend.on("error", (error) => {
    console.error("[KnowGap] 后端启动失败", error);
    if (!stopping) dialog.showErrorBox("KnowGap", `后端启动失败：${error.message}`);
  });
  backend.on("exit", (code, signal) => {
    if (stopping) return;
    const reason = code === null ? `信号 ${signal}` : `退出码 ${code}`;
    console.error(`[KnowGap] 后端意外退出（${reason}）`);
    dialog.showErrorBox("KnowGap", `后端已退出（${reason}），请重启应用。`);
  });
  await waitHealth(port);
  if (stopping || !mainWindow || mainWindow.isDestroyed()) return;
  rememberPort(port);
  startup?.setStatus("正在打开学习空间");
  appOrigin = `http://127.0.0.1:${port}`;
  await mainWindow.loadURL(`${appOrigin}/`);
  try {
    await startup?.finish();
  } catch (error) {
    console.warn("[KnowGap] 启动过渡已跳过", error);
  }
  startup = null;
  if (stopping || !mainWindow || mainWindow.isDestroyed()) return;
  registerQuickShortcut();
  refreshTrayMenu();
}

if (!app.requestSingleInstanceLock()) {
  // 重复启动会再起一个后端、抢端口并让两个窗口写同一份数据，路演现场很容易误触。
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      revealOnReady = true;
      return;
    }
    showMain();
  });
  app.whenReady().then(() => {
    loadSettings();
    applyLoginItem();
    createTray();
    setupUpdater();
    return open();
  }).catch((error) => {
    dialog.showErrorBox("KnowGap", error.message);
    quitting = true;
    stopBackend();
    app.quit();
  });
}

app.on("before-quit", (event) => {
  if (updater?.handleBeforeQuit(event)) return;
  quitting = true;
  startup?.dispose();
  startup = null;
  if (quickWindow && !quickWindow.isDestroyed()) quickWindow.destroy();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  stopBackend();
});
app.on("will-quit", () => {
  updater?.dispose();
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {
  stopBackend();
  app.quit();
});

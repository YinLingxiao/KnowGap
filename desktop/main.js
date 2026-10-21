const { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, screen } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");

// 页面 origin 随端口变化，换端口会丢掉 localStorage（登录、演示模式、草稿等），所以优先复用固定端口
const PREFERRED_PORT = 38617;

let backend = null;
let stopping = false;
let mainWindow = null;
let quickWindow = null;
let quickShortcut = null;
let quickFallbackTried = false;
let appOrigin = "";

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
  if (!backend || backend.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(backend.pid), "/t", "/f"], { windowsHide: true });
  } else {
    backend.kill();
  }
  backend = null;
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
  const bg = nativeTheme.shouldUseDarkColors ? "#111215" : "#ffffff";
  for (const win of BrowserWindow.getAllWindows()) {
    // 快问浮窗是透明窗口，设置底色会让面板外的区域变成实色
    if (!win.isDestroyed() && win !== quickWindow) win.setBackgroundColor(bg);
  }
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
});

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

function toggleQuickWindow() {
  if (!appOrigin) return;
  if (!quickWindow || quickWindow.isDestroyed()) createQuickWindow();
  if (quickWindow.isVisible() && quickWindow.isFocused()) {
    quickWindow.hide();
    return;
  }
  placeQuickWindow();
  quickWindow.show();
  quickWindow.focus();
  quickWindow.webContents.send("quick-shown");
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

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
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
  const win = focusMainWindow();
  if (win && typeof conversationId === "string" && conversationId) {
    win.webContents.send("open-conversation", conversationId);
  }
});

async function open() {
  const port = await pickPort();
  const exe = backendPath();
  const folder = staticPath();
  if (!fs.existsSync(exe)) {
    throw new Error(`找不到后端程序：${exe}\n请重新安装 KnowGap。`);
  }
  if (!fs.existsSync(path.join(folder, "index.html"))) {
    throw new Error(`找不到前端静态资源：${folder}\n请重新安装 KnowGap。`);
  }
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
    // 后端退出后窗口只剩报错页，直接提示用户重启，避免以为应用还在正常工作。
    dialog.showErrorBox("KnowGap", `后端已退出（${reason}），请重启应用。`);
  });
  await waitHealth(port);
  rememberPort(port);
  appOrigin = `http://127.0.0.1:${port}`;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "KnowGap",
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111215" : "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    // 隐藏的浮窗也算打开的窗口，主窗口关掉时一并销毁，否则 window-all-closed 不会触发
    if (quickWindow && !quickWindow.isDestroyed()) quickWindow.destroy();
  });
  await mainWindow.loadURL(`${appOrigin}/`);
  registerQuickShortcut();
}

if (!app.requestSingleInstanceLock()) {
  // 重复启动会再起一个后端、抢端口并让两个窗口写同一份数据，路演现场很容易误触。
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(open).catch((error) => {
    dialog.showErrorBox("KnowGap", error.message);
    stopBackend();
    app.quit();
  });
}

app.on("before-quit", () => {
  if (quickWindow && !quickWindow.isDestroyed()) quickWindow.destroy();
  stopBackend();
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {
  stopBackend();
  app.quit();
});

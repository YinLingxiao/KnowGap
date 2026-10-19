const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");

let backend = null;
let stopping = false;

function backendPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "backend", "knowgap.exe");
  return path.join(__dirname, "..", "backend", "dist", "knowgap", "knowgap.exe");
}

function staticPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "frontend");
  return path.join(__dirname, "..", "frontend", "out");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
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
      if (Date.now() - started > 30000) reject(new Error("后端没有在 30 秒内启动"));
      else setTimeout(tick, 300);
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

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

async function open() {
  const port = await freePort();
  const exe = backendPath();
  const folder = staticPath();
  backend = spawn(exe, ["--port", String(port), "--static", folder], {
    env: { ...process.env, KNOWGAP_DATA_DIR: app.getPath("userData") },
    windowsHide: true,
  });
  backend.on("exit", (code) => {
    if (!stopping && code) dialog.showErrorBox("KnowGap", `后端已退出（${code}）`);
  });
  await waitHealth(port);
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "KnowGap",
    backgroundColor: "#111215",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await window.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(open).catch((error) => {
  dialog.showErrorBox("KnowGap", error.message);
  stopBackend();
  app.quit();
});

app.on("before-quit", stopBackend);
app.on("window-all-closed", () => {
  stopBackend();
  app.quit();
});

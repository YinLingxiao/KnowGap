const fs = require("fs");
const path = require("path");

function buildStartupDocument({ logoSvg, dark, platform }) {
  // Animate the existing brand's actual facets, without maintaining a second logo.
  let part = 0;
  const mark = logoSvg.replace(/<path\b[\s\S]*?\/>/g, (svgPath) =>
    `<g class="piece piece-${part++}">${svgPath}</g>`);
  return fs.readFileSync(path.join(__dirname, "startup.html"), "utf8")
    .replace("__THEME__", dark ? "dark" : "light")
    .replace("__PLATFORM__", ["win32", "darwin", "linux"].includes(platform) ? platform : "linux")
    .replace("__STARTUP_LOGO__", mark);
}

function createStartup(win, { logoPath, dark, platform }) {
  const { WebContentsView } = require("electron");
  const html = buildStartupDocument({ logoSvg: fs.readFileSync(logoPath, "utf8"), dark, platform });
  // Keep the real app loading behind a temporary transparent view. Navigation
  // never replaces the splash's renderer, so the handoff can genuinely crossfade.
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  view.setBackgroundColor("#00000000");
  win.contentView.addChildView(view);
  let disposed = false;
  let finishing = null;
  const resize = () => {
    if (disposed || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  const run = (method, value) => {
    if (disposed || view.webContents.isDestroyed()) return Promise.resolve();
    return view.webContents.executeJavaScript(`window.knowgapStartup.${method}(${JSON.stringify(value) ?? ""})`);
  };
  const visibility = () => {
    void ready.then(() => run("setPaused", !win.isVisible())).catch(() => undefined);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    win.removeListener("resize", resize);
    win.removeListener("show", visibility);
    win.removeListener("hide", visibility);
    win.removeListener("closed", dispose);
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };
  resize();
  win.on("resize", resize);
  win.on("show", visibility);
  win.on("hide", visibility);
  win.once("closed", dispose);
  const ready = view.webContents.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  visibility();
  return {
    ready,
    setTheme: (nextDark) => { void ready.then(() => run("setTheme", nextDark)).catch(() => undefined); },
    setStatus: (text) => { void ready.then(() => run("setStatus", text)).catch(() => undefined); },
    finish() {
      if (finishing) return finishing;
      // No minimum splash duration: the ready app takes over immediately, with
      // only a short crossfade. A hidden launch skips even that transition.
      finishing = (async () => {
        try {
          await ready;
          if (!disposed && !win.isDestroyed() && win.isVisible()) await run("finish");
        } finally {
          dispose();
          if (!win.isDestroyed() && win.isVisible() && win.isFocused()) win.webContents.focus();
        }
      })();
      return finishing;
    },
    dispose,
  };
}

module.exports = { buildStartupDocument, createStartup };

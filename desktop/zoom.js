// 主窗口缩放：Ctrl + 滚轮 / 触控板捏合，以及 Ctrl + = / - / 0。
// Electron 默认只发 zoom-changed 事件、不真的缩放，菜单栏又隐藏了，所以这里自己接上。

const ZOOM_MIN = -3; // 约 58%
const ZOOM_MAX = 5; // 约 249%
const ZOOM_STEP = 0.5;

function clampZoom(level) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(level * 2) / 2));
}

/** 键盘输入对应的缩放动作：in / out / reset，不是缩放键时返回 null */
function zoomActionForInput(input) {
  if (!input || input.type !== "keyDown" || input.alt) return null;
  if (!(input.control || input.meta)) return null;
  const key = input.key;
  if (key === "=" || key === "+" || input.code === "NumpadAdd") return "in";
  if (key === "-" || key === "_" || input.code === "NumpadSubtract") return "out";
  if (key === "0" || input.code === "Numpad0") return "reset";
  return null;
}

function nextZoomLevel(current, action) {
  if (action === "reset") return 0;
  if (action === "in") return clampZoom(current + ZOOM_STEP);
  if (action === "out") return clampZoom(current - ZOOM_STEP);
  return clampZoom(current);
}

function attachZoom(webContents) {
  const apply = (action) => webContents.setZoomLevel(nextZoomLevel(webContents.getZoomLevel(), action));
  webContents.on("before-input-event", (event, input) => {
    const action = zoomActionForInput(input);
    if (!action) return;
    event.preventDefault();
    apply(action);
  });
  webContents.on("zoom-changed", (_event, direction) => {
    apply(direction === "in" ? "in" : "out");
  });
}

module.exports = { ZOOM_MIN, ZOOM_MAX, clampZoom, zoomActionForInput, nextZoomLevel, attachZoom };

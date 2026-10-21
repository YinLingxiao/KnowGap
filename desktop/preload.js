const { contextBridge, ipcRenderer } = require("electron");

// 主窗口里“打开某个对话”的订阅者；没有订阅者时退回为刷新页面，
// 由前端从 localStorage 恢复快问浮窗预先写好的活动对话。
const openConversationListeners = new Set();

ipcRenderer.on("open-conversation", (_event, conversationId) => {
  if (openConversationListeners.size === 0) {
    window.location.reload();
    return;
  }
  for (const listener of openConversationListeners) listener(conversationId);
});

const quickShownListeners = new Set();
ipcRenderer.on("quick-shown", () => {
  for (const listener of quickShownListeners) listener();
});

contextBridge.exposeInMainWorld("knowgap", {
  selectFolder: (defaultPath) => ipcRenderer.invoke("select-folder", defaultPath),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
  onOpenConversation: (listener) => {
    openConversationListeners.add(listener);
    return () => openConversationListeners.delete(listener);
  },
  quick: {
    hide: () => ipcRenderer.invoke("quick-hide"),
    resize: (height) => ipcRenderer.invoke("quick-resize", height),
    shortcut: () => ipcRenderer.invoke("quick-shortcut"),
    openInMain: (conversationId) => ipcRenderer.invoke("open-in-main", conversationId),
    onShown: (listener) => {
      quickShownListeners.add(listener);
      return () => quickShownListeners.delete(listener);
    },
  },
});

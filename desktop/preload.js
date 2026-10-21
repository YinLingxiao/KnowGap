const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("knowgap", {
  selectFolder: (defaultPath) => ipcRenderer.invoke("select-folder", defaultPath),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
});

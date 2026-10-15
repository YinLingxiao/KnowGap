const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("knowgap", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
});

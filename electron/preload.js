const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  selectFiles: (options) => ipcRenderer.invoke("select-files", options),
  selectDirectory: () => ipcRenderer.invoke("select-directory"),
  apiRequest: (request) => ipcRenderer.invoke("api-request", request),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  readStats: () => ipcRenderer.invoke('read-stats')
});

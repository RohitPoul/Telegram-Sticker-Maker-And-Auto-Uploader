const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  selectFiles: (options) => ipcRenderer.invoke("select-files", options),
  selectFile: (options) => ipcRenderer.invoke("select-files", options), // Add selectFile alias
  selectDirectory: () => ipcRenderer.invoke("select-directory"),
  apiRequest: (request) => ipcRenderer.invoke("api-request", request),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  readStats: () => ipcRenderer.invoke('read-stats')
});

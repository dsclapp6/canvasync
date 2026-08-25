// Preload — exposes native powers to the bridge-served dashboard.
// The dashboard detects `window.canvasync` to unlock app-only features
// (open/reveal files, bridge restart, local-model management).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('canvasync', {
  getSecret:          ()        => ipcRenderer.invoke('get-secret'),
  getDataRoot:        ()        => ipcRenderer.invoke('get-data-root'),
  openPath:           (p)       => ipcRenderer.invoke('open-path', p),
  revealPath:         (p)       => ipcRenderer.invoke('reveal-path', p),
  restartBridge:      ()        => ipcRenderer.invoke('restart-bridge'),
  chooseDataRoot:     ()        => ipcRenderer.invoke('choose-data-root'),
  checkLocalModel:    (modelId) => ipcRenderer.invoke('check-local-model', modelId),
  downloadLocalModel: (modelId) => ipcRenderer.invoke('download-local-model', modelId),
});

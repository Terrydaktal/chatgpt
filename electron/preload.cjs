const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // We will add IPC handlers here
  sendMessage: (channel, data) => ipcRenderer.send(channel, data),
  onMessage: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
  onCacheProgress: (func) => ipcRenderer.on('api:cacheProgress', (event, ...args) => func(...args)),
  onBridgeComposerStatus: (func) => {
    const handler = (_event, ...args) => func(...args);
    ipcRenderer.on('api:bridgeComposerStatus', handler);
    return () => ipcRenderer.removeListener('api:bridgeComposerStatus', handler);
  },
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});

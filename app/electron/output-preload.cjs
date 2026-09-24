const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('projection', Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('output:get-snapshot'),
  failed: () => ipcRenderer.send('output:failed'),
  onMarker(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('output:marker', listener);
    return () => ipcRenderer.removeListener('output:marker', listener);
  },
  onSnapshot(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('output:snapshot', listener);
    return () => ipcRenderer.removeListener('output:snapshot', listener);
  },
}));

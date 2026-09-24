const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('projection', Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('output:get-snapshot'),
  failed: () => ipcRenderer.send('output:failed'),
  answerWebRTC: (payload) => ipcRenderer.send('output:webrtc-answer', payload),
  reportWebRTCStatus: (payload) => ipcRenderer.send('output:webrtc-status', payload),
  onWebRTCOffer(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('output:webrtc-offer', listener);
    return () => ipcRenderer.removeListener('output:webrtc-offer', listener);
  },
  onWebRTCReset(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('output:webrtc-reset', listener);
    return () => ipcRenderer.removeListener('output:webrtc-reset', listener);
  },
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

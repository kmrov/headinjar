const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('shell:get-snapshot'),
  selectSource: (kind) => ipcRenderer.invoke('shell:select-source', kind),
  sourceReady: () => ipcRenderer.invoke('shell:source-ready'),
  acceptWebRTCOffer: (offer) => ipcRenderer.invoke('shell:webrtc-offer', offer),
  answerWebRTC: (payload) => ipcRenderer.send('shell:webrtc-answer', payload),
  reportWebRTCStatus: (payload) => ipcRenderer.send('shell:webrtc-status', payload),
  startSignaling: () => ipcRenderer.invoke('shell:signaling-start'),
  stopSignaling: () => ipcRenderer.invoke('shell:signaling-stop'),
  copySignalingUrl: () => ipcRenderer.invoke('shell:signaling-copy-url'),
  copyWhipUrl: () => ipcRenderer.invoke('shell:whip-copy-url'),
  copyWhipToken: () => ipcRenderer.invoke('shell:whip-copy-token'),
  listDisplays: () => ipcRenderer.invoke('shell:list-displays'),
  openOutput: (displayId, expectedSize) => ipcRenderer.invoke('shell:open-output', displayId, expectedSize),
  outputAction: (event) => ipcRenderer.invoke('shell:output-action', event),
  setCalibrationMarker: (value) => ipcRenderer.invoke('shell:calibration-marker', value),
  editProject: (command) => ipcRenderer.invoke('shell:edit-project', command),
  undo: () => ipcRenderer.invoke('shell:undo'),
  redo: () => ipcRenderer.invoke('shell:redo'),
  importMesh: () => ipcRenderer.invoke('shell:import-mesh'),
  importReference: () => ipcRenderer.invoke('shell:import-reference'),
  newProject: (name) => ipcRenderer.invoke('shell:new-project', name),
  saveProject: () => ipcRenderer.invoke('shell:save-project'),
  openProject: () => ipcRenderer.invoke('shell:open-project'),
  onWebRTCOffer(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('shell:webrtc-offer', listener);
    return () => ipcRenderer.removeListener('shell:webrtc-offer', listener);
  },
  onWebRTCReset(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('shell:webrtc-reset', listener);
    return () => ipcRenderer.removeListener('shell:webrtc-reset', listener);
  },
  onSnapshot(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('shell:snapshot', listener);
    return () => ipcRenderer.removeListener('shell:snapshot', listener);
  },
}));

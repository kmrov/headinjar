const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('shell:get-snapshot'),
  selectSource: (kind) => ipcRenderer.invoke('shell:select-source', kind),
  acceptWebRTCOffer: (offer) => ipcRenderer.invoke('shell:webrtc-offer', offer),
  startSignaling: () => ipcRenderer.invoke('shell:signaling-start'),
  stopSignaling: () => ipcRenderer.invoke('shell:signaling-stop'),
  copySignalingUrl: () => ipcRenderer.invoke('shell:signaling-copy-url'),
  copyWhipUrl: () => ipcRenderer.invoke('shell:whip-copy-url'),
  copyWhipToken: () => ipcRenderer.invoke('shell:whip-copy-token'),
  listDisplays: () => ipcRenderer.invoke('shell:list-displays'),
  openOutput: (displayId) => ipcRenderer.invoke('shell:open-output', displayId),
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
  onSnapshot(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('shell:snapshot', listener);
    return () => ipcRenderer.removeListener('shell:snapshot', listener);
  },
}));

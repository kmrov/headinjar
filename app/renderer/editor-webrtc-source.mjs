const dimensions = value => ({
  width: value?.videoWidth || value?.displayWidth || value?.width || 0,
  height: value?.videoHeight || value?.displayHeight || value?.height || 0,
});

export function createEditorWebRTCSource({
  desktop,
  mediaChannel,
  videoElement,
  createReceiver,
  createPublisher,
  createCanvas = () => document.createElement('canvas'),
  onPreviewFrame = () => {},
  onClearPreview = () => {},
  onState = () => {},
} = {}) {
  if (!desktop || typeof mediaChannel !== 'string' || !mediaChannel) throw new TypeError('Editor media channel is required');
  if (typeof createReceiver !== 'function' || typeof createPublisher !== 'function') throw new TypeError('Editor receiver and publisher factories are required');
  for (const method of ['sourceReady', 'answerWebRTC', 'reportWebRTCStatus', 'onWebRTCOffer', 'onWebRTCReset']) {
    if (typeof desktop[method] !== 'function') throw new TypeError(`Editor bridge is missing ${method}`);
  }

  const previewCanvas = createCanvas();
  const previewContext = previewCanvas.getContext('2d', { alpha: false });
  if (!previewContext) throw new Error('Could not create the live preview canvas context.');
  const publisher = createPublisher({ channelName: mediaChannel });
  if (!publisher || typeof publisher.publish !== 'function' || typeof publisher.clear !== 'function' || typeof publisher.close !== 'function') {
    throw new TypeError('Invalid frame publisher');
  }

  let snapshot = null;
  let sourceKind = 'reference';
  let activeSessionId = null;
  let localStatus = { sessionId: null, status: 'disconnected', width: 0, height: 0, detail: '' };
  let lastSize = null;
  let hasFrame = false;
  let frozen = false;
  let closed = false;

  function state() {
    return Object.freeze({
      frozen, hasFrame, canFreeze: hasFrame && localStatus.status === 'running',
      sessionId: activeSessionId, status: localStatus.status,
      width: hasFrame ? previewCanvas.width : localStatus.width,
      height: hasFrame ? previewCanvas.height : localStatus.height,
    });
  }
  function notify() { onState(state()); }
  function report(error) {
    const message = error instanceof Error ? error.message : String(error || 'WebRTC receiver error');
    onState(Object.freeze({ ...state(), status: 'error', detail: message }));
  }
  function updateAudible() {
    const source = snapshot?.source;
    const output = snapshot?.output;
    const outputReady = output?.ready === true || output?.rendererReady === true;
    const sameDimensions = hasFrame && source?.width === previewCanvas.width && source?.height === previewCanvas.height;
    const authorized = snapshot?.mode === 'live' && outputReady
      && source?.kind === 'webrtc' && source.status === 'running'
      && source.sessionId === activeSessionId
      && localStatus.sessionId === activeSessionId && localStatus.status === 'running'
      && sameDimensions;
    receiver.setAudible(authorized);
  }
  function clearPreview({ clearChannel = false } = {}) {
    hasFrame = false;
    frozen = false;
    lastSize = null;
    previewCanvas.width = 1;
    previewCanvas.height = 1;
    previewContext.clearRect(0, 0, 1, 1);
    if (clearChannel) publisher.clear();
    onClearPreview();
    notify();
    updateAudible();
  }
  function setActiveSession(sessionId) {
    if (activeSessionId === sessionId) return;
    activeSessionId = sessionId;
    localStatus = { sessionId, status: 'preparing', width: 0, height: 0, detail: 'Creating a WebRTC answer.' };
    clearPreview({ clearChannel: true });
  }
  function handleStatus(value) {
    if (closed || !value || value.sessionId !== activeSessionId) return;
    const size = value.width > 0 && value.height > 0 ? `${value.width}x${value.height}` : null;
    if (size && lastSize && size !== lastSize) clearPreview({ clearChannel: true });
    if (size) lastSize = size;
    localStatus = { ...value };
    if (value.status !== 'running') clearPreview({ clearChannel: value.status !== 'preparing' });
    desktop.reportWebRTCStatus(value);
    notify();
    updateAudible();
  }
  function handleFrame(video) {
    if (closed || !activeSessionId) return;
    const { width, height } = dimensions(video);
    if (!width || !height) return;

    // Publish every decoded frame, even when the editor preview is frozen or hidden.
    try { publisher.publish(video, activeSessionId); }
    catch (error) { report(error); }

    const authoritativeSessionId = snapshot?.source?.sessionId;
    if (sourceKind !== 'webrtc' || (authoritativeSessionId && authoritativeSessionId !== activeSessionId)) return;
    const size = `${width}x${height}`;
    if (lastSize && size !== lastSize) clearPreview({ clearChannel: false });
    lastSize = size;
    if (!frozen) {
      if (previewCanvas.width !== width || previewCanvas.height !== height) {
        previewCanvas.width = width;
        previewCanvas.height = height;
      }
      try {
        previewContext.drawImage(video, 0, 0, width, height);
        hasFrame = true;
        onPreviewFrame(previewCanvas, { sessionId: activeSessionId, width, height, frozen: false });
      } catch (error) { report(error); }
    }
    notify();
    updateAudible();
  }

  const receiver = createReceiver({
    createVideoElement: () => videoElement,
    onStatus: handleStatus,
    onFrame: handleFrame,
  });
  const unsubscribeOffer = desktop.onWebRTCOffer(async ({ sessionId, offer } = {}) => {
    if (closed || typeof sessionId !== 'string' || !sessionId) return;
    setActiveSession(sessionId);
    receiver.setAudible(false);
    try {
      const answer = await receiver.acceptOffer(offer, sessionId);
      if (closed || activeSessionId !== sessionId) return;
      desktop.answerWebRTC({ sessionId, answer });
    } catch (error) {
      if (closed || activeSessionId !== sessionId) return;
      desktop.answerWebRTC({ sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  });
  const unsubscribeReset = desktop.onWebRTCReset(payload => {
    if (payload?.sessionId && activeSessionId && payload.sessionId !== activeSessionId) return;
    reset();
  });
  const readyPromise = Promise.resolve().then(() => desktop.sourceReady());

  function reset() {
    if (closed) return;
    receiver.setAudible(false);
    receiver.close();
    activeSessionId = null;
    localStatus = { sessionId: null, status: 'disconnected', width: 0, height: 0, detail: '' };
    sourceKind = snapshot?.source?.kind ?? 'reference';
    clearPreview({ clearChannel: true });
  }

  return Object.freeze({
    ready: () => readyPromise,
    updateSnapshot(value) {
      if (closed || !value || typeof value !== 'object') return;
      snapshot = value;
      const nextKind = value.source?.kind ?? 'reference';
      const nextSessionId = value.source?.sessionId ?? null;
      if (nextKind !== sourceKind) {
        sourceKind = nextKind;
        if (nextKind !== 'webrtc') reset();
        else clearPreview({ clearChannel: true });
      } else if (nextKind === 'webrtc' && activeSessionId && nextSessionId !== activeSessionId) {
        clearPreview({ clearChannel: true });
        if (!nextSessionId && value.source?.status === 'disconnected') reset();
      }
      updateAudible();
      notify();
    },
    setFrozen(value) {
      if (!hasFrame || localStatus.status !== 'running') return false;
      frozen = Boolean(value);
      notify();
      return true;
    },
    getPreviewCanvas: () => previewCanvas,
    getState: state,
    reset,
    close() {
      if (closed) return;
      closed = true;
      receiver.setAudible(false);
      receiver.close();
      unsubscribeOffer?.();
      unsubscribeReset?.();
      publisher.close();
      previewCanvas.width = 1;
      previewCanvas.height = 1;
      onClearPreview();
    },
  });
}

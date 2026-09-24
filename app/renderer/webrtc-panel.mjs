export function createWebRTCPanel(root, { desktop, run, getSnapshot }) {
  const $ = selector => root.querySelector(selector);
  const source = $('#source-kind');
  const status = $('#webrtc-panel-status');
  const offer = $('#webrtc-offer');
  const answer = $('#webrtc-answer');
  const connect = $('#webrtc-connect');
  const disconnect = $('#webrtc-disconnect');
  const signalingStart = $('#signaling-start');
  const signalingUrl = $('#signaling-url');
  const signalingCopy = $('#signaling-copy');
  const signalingStop = $('#signaling-stop');
  const whipUrl = $('#whip-url');
  const whipCopyUrl = $('#whip-copy-url');
  const whipCopyToken = $('#whip-copy-token');

  signalingStart.addEventListener('click', () => run(() => desktop.startSignaling()));
  signalingStop.addEventListener('click', () => run(() => desktop.stopSignaling()));
  signalingCopy.addEventListener('click', () => run(() => desktop.copySignalingUrl()));
  whipCopyUrl.addEventListener('click', () => run(() => desktop.copyWhipUrl()));
  whipCopyToken.addEventListener('click', () => run(() => desktop.copyWhipToken()));

  source.addEventListener('change', () => run(async () => {
    const snapshot = await desktop.selectSource(source.value);
    if (snapshot?.project) return snapshot;
  }));

  connect.addEventListener('click', () => run(async () => {
    let parsed;
    try { parsed = JSON.parse(offer.value); }
    catch { throw new Error('Offer must be a valid JSON object from the sender.'); }
    const received = await desktop.acceptWebRTCOffer(parsed);
    answer.value = JSON.stringify(received, null, 2);
  }));

  disconnect.addEventListener('click', () => run(async () => {
    answer.value = '';
    await desktop.selectSource('webrtc');
  }));

  function render(snapshot = getSnapshot()) {
    const current = snapshot?.source || { kind: 'reference', status: 'disconnected', detail: '' };
    source.value = current.kind;
    const stateLabel = current.status === 'running' ? 'Connected'
      : current.status === 'preparing' ? 'Creating answer'
        : current.status === 'stalled' ? 'Stream stalled'
          : current.status === 'error' ? 'Connection error' : 'Disconnected';
    const size = current.width && current.height ? ` · ${current.width} × ${current.height}` : '';
    const session = current.sessionId ? ` · session ${current.sessionId.slice(0, 8)}` : '';
    status.textContent = `${stateLabel}${size}${session}. ${current.detail || ''}`;
    const outputReady = Boolean(snapshot?.displayId && snapshot?.output?.rendererReady);
    connect.disabled = current.kind !== 'webrtc' || !outputReady;
    disconnect.disabled = current.kind !== 'webrtc' || current.status === 'disconnected';
    offer.disabled = current.kind !== 'webrtc';
    answer.readOnly = true;
    const signaling = snapshot?.signaling || { running: false, url: null };
    signalingStart.disabled = current.kind !== 'webrtc' || signaling.running;
    signalingStart.textContent = signaling.running ? 'Connection server running' : 'Start connection server';
    signalingUrl.value = signaling.url || '';
    signalingCopy.disabled = !signaling.running || !signaling.url;
    signalingStop.disabled = !signaling.running;
    whipUrl.value = signaling.whipUrl || '';
    whipCopyUrl.disabled = !signaling.running || !signaling.whipUrl;
    whipCopyToken.disabled = !signaling.running;
  }

  render();
  return Object.freeze({ render });
}

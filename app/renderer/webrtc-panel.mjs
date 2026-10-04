export function createWebRTCPanel(root, { desktop, run, getSnapshot, isReceiverReady = () => true }) {
  const $ = selector => root.querySelector(selector);
  const source = $('#source-kind');
  const referenceContent = $('#reference-source-content');
  const videoContent = $('#webrtc-panel');
  const status = $('#webrtc-panel-status');
  const offer = $('#webrtc-offer');
  const answer = $('#webrtc-answer');
  const connect = $('#webrtc-connect');
  const disconnect = $('#webrtc-disconnect');
  const signalingStart = $('#signaling-start');
  const signalingInterface = $('#signaling-interface');
  const signalingRequireToken = $('#signaling-require-token');
  const signalingAccessNote = $('#signaling-access-note');
  const signalingUrl = $('#signaling-url');
  const signalingCopy = $('#signaling-copy');
  const signalingStop = $('#signaling-stop');
  const senderStep = $('#sender-link-step');
  const whipUrl = $('#whip-url');
  const whipCopyUrl = $('#whip-copy-url');
  const whipCopyToken = $('#whip-copy-token');

  signalingStart.addEventListener('click', () => run(() => desktop.startSignaling(signalingInterface.value, signalingRequireToken.checked)));
  signalingInterface.addEventListener('change', () => render());
  signalingRequireToken.addEventListener('change', () => render());
  signalingStop.addEventListener('click', () => run(() => desktop.stopSignaling()));
  signalingCopy.addEventListener('click', () => run(() => desktop.copySignalingUrl()));
  whipCopyUrl.addEventListener('click', () => run(() => desktop.copyWhipUrl()));
  whipCopyToken.addEventListener('click', () => run(() => desktop.copyWhipToken()));

  source.addEventListener('change', async () => {
    const kind = source.value;
    referenceContent.hidden = kind === 'webrtc';
    videoContent.hidden = kind !== 'webrtc';
    await run(() => desktop.selectSource(kind));
    render(getSnapshot());
  });

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
    referenceContent.hidden = current.kind === 'webrtc';
    videoContent.hidden = current.kind !== 'webrtc';
    const stateLabel = current.status === 'running' ? 'Connected'
      : current.status === 'preparing' ? 'Creating answer'
        : current.status === 'stalled' ? 'Stream stalled'
          : current.status === 'error' ? 'Connection error' : 'Disconnected';
    const size = current.width && current.height ? ` · ${current.width} × ${current.height}` : '';
    status.textContent = `${stateLabel}${size}${current.detail ? `. ${current.detail}` : ''}`;
    connect.disabled = current.kind !== 'webrtc' || !isReceiverReady();
    disconnect.disabled = current.kind !== 'webrtc' || current.status === 'disconnected';
    offer.disabled = current.kind !== 'webrtc';
    answer.readOnly = true;
    const signaling = snapshot?.signaling || { running: false, url: null };
    const selectedHost = signalingInterface.value || '127.0.0.1';
    const choices = [{ address: '127.0.0.1', name: 'This computer' },
      ...(signaling.lanInterfaces || []).map(item => ({ address: item.address, name: `${item.name} · ${item.address} · local network` }))];
    signalingInterface.innerHTML = choices.map(item => `<option value="${item.address}">${item.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}</option>`).join('');
    signalingInterface.value = choices.some(item => item.address === selectedHost) ? selectedHost : '127.0.0.1';
    signalingInterface.disabled = signaling.running || current.kind !== 'webrtc';
    if (signaling.running) signalingRequireToken.checked = Boolean(signaling.requireToken);
    signalingRequireToken.disabled = signaling.running || current.kind !== 'webrtc';
    const tokenRequired = signaling.running ? Boolean(signaling.requireToken) : signalingRequireToken.checked;
    const onLan = signaling.running ? signaling.lan : signalingInterface.value !== '127.0.0.1';
    signalingAccessNote.textContent = onLan
      ? tokenRequired
        ? 'Advertised on the selected local network; token required for every connection.'
        : 'Advertised on the selected local network. Native clients on that network can connect without a token.'
      : tokenRequired
        ? 'This computer can connect with a token; token required for every connection. Other computers cannot reach the loopback address.'
        : 'This computer can connect without a token. Other computers cannot reach the loopback address.';
    signalingStart.disabled = current.kind !== 'webrtc' || signaling.running;
    signalingStart.textContent = signaling.running ? 'Receiving is ready' : 'Start receiving video';
    signalingUrl.value = signaling.url || '';
    senderStep.hidden = !signaling.running;
    signalingCopy.disabled = !signaling.running || !signaling.url;
    signalingStop.disabled = !signaling.running;
    whipUrl.value = signaling.whipUrl || '';
    whipCopyUrl.disabled = !signaling.running || !signaling.whipUrl;
    whipCopyToken.disabled = !signaling.running;
  }

  render();
  return Object.freeze({ render });
}

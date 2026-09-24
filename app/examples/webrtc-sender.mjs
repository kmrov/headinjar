const $ = (id) => document.getElementById(id);
const canvas = $('pattern');
const context = canvas.getContext('2d');
const offerField = $('offer');
const answerField = $('answer');
const startButton = $('start');
const connectButton = $('connect');
const stopButton = $('stop');
const status = $('status');
const ICE_TIMEOUT_MS = 12000;
const REQUEST_TIMEOUT_MS = 22000;
const DELETE_TIMEOUT_MS = 2000;

const token = new URLSearchParams(location.hash.slice(1)).get('token');
const automaticMode = location.protocol === 'http:' && Boolean(token);
if (token) history.replaceState(null, '', `${location.pathname}${location.search}`);

let peer = null;
let audioContext = null;
let oscillator = null;
let gain = null;
let videoTrack = null;
let audioTrack = null;
let animationFrame = 0;
let epoch = 0;
let stopped = true;
let activeRemoteSession = null;
// Keep session mutations in order: an old Stop DELETE must finish before a
// later Start POST can create its session.
let signalingQueue = Promise.resolve();

if (automaticMode) {
  $('intro').textContent = 'This link contains a short-lived connection key. Press Start to connect automatically. The moving video and generated audio are sent only to the receiver.';
  connectButton.hidden = true;
  $('offer-heading').hidden = true;
  $('answer-heading').hidden = true;
  offerField.hidden = true;
  answerField.hidden = true;
} else if (location.protocol !== 'file:') {
  $('intro').textContent = 'Open the connection link supplied by the receiver, or open this page as file:// to use manual SDP mode.';
}

function drawFrame(now) {
  if (stopped) return;
  const w = canvas.width;
  const h = canvas.height;
  const phase = now / 850;
  const gradient = context.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#092f58');
  gradient.addColorStop(1, '#55255f');
  context.fillStyle = gradient;
  context.fillRect(0, 0, w, h);
  context.fillStyle = '#fff';
  context.font = 'bold 34px system-ui';
  context.fillText('WEBRTC TEST', 28, 52);
  context.font = '20px ui-monospace, monospace';
  context.fillText(`frame ${Math.floor(now / 100)}`, 30, 88);
  const x = 90 + (Math.sin(phase) * 0.5 + 0.5) * (w - 180);
  const y = h * 0.58 + Math.sin(phase * 1.7) * 30;
  context.beginPath();
  context.arc(x, y, 38, 0, Math.PI * 2);
  context.fillStyle = '#45f0c4';
  context.fill();
  context.strokeStyle = '#fff';
  context.lineWidth = 4;
  context.stroke();
  animationFrame = requestAnimationFrame(drawFrame);
}

function waitForIceGathering(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('ICE gathering timed out. Try a local network or retry.')), ICE_TIMEOUT_MS);
    const onChange = () => {
      if (connection.iceGatheringState === 'complete') finish();
    };
    const finish = (error) => {
      clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', onChange);
      if (error) reject(error);
      else resolve();
    };
    connection.addEventListener('icegatheringstatechange', onChange);
  });
}

function requireDescription(value, type) {
  const description = JSON.parse(value);
  if (!description || description.type !== type || typeof description.sdp !== 'string' || !description.sdp.trim()) {
    throw new Error(`Expected a complete JSON ${type} description.`);
  }
  if (description.sdp.length > 256 * 1024) throw new Error('SDP exceeds the 256 KiB limit.');
  return description;
}

function enqueueSignaling(action) {
  const next = signalingQueue.then(action, action);
  signalingQueue = next.catch(() => {});
  return next;
}

async function requestWithDeadline(path, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, {...options, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'});
  } finally {
    clearTimeout(timeout);
  }
}

function authorizationHeaders() {
  return {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
}

function releaseLocal() {
  stopped = true;
  cancelAnimationFrame(animationFrame);
  peer?.close();
  peer = null;
  videoTrack?.stop();
  audioTrack?.stop();
  videoTrack = null;
  audioTrack = null;
  if (oscillator) {
    try { oscillator.stop(); } catch {}
    oscillator.disconnect();
    oscillator = null;
  }
  gain?.disconnect();
  gain = null;
  if (audioContext) void audioContext.close();
  audioContext = null;
  startButton.disabled = false;
  connectButton.disabled = true;
  stopButton.disabled = true;
}

function stopLocalAndReset() {
  ++epoch;
  releaseLocal();
}

async function performRemoteDelete(sessionId) {
  try {
    const response = await requestWithDeadline('/api/session', {
      method: 'DELETE', headers: {...authorizationHeaders(), 'X-Headinjar-Session': sessionId},
    }, DELETE_TIMEOUT_MS);
    if (!response.ok && response.status !== 404) throw new Error(`Receiver cleanup failed (HTTP ${response.status}).`);
  } catch {
    // Local tracks are already released. A later Start waits for this bounded
    // cleanup before posting its offer, so it cannot be cleared by this DELETE.
  }
}

function deleteRemoteSession() {
  if (!automaticMode || activeRemoteSession === null) return Promise.resolve();
  const ownedSession = activeRemoteSession;
  activeRemoteSession = null;
  return enqueueSignaling(() => performRemoteDelete(ownedSession.id));
}

async function createSender(currentEpoch) {
  stopped = false;
  drawFrame(performance.now());
  const stream = canvas.captureStream(15);
  videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('This browser does not support canvas.captureStream().');

  audioContext = new AudioContext();
  oscillator = audioContext.createOscillator();
  gain = audioContext.createGain();
  oscillator.frequency.value = 440;
  gain.gain.value = 0.012;
  const audioDestination = audioContext.createMediaStreamDestination();
  oscillator.connect(gain).connect(audioDestination);
  oscillator.start();
  audioTrack = audioDestination.stream.getAudioTracks()[0];

  const connection = new RTCPeerConnection({iceServers: []});
  peer = connection;
  connection.addTrack(videoTrack, stream);
  connection.addTrack(audioTrack, audioDestination.stream);
  connection.addEventListener('connectionstatechange', () => {
    if (epoch === currentEpoch && peer === connection) status.textContent = `Peer connection: ${connection.connectionState}.`;
  });
  startButton.disabled = true;
  stopButton.disabled = false;
  status.textContent = 'Gathering a complete ICE offer…';
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await waitForIceGathering(connection);
  if (epoch !== currentEpoch || peer !== connection) return;
  const localOffer = connection.localDescription;
  if (!localOffer || localOffer.sdp.length > 256 * 1024) throw new Error('SDP exceeds the 256 KiB limit.');

  if (automaticMode) {
    status.textContent = 'Sending offer to the receiver…';
    const requestSession = {epoch: currentEpoch, id: null};
    const response = await enqueueSignaling(async () => {
      const result = await requestWithDeadline('/api/offer', {
        method: 'POST', headers: authorizationHeaders(), body: JSON.stringify(localOffer),
      }, REQUEST_TIMEOUT_MS);
      if (result.ok) {
        const sessionId = result.headers.get('X-Headinjar-Session');
        if (!/^[a-f0-9]{32}$/.test(sessionId ?? '')) throw new Error('Receiver returned an invalid session id.');
        requestSession.id = sessionId;
        if (epoch !== currentEpoch || peer !== connection) {
          await performRemoteDelete(requestSession.id);
        } else {
          activeRemoteSession = requestSession;
        }
      }
      return result;
    });
    if (epoch !== currentEpoch || peer !== connection) return;
    if (!response.ok) {
      if (response.status === 409) throw new Error('Receiver is busy or not ready. Close the current connection or check its WebRTC source.');
      throw new Error(`Receiver rejected the offer (HTTP ${response.status}).`);
    }
    const answer = requireDescription(await response.text(), 'answer');
    if (epoch !== currentEpoch || peer !== connection) return;
    await connection.setRemoteDescription(answer);
    if (epoch !== currentEpoch || peer !== connection) return;
    status.textContent = 'Answer accepted; waiting for media connection…';
  } else {
    offerField.value = JSON.stringify(localOffer);
    connectButton.disabled = false;
    status.textContent = 'Offer ready. Paste it into the receiver, then paste the receiver answer here.';
  }
}

startButton.addEventListener('click', async () => {
  const currentEpoch = ++epoch;
  releaseLocal();
  offerField.value = '';
  answerField.value = '';
  try {
    if (automaticMode) await signalingQueue;
    if (epoch !== currentEpoch) return;
    await createSender(currentEpoch);
  } catch (error) {
    if (epoch !== currentEpoch) return;
    status.textContent = error?.message || String(error);
    stopLocalAndReset();
    await deleteRemoteSession();
  }
});

connectButton.addEventListener('click', async () => {
  if (!peer) return;
  const currentEpoch = epoch;
  const connection = peer;
  try {
    const answer = requireDescription(answerField.value, 'answer');
    await connection.setRemoteDescription(answer);
    if (epoch === currentEpoch && peer === connection) {
      connectButton.disabled = true;
      status.textContent = 'Answer accepted; waiting for media connection…';
    }
  } catch (error) {
    if (epoch === currentEpoch) status.textContent = error?.message || String(error);
  }
});

stopButton.addEventListener('click', async () => {
  stopLocalAndReset();
  status.textContent = 'Stopped and tracks released.';
  await deleteRemoteSession();
});

window.addEventListener('pagehide', () => {
  stopLocalAndReset();
  void deleteRemoteSession();
}, {once: true});

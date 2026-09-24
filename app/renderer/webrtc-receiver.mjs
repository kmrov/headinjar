const MAX_SDP_BYTES = 256 * 1024;
const OFFER_TIMEOUT_MS = 15_000;
const ICE_TIMEOUT_MS = 10_000;
const FRAME_TIMEOUT_MS = 10_000;

export function createWebRTCReceiver({
  onStatus = () => {}, onFrame = () => {},
  RTCPeerConnection = globalThis.RTCPeerConnection,
  MediaStream = globalThis.MediaStream,
  createVideoElement = () => document.createElement('video'),
  setTimeout: schedule = globalThis.setTimeout.bind(globalThis),
  clearTimeout: cancel = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  if (!RTCPeerConnection || !MediaStream) throw new Error('WebRTC is not available in this renderer.');
  const video = createVideoElement();
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  let active = null;
  let audible = false;

  function report(session, status, detail = '') {
    if (!session || active !== session || session.closed) return;
    const { videoWidth: width = 0, videoHeight: height = 0 } = video;
    const signature = `${status}:${width}:${height}:${detail}`;
    if (signature === session.lastStatusSignature) return;
    session.lastStatusSignature = signature;
    onStatus({ sessionId: session.id, status, width, height, detail });
  }
  function clearTimer(session, key) {
    if (session[key] !== null) cancel(session[key]);
    session[key] = null;
  }
  function clearFrameCallback(session) {
    if (session.frameCallback !== null && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(session.frameCallback);
    }
    session.frameCallback = null;
  }
  function removeListeners(session) {
    for (const [target, name, callback] of session.listeners) target.removeEventListener?.(name, callback);
    session.listeners.length = 0;
  }
  function cleanup(session, reason = new Error('WebRTC receiver closed.')) {
    if (!session || session.closed) return;
    session.closed = true;
    clearTimer(session, 'offerTimer'); clearTimer(session, 'startupTimer'); clearTimer(session, 'frameTimer'); clearTimer(session, 'iceTimer');
    clearTimer(session, 'fallbackTimer');
    clearFrameCallback(session); removeListeners(session);
    for (const receiver of session.pc.getReceivers?.() ?? []) receiver.track?.stop?.();
    video.pause?.(); video.srcObject = null;
    session.pc.close();
    if (session.rejectPending) { session.rejectPending(reason); session.rejectPending = null; }
    if (active === session) active = null;
  }
  function listen(session, target, name, callback) {
    target.addEventListener(name, callback);
    session.listeners.push([target, name, callback]);
  }
  function fail(session, error) {
    if (active !== session || session.closed) return;
    video.muted = true;
    report(session, 'error', error?.message || String(error));
    cleanup(session, error instanceof Error ? error : new Error(String(error)));
  }
  function armFrameWatch(session) {
    clearTimer(session, 'frameTimer');
    session.frameTimer = schedule(() => {
      if (active !== session || session.closed) return;
      video.muted = true;
      session.hasDecodedFrame = false;
      report(session, 'stalled', 'No decoded video frame received for 10 seconds.');
    }, FRAME_TIMEOUT_MS);
  }
  function startFrameCallbacks(session) {
    if (active !== session || session.closed || !session.hasVideoTrack) return;
    if (typeof video.requestVideoFrameCallback !== 'function') {
      fail(session, new Error('This Chromium build does not support decoded video frame callbacks.'));
      return;
    }
    const decoded = () => {
      session.frameCallback = null;
      if (active !== session || session.closed) return;
      session.hasDecodedFrame = true;
      clearTimer(session, 'offerTimer'); clearTimer(session, 'startupTimer');
      report(session, 'running');
      onFrame(video);
      armFrameWatch(session);
      session.frameCallback = video.requestVideoFrameCallback(decoded);
    };
    session.frameCallback = video.requestVideoFrameCallback(decoded);
  }
  function setAudible(value) {
    audible = Boolean(value);
    video.muted = !audible;
  }

  async function acceptOffer(offer, sessionId) {
    if (active) cleanup(active, new Error('WebRTC session replaced by a newer offer.'));
    if (!offer || offer.type !== 'offer' || typeof offer.sdp !== 'string' || !offer.sdp.trim()) {
      throw new TypeError('WebRTC offer must contain type "offer" and a non-empty SDP string.');
    }
    if (new TextEncoder().encode(offer.sdp).byteLength > MAX_SDP_BYTES) {
      const error = new RangeError('WebRTC offer SDP exceeds 256 KiB.');
      onStatus({ sessionId, status: 'error', width: 0, height: 0, detail: error.message });
      throw error;
    }
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('A WebRTC session ID is required.');
    if (!/^m=video\s/m.test(offer.sdp)) {
      const error = new Error('The offer must contain a video media section. Audio-only offers are not supported.');
      onStatus({ sessionId, status: 'error', width: 0, height: 0, detail: error.message });
      throw error;
    }
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const stream = new MediaStream();
    const session = { id: sessionId, pc, stream, closed: false, listeners: [], offerTimer: null, startupTimer: null, frameTimer: null, iceTimer: null, frameCallback: null,
      fallbackTimer: null, hasVideoTrack: false, hasAudioTrack: false, hasDecodedFrame: false, rejectPending: null, lastStatusSignature: null };
    active = session;
    report(session, 'preparing');
    const pending = new Promise((resolve, reject) => {
      session.rejectPending = reject;
      session.offerTimer = schedule(() => fail(session, new Error('WebRTC offer timed out after 15 seconds.')), OFFER_TIMEOUT_MS);
      const connectionChanged = () => {
        if (active !== session || session.closed) return;
        const state = pc.connectionState;
        if (state === 'connected' && session.answerReady && !session.hasDecodedFrame && session.startupTimer === null) {
          session.startupTimer = schedule(() => fail(session, new Error('No decoded video frame arrived within 15 seconds after connection.')), 15_000);
        }
        if (state === 'failed' || state === 'closed' || state === 'disconnected') {
          video.muted = true;
          report(session, 'disconnected', `Peer connection ${state}.`);
          cleanup(session, new Error(`WebRTC peer connection ${state}.`));
        }
      };
      listen(session, pc, 'connectionstatechange', connectionChanged);
      listen(session, pc, 'track', event => {
        if (active !== session || session.closed) return;
        const track = event.track;
        if (track.kind !== 'video' && track.kind !== 'audio') return;
        if ((track.kind === 'video' && session.hasVideoTrack) || (track.kind === 'audio' && session.hasAudioTrack)) {
          fail(session, new Error(`Only one ${track.kind} track is supported.`));
          return;
        }
        if (track.kind === 'video') session.hasVideoTrack = true;
        else session.hasAudioTrack = true;
        try { session.stream.addTrack(track); } catch (error) { fail(session, error); return; }
        if (video.srcObject !== session.stream) video.srcObject = session.stream;
        if (track.kind === 'video') {
          listen(session, track, 'mute', () => {
            video.muted = true;
            session.hasDecodedFrame = false;
            clearTimer(session, 'frameTimer');
            report(session, 'stalled', 'Video track muted.');
          });
          listen(session, track, 'ended', () => { video.muted = true; report(session, 'disconnected', 'Video track ended.'); cleanup(session, new Error('WebRTC video track ended.')); });
          Promise.resolve(video.play()).then(() => startFrameCallbacks(session), error => fail(session, new Error(`Video playback failed: ${error?.message || error}`)));
        }
      });
      (async () => {
        try {
          await pc.setRemoteDescription(offer);
          if (active !== session || session.closed) return;
          for (const transceiver of pc.getTransceivers?.() ?? []) transceiver.direction = 'recvonly';
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (active !== session || session.closed) return;
          if (pc.iceGatheringState !== 'complete') {
            await new Promise((done, reject) => {
              const gathering = () => { if (pc.iceGatheringState === 'complete') { clearTimer(session, 'iceTimer'); pc.removeEventListener('icegatheringstatechange', gathering); done(); } };
              listen(session, pc, 'icegatheringstatechange', gathering);
              session.iceTimer = schedule(() => { pc.removeEventListener('icegatheringstatechange', gathering); reject(new Error('ICE gathering timed out.')); }, ICE_TIMEOUT_MS);
              gathering();
            });
          }
          if (active !== session || session.closed) return;
          const result = { type: 'answer', sdp: pc.localDescription.sdp };
          clearTimer(session, 'offerTimer');
          session.answerReady = true;
          if (pc.connectionState === 'connected' && !session.hasDecodedFrame) {
            session.startupTimer = schedule(() => fail(session, new Error('No decoded video frame arrived within 15 seconds after connection.')), 15_000);
          }
          session.rejectPending = null;
          resolve(result);
        } catch (error) { fail(session, error); reject(error); }
      })();
    });
    return pending;
  }

  return { video, acceptOffer, setAudible, close() { setAudible(false); if (active) cleanup(active); else { video.pause?.(); video.srcObject = null; } } };
}

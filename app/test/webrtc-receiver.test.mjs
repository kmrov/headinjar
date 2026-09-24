import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebRTCReceiver } from '../renderer/webrtc-receiver.mjs';

function makeHarness({ tracks = [{ kind: 'video' }], gatherState = 'complete', play = async () => {} } = {}) {
  const handlers = new Map();
  const frameCallbacks = new Map();
  let nextFrameId = 1;
  let video;
  const statuses = [];
  const frames = [];
  const pcs = [];
  class FakeTrack {
    constructor(kind) { this.kind = kind; this.readyState = 'live'; this.muted = false; this.listeners = new Map(); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    stop() { this.readyState = 'ended'; }
  }
  class FakePeerConnection {
    constructor(configuration) {
      this.configuration = configuration;
      this.connectionState = 'new'; this.iceGatheringState = gatherState; this.listeners = new Map(); this.remoteTracks = tracks.map(t => new FakeTrack(t.kind));
      this.transceivers = []; pcs.push(this);
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    async setRemoteDescription(value) {
      this.remoteDescription = value;
      this.transceivers = [...value.sdp.matchAll(/^m=(video|audio) /gm)].map(([, kind]) => ({ kind, direction: 'sendrecv' }));
    }
    async createAnswer() {
      this.answerTransceiverDirections = this.transceivers.map(transceiver => transceiver.direction);
      return { type: 'answer', sdp: 'answer' };
    }
    async setLocalDescription(value) { this.localDescription = value; }
    getReceivers() { return this.remoteTracks.map(track => ({ track })); }
    getTransceivers() { return this.transceivers; }
    getSenders() { return []; }
    close() { this.closed = true; }
    fire(name, event = {}) { this.listeners.get(name)?.(event); }
  }
  class FakeMediaStream { constructor(streamTracks = []) { this.tracks = streamTracks; } getTracks() { return this.tracks; } addTrack(track) { this.tracks.push(track); } }
  const receiver = createWebRTCReceiver({
    onStatus: value => statuses.push(value), onFrame: video => frames.push(video),
    RTCPeerConnection: FakePeerConnection, MediaStream: FakeMediaStream,
    createVideoElement: () => (video = { srcObject: null, muted: true, playsInline: true, readyState: 0, videoWidth: 0, videoHeight: 0, play, pause() {}, requestVideoFrameCallback(callback) { const id = nextFrameId++; frameCallbacks.set(id, callback); return id; }, cancelVideoFrameCallback(id) { frameCallbacks.delete(id); } }),
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; handlers.set(timer, timer); return timer; },
    clearTimeout: timer => { timer.cleared = true; },
  });
  return { receiver, statuses, frames, pcs, handlers, frameCallbacks, get video() { return video; } };
}

test('valid offer yields non-trickle answer and rejects audio-only remote streams', async () => {
  const h = makeHarness();
  const answer = await h.receiver.acceptOffer({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }, 'session-1');
  assert.deepEqual(answer, { type: 'answer', sdp: 'answer' });
  assert.equal(h.pcs[0].remoteDescription.type, 'offer');
  assert.equal(h.pcs[0].configuration.bundlePolicy, 'max-bundle');
  assert.deepEqual(h.pcs[0].answerTransceiverDirections, ['recvonly']);
  assert.equal(h.statuses.at(-1).status, 'preparing');

  const audioOnly = makeHarness({ tracks: [{ kind: 'audio' }] });
  await assert.rejects(audioOnly.receiver.acceptOffer({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }, 'session-2'), /video/i);
});

test('all offered media sections are receive-only before creating the answer', async () => {
  const h = makeHarness();
  await h.receiver.acceptOffer({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }, 'session-av');
  assert.deepEqual(h.pcs[0].answerTransceiverDirections, ['recvonly', 'recvonly']);
});

test('replacing a pending offer closes old connection and ignores old callbacks', async () => {
  const h = makeHarness();
  h.pcs.length = 0;
  const first = h.receiver.acceptOffer({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }, 'one');
  await Promise.resolve();
  const old = h.pcs[0];
  const second = h.receiver.acceptOffer({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }, 'two');
  await assert.rejects(first, /replaced|closed|stale/i);
  await second;
  old.fire('connectionstatechange');
  assert.ok(h.statuses.every(value => value.sessionId !== 'one' || value.status === 'preparing'));
  assert.equal(old.closed, true);
});

test('close while accepting settles the promise and releases the connection', async () => {
  const h = makeHarness();
  const pending = h.receiver.acceptOffer({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }, 'session');
  await Promise.resolve();
  h.receiver.close();
  await assert.rejects(pending, /closed|cancel/i);
  assert.equal(h.pcs[0].closed, true);
});


test('running starts only after the browser reports a decoded frame', async () => {
  const h = makeHarness();
  await h.receiver.acceptOffer({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }, 'session');
  h.pcs[0].fire('track', { track: h.pcs[0].remoteTracks[0], streams: [] });
  await Promise.resolve();
  assert.deepEqual(h.statuses.map(value => value.status), ['preparing']);
  assert.equal(h.frames.length, 0);
  h.video.videoWidth = 640; h.video.videoHeight = 360; h.video.readyState = 2;
  const [callback] = h.frameCallbacks.values();
  callback(0, { width: 640, height: 360 });
  assert.equal(h.statuses.at(-1).status, 'running');
  const [nextCallback] = h.frameCallbacks.values();
  nextCallback(16, { width: 640, height: 360 });
  assert.equal(h.statuses.filter(value => value.status === 'running').length, 1);
  assert.equal(h.frames.length, 2);
  assert.equal(h.frames[0], h.video);
  h.receiver.close();
  assert.equal(h.pcs[0].remoteTracks[0].readyState, 'ended');
});

test('decoded-frame timeout mutes locally and a later decoded frame reports recovery', async () => {
  const h = makeHarness();
  await h.receiver.acceptOffer({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }, 'session');
  h.pcs[0].fire('track', { track: h.pcs[0].remoteTracks[0], streams: [] });
  await Promise.resolve();
  h.video.videoWidth = 640; h.video.videoHeight = 360; h.video.readyState = 2;
  const [firstFrame] = h.frameCallbacks.values();
  firstFrame(0, { width: 640, height: 360 });
  h.receiver.setAudible(true);
  const frameTimer = [...h.handlers.values()].find(timer => timer.ms === 10_000 && !timer.cleared);
  assert.ok(frameTimer);
  frameTimer.fn();
  assert.equal(h.video.muted, true);
  assert.equal(h.statuses.at(-1).status, 'stalled');
  const [, recoveryFrame] = [...h.frameCallbacks.values()];
  recoveryFrame(5000, { width: 640, height: 360 });
  assert.equal(h.statuses.at(-1).status, 'running');
  assert.equal(h.frames.length, 2);
  h.receiver.close();
});

test('oversized signaling input is rejected before a peer connection is created', async () => {
  const h = makeHarness();
  await assert.rejects(h.receiver.acceptOffer({ type: 'offer', sdp: 'x'.repeat(256 * 1024 + 1) }, 'large'), /256 KiB/);
  assert.equal(h.pcs.length, 0);
  assert.equal(h.statuses.at(-1).status, 'error');
});

test('incomplete ICE gathering has a finite timeout and closes the peer', async () => {
  const h = makeHarness({ gatherState: 'gathering' });
  const pending = h.receiver.acceptOffer({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }, 'session');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const iceTimer = [...h.handlers.values()].find(timer => timer.ms === 10_000 && !timer.cleared);
  assert.ok(iceTimer);
  iceTimer.fn();
  await assert.rejects(pending, /ICE gathering timed out/);
  assert.equal(h.pcs[0].closed, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebRTCSessionController, MAX_SDP_LENGTH } from '../electron/webrtc-session.mjs';

function harness(options = {}) {
  const offers = [];
  const resets = [];
  const statuses = [];
  const controller = createWebRTCSessionController({
    sendOffer: value => offers.push(value), sendReset: value => resets.push(value), onStatus: value => statuses.push(value),
    ...options,
  });
  return { controller, offers, resets, statuses };
}

test('rejects malformed and oversized offers before sending them', async () => {
  const { controller, offers } = harness();
  controller.selectSource('webrtc');
  assert.throws(() => controller.acceptOffer({ type: 'answer', sdp: 'v=0' }), /Invalid WebRTC offer/);
  assert.throws(() => controller.acceptOffer({ type: 'offer', sdp: 'x'.repeat(MAX_SDP_LENGTH + 1) }), /Invalid WebRTC offer/);
  assert.equal(offers.length, 0);
});

test('routes only the active session answer and ignores stale health', async () => {
  const { controller, offers } = harness({ createSessionId: (() => { let i = 0; return () => `session-${++i}`; })() });
  controller.selectSource('webrtc');
  const first = controller.acceptOffer({ type: 'offer', sdp: 'v=0\r\n' });
  const second = controller.acceptOffer({ type: 'offer', sdp: 'v=0\r\n' });
  await assert.rejects(first, /newer offer/);
  assert.equal(controller.receiveAnswer({ sessionId: offers[0].sessionId, answer: { type: 'answer', sdp: 'v=0' } }), false);
  assert.equal(controller.receiveStatus({ sessionId: offers[0].sessionId, status: 'running', width: 10, height: 10, detail: '' }), false);
  assert.equal(controller.receiveAnswer({ sessionId: offers[1].sessionId, answer: { type: 'answer', sdp: 'v=0' } }), true);
  assert.deepEqual(await second, { type: 'answer', sdp: 'v=0' });
});

test('reset rejects a pending offer, resets output and clears session health', async () => {
  const { controller, offers, resets } = harness();
  controller.selectSource('webrtc');
  const pending = controller.acceptOffer({ type: 'offer', sdp: 'v=0' });
  controller.reset('Manually disconnected');
  await assert.rejects(pending, /Manually disconnected/);
  assert.deepEqual(resets, [{ sessionId: offers[0].sessionId }]);
  assert.deepEqual(controller.snapshot(), {
    kind: 'webrtc', status: 'disconnected', connected: false, detail: 'Manually disconnected',
    sessionId: null, width: 0, height: 0,
  });
});

test('offer timeout resets receiver and drops its session id', async () => {
  let expire;
  const { controller, offers, resets } = harness({ timeoutMs: 15, setTimeoutFn: fn => { expire = fn; return 1; }, clearTimeoutFn: () => {} });
  controller.selectSource('webrtc');
  const pending = controller.acceptOffer({ type: 'offer', sdp: 'v=0' });
  expire();
  await assert.rejects(pending, /timed out/);
  assert.deepEqual(resets, [{ sessionId: offers[0].sessionId }]);
  assert.equal(controller.snapshot().sessionId, null);
  assert.equal(controller.snapshot().connected, false);
});

test('input dimension change preserves the session and reports fresh dimensions', () => {
  const dimensions = [];
  const { controller, offers, resets } = harness({ onDimensionsChanged: source => dimensions.push(source) });
  controller.selectSource('webrtc');
  const pending = controller.acceptOffer({ type: 'offer', sdp: 'v=0' });
  controller.receiveAnswer({ sessionId: offers[0].sessionId, answer: { type: 'answer', sdp: 'v=0' } });
  void pending;
  const size = (status, width, height) => controller.receiveStatus({ sessionId: offers[0].sessionId, status, width, height, detail: '' });
  assert.equal(size('running', 640, 480), true);
  assert.equal(size('running', 1280, 720), true);
  assert.equal(controller.snapshot().sessionId, offers[0].sessionId);
  assert.equal(controller.snapshot().status, 'running');
  assert.equal(controller.snapshot().width, 1280);
  assert.equal(resets.length, 0);
  assert.equal(dimensions.length, 1);
});

test('rejects running health without dimensions without mutating the preparing session', async () => {
  const { controller, offers } = harness();
  controller.selectSource('webrtc');
  const pending = controller.acceptOffer({ type: 'offer', sdp: 'v=0' });
  const sessionId = offers[0].sessionId;
  assert.throws(() => controller.receiveStatus({ sessionId, status: 'running', width: 0, height: 0, detail: 'Receiving video' }), /positive video dimensions/);
  assert.deepEqual(controller.snapshot(), {
    kind: 'webrtc', status: 'preparing', connected: false,
    detail: 'Creating answer; ICE gathering may take a few seconds.', sessionId, width: 0, height: 0,
  });
  controller.receiveAnswer({ sessionId, answer: { type: 'answer', sdp: 'v=0' } });
  await pending;
});

test('output-reported errors reject the matching pending offer and reset receiver', async () => {
  const { controller, offers, resets } = harness();
  controller.selectSource('webrtc');
  const pending = controller.acceptOffer({ type: 'offer', sdp: 'v=0' });
  assert.equal(controller.receiveAnswer({ sessionId: offers[0].sessionId, error: 'Offer rejected: no video track.' }), true);
  await assert.rejects(pending, /no video track/);
  assert.deepEqual(resets, [{ sessionId: offers[0].sessionId }]);
  assert.equal(controller.snapshot().sessionId, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorWebRTCSource } from '../renderer/editor-webrtc-source.mjs';

function harness() {
  let receiverCallbacks;
  let offerListener;
  let resetListener;
  let readyCallCount = 0;
  const reports = [];
  const answers = [];
  const published = [];
  const cleared = [];
  const previewFrames = [];
  const states = [];
  const audible = [];
  const canvas = {
    width: 0, height: 0,
    getContext() { return { clearRect() {}, drawImage: (...args) => previewFrames.push(args) }; },
  };
  const receiver = {
    setAudible: value => audible.push(value),
    acceptOffer: async offer => ({ type: 'answer', sdp: `answer:${offer.sdp}` }),
    close() {},
  };
  const desktop = {
    onWebRTCOffer(callback) { offerListener = callback; return () => {}; },
    onWebRTCReset(callback) { resetListener = callback; return () => {}; },
    sourceReady() {
      assert.equal(typeof offerListener, 'function');
      assert.equal(typeof resetListener, 'function');
      readyCallCount += 1;
    },
    answerWebRTC: value => answers.push(value),
    reportWebRTCStatus: value => reports.push(value),
  };
  const source = createEditorWebRTCSource({
    desktop,
    mediaChannel: 'media-test',
    createCanvas: () => canvas,
    createReceiver: options => { receiverCallbacks = options; return receiver; },
    createPublisher: options => ({
      options,
      publish: (frame, sessionId) => published.push({ frame, sessionId }),
      clear: () => cleared.push(true),
      close() {},
    }),
    onPreviewFrame: (frame, metadata) => previewFrames.push({ frame, metadata }),
    onClearPreview: () => cleared.push('preview'),
    onState: state => states.push(state),
  });
  return { source, canvas, desktop, receiverCallbacks: () => receiverCallbacks, offer: () => offerListener, reset: () => resetListener,
    readyCalls: () => readyCallCount, reports, answers, published, cleared, previewFrames, states, audible };
}

const liveSnapshot = (overrides = {}) => ({
  mode: 'live', output: { ready: true },
  source: { kind: 'webrtc', status: 'running', sessionId: 'session-one', width: 10, height: 5 },
  ...overrides,
});

test('sourceReady runs only after offer and reset handlers are installed', async () => {
  const h = harness();
  await h.source.ready();
  assert.equal(h.readyCalls(), 1);
  h.source.close();
});

test('decoded frames publish while frozen and output audio is gated by authoritative snapshot state', async () => {
  const h = harness();
  await h.source.ready();
  h.source.updateSnapshot({ source: { kind: 'webrtc', status: 'preparing', sessionId: 'session-one' }, mode: 'black', output: { ready: true } });
  await h.offer()({ sessionId: 'session-one', offer: { type: 'offer', sdp: 'test' } });
  assert.deepEqual(h.answers, [{ sessionId: 'session-one', answer: { type: 'answer', sdp: 'answer:test' } }]);
  h.receiverCallbacks().onStatus({ sessionId: 'session-one', status: 'running', width: 10, height: 5, detail: '' });
  h.source.updateSnapshot(liveSnapshot());
  const video = { videoWidth: 10, videoHeight: 5 };
  h.receiverCallbacks().onFrame(video);
  assert.equal(h.published.length, 1);
  assert.equal(h.previewFrames.filter(frame => frame?.metadata).length, 1);
  assert.equal(h.audible.at(-1), true);

  assert.equal(h.source.setFrozen(true), true);
  h.receiverCallbacks().onFrame(video);
  assert.equal(h.published.length, 2);
  assert.equal(h.previewFrames.filter(frame => frame?.metadata).length, 1);
  h.source.updateSnapshot({ ...liveSnapshot(), mode: 'black' });
  assert.equal(h.audible.at(-1), false);
  h.receiverCallbacks().onFrame(video);
  assert.equal(h.published.length, 3);
  assert.equal(h.previewFrames.filter(frame => frame?.metadata).length, 1);
  h.source.close();
});

test('ImageBitmap-style displayWidth/height frames are published and copied into the preview', async () => {
  const h = harness();
  await h.source.ready();
  h.source.updateSnapshot({ source: { kind: 'webrtc', status: 'preparing', sessionId: 'session-one' }, mode: 'black', output: { ready: false } });
  await h.offer()({ sessionId: 'session-one', offer: { type: 'offer', sdp: 'test' } });
  h.receiverCallbacks().onStatus({ sessionId: 'session-one', status: 'running', width: 16, height: 9, detail: '' });
  h.source.updateSnapshot({ source: { kind: 'webrtc', status: 'running', sessionId: 'session-one', width: 16, height: 9 }, mode: 'black', output: { ready: false } });
  const bitmap = { displayWidth: 16, displayHeight: 9 };
  h.receiverCallbacks().onFrame(bitmap);
  assert.equal(h.published[0].frame, bitmap);
  assert.deepEqual(h.previewFrames.find(frame => frame?.metadata)?.metadata, { sessionId: 'session-one', width: 16, height: 9, frozen: false });
  h.source.close();
});

test('dimension changes clear frozen frames and require matching dimensions before audio resumes', async () => {
  const h = harness();
  await h.source.ready();
  h.source.updateSnapshot({ source: { kind: 'webrtc', status: 'preparing', sessionId: 'session-one' }, mode: 'black', output: { ready: true } });
  await h.offer()({ sessionId: 'session-one', offer: { type: 'offer', sdp: 'test' } });
  h.receiverCallbacks().onStatus({ sessionId: 'session-one', status: 'running', width: 10, height: 5, detail: '' });
  h.source.updateSnapshot(liveSnapshot());
  h.receiverCallbacks().onFrame({ videoWidth: 10, videoHeight: 5 });
  h.source.setFrozen(true);
  h.receiverCallbacks().onStatus({ sessionId: 'session-one', status: 'running', width: 20, height: 10, detail: 'Resize' });
  assert.equal(h.source.getState().hasFrame, false);
  assert.equal(h.source.getState().frozen, false);
  assert.equal(h.audible.at(-1), false);
  h.source.updateSnapshot(liveSnapshot({ source: { kind: 'webrtc', status: 'running', sessionId: 'session-one', width: 20, height: 10 } }));
  h.receiverCallbacks().onFrame({ videoWidth: 20, videoHeight: 10 });
  assert.equal(h.source.getState().hasFrame, true);
  assert.equal(h.audible.at(-1), true);
  h.source.close();
});

test('reset and source switch clear stale preview frames without coupling to Output lifecycle', async () => {
  const h = harness();
  await h.source.ready();
  h.source.updateSnapshot({ source: { kind: 'webrtc', status: 'preparing', sessionId: 'session-one' }, mode: 'black', output: { ready: true } });
  await h.offer()({ sessionId: 'session-one', offer: { type: 'offer', sdp: 'test' } });
  h.receiverCallbacks().onStatus({ sessionId: 'session-one', status: 'running', width: 10, height: 5, detail: '' });
  h.receiverCallbacks().onFrame({ videoWidth: 10, videoHeight: 5 });
  h.source.setFrozen(true);
  h.source.updateSnapshot({ source: { kind: 'webrtc', status: 'running', sessionId: 'session-one', width: 10, height: 5 }, mode: 'black', output: { ready: false } });
  assert.equal(h.source.getState().hasFrame, true);
  assert.equal(h.source.getState().frozen, true);
  h.reset()({ sessionId: 'session-one' });
  assert.equal(h.source.getState().hasFrame, false);
  assert.equal(h.source.getState().sessionId, null);
  h.source.updateSnapshot({ source: { kind: 'reference', status: 'running' }, mode: 'black', output: { ready: false } });
  assert.equal(h.source.getState().hasFrame, false);
  h.source.close();
});

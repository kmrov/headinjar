import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameConsumer, createFramePublisher } from '../renderer/media-frame-channel.mjs';

function channelHarness() {
  const channels = new Map();
  const receivedBitmaps = [];
  class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      const peers = channels.get(name) ?? new Set();
      peers.add(this);
      channels.set(name, peers);
    }
    postMessage(data) {
      const message = data?.type === 'frame' ? { ...data, bitmap: bitmap() } : data;
      if (data?.type === 'frame') receivedBitmaps.push(message.bitmap);
      for (const peer of channels.get(this.name) ?? []) {
        if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data: message }));
      }
    }
    close() { channels.get(this.name)?.delete(this); }
  }
  return { BroadcastChannel: FakeBroadcastChannel, receivedBitmaps };
}

function bitmap() {
  return { width: 16, height: 16, closes: 0, close() { this.closes += 1; } };
}

test('publisher creates at most one requested bitmap and consumer closes it after sync delivery', async () => {
  const deps = channelHarness();
  const created = [];
  const video = { videoWidth: 16, videoHeight: 16 };
  const publisher = createFramePublisher({ channelName: 'bounded', ...deps, createImageBitmap: async () => {
    const frame = bitmap(); created.push(frame); return frame;
  } });
  const frames = [];
  const consumer = createFrameConsumer({ channelName: 'bounded', ...deps, pollIntervalMs: 2, requestTimeoutMs: 100,
    onFrame: (frame, metadata) => frames.push({ frame, metadata }) });
  publisher.publish(video, 'session-a');
  consumer.setSource('session-a');
  consumer.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(created.length >= 1);
  assert.equal(frames.length, created.length);
  assert.deepEqual(frames[0].metadata, { sessionId: 'session-a', width: 16, height: 16 });
  assert.ok(created.every(frame => frame.closes === 1), 'publisher releases each original bitmap after postMessage');
  assert.ok(deps.receivedBitmaps.every(frame => frame.closes === 1), 'consumer releases its distinct received bitmap');
  consumer.close(); publisher.close();
});

test('session changes discard and close a bitmap created for the stale session', async () => {
  const deps = channelHarness();
  let resolveBitmap;
  const staleBitmap = bitmap();
  const publisher = createFramePublisher({ channelName: 'stale', ...deps, createImageBitmap: () => new Promise(resolve => { resolveBitmap = resolve; }) });
  const frames = [];
  const consumer = createFrameConsumer({ channelName: 'stale', ...deps, pollIntervalMs: 100, requestTimeoutMs: 100,
    onFrame: frame => frames.push(frame) });
  publisher.publish({ videoWidth: 16, videoHeight: 16 }, 'session-a');
  consumer.setSource('session-a'); consumer.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(typeof resolveBitmap, 'function');
  consumer.setSource('session-b');
  resolveBitmap(staleBitmap);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(staleBitmap.closes, 1);
  assert.deepEqual(frames, []);
  consumer.close(); publisher.close();
});

test('publisher clear closes a late bitmap instead of sending a stale frame', async () => {
  const deps = channelHarness();
  let resolveBitmap;
  const lateBitmap = bitmap();
  const publisher = createFramePublisher({ channelName: 'clear', ...deps, createImageBitmap: () => new Promise(resolve => { resolveBitmap = resolve; }) });
  const frames = [];
  const consumer = createFrameConsumer({ channelName: 'clear', ...deps, pollIntervalMs: 100, requestTimeoutMs: 100,
    onFrame: frame => frames.push(frame) });
  publisher.publish({ videoWidth: 16, videoHeight: 16 }, 'session-a');
  consumer.setSource('session-a'); consumer.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  publisher.clear();
  resolveBitmap(lateBitmap);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(lateBitmap.closes, 1);
  assert.deepEqual(frames, []);
  consumer.close(); publisher.close();
});

test('only one bitmap creation can be in flight while an output pull is pending', async () => {
  const deps = channelHarness();
  let calls = 0;
  let inFlight = 0;
  let maximumInFlight = 0;
  const resolvers = [];
  const publisher = createFramePublisher({ channelName: 'one-in-flight', ...deps, createImageBitmap: () => {
    calls += 1;
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    return new Promise(resolve => resolvers.push(frame => {
      const close = frame.close.bind(frame);
      frame.close = () => { inFlight -= 1; close(); };
      resolve(frame);
    }));
  } });
  const consumer = createFrameConsumer({ channelName: 'one-in-flight', ...deps, pollIntervalMs: 2, requestTimeoutMs: 100,
    onFrame: () => {} });
  publisher.publish({ videoWidth: 16, videoHeight: 16 }, 'session-a');
  consumer.setSource('session-a'); consumer.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  resolvers[0](bitmap());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal(maximumInFlight, 1);
  consumer.setEnabled(false);
  resolvers[1](bitmap());
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(maximumInFlight, 1);
  consumer.close(); publisher.close();
});

test('disabled consumers do not pull frames; callbacks throwing still release received bitmap', async () => {
  const deps = channelHarness();
  const created = [];
  const publisher = createFramePublisher({ channelName: 'release', ...deps, createImageBitmap: async () => {
    const frame = bitmap(); created.push(frame); return frame;
  } });
  const errors = [];
  const consumer = createFrameConsumer({ channelName: 'release', ...deps, onFrame: () => { throw new Error('paint failed'); }, onError: error => errors.push(error) });
  publisher.publish({ videoWidth: 16, videoHeight: 16 }, 'session-a');
  consumer.setSource('session-a');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(created.length, 0);
  consumer.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(created.length >= 1);
  assert.ok(created.every(frame => frame.closes === 1));
  assert.equal(errors[0]?.message, 'paint failed');
  consumer.setEnabled(false); consumer.close(); publisher.close();
});

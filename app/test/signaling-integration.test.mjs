import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignalingOfferGate } from '../electron/signaling-integration.mjs';

function mockSession() {
  let state = { status: 'disconnected', sessionId: null };
  let resolveOffer;
  let rejectOffer;
  const session = {
    snapshot: () => ({ ...state }),
    acceptOffer: () => {
      state = { status: 'preparing', sessionId: 'session-1' };
      return new Promise((resolve, reject) => {
        rejectOffer = reject;
        resolveOffer = answer => { rejectOffer = null; state = { status: 'running', sessionId: 'session-1' }; resolve(answer); };
      });
    },
    reset: () => { state = { status: 'disconnected', sessionId: null }; rejectOffer?.(new Error('reset')); rejectOffer = null; },
    finish: answer => resolveOffer(answer),
    replace: () => { state = { status: 'preparing', sessionId: 'session-2' }; rejectOffer?.(new Error('replaced')); rejectOffer = null; },
  };
  return session;
}

test('offer gate rejects unready and competing manual or HTTP offers', async () => {
  const session = mockSession();
  let ready = false;
  const gate = createSignalingOfferGate({ session, isReady: () => ready });
  assert.throws(() => gate.acceptOffer({ type: 'offer', sdp: 'sdp' }), error => error.statusCode === 409);
  assert.equal(gate.isBusy(), false);

  ready = true;
  const pending = gate.acceptOffer({ type: 'offer', sdp: 'sdp' });
  assert.equal(gate.isBusy(), true);
  assert.throws(() => gate.acceptOffer({ type: 'offer', sdp: 'other' }), error => error.statusCode === 409);
  session.finish({ type: 'answer', sdp: 'answer' });
  assert.deepEqual(await pending, { type: 'answer', sdp: 'answer' });
  assert.equal(gate.isBusy(), true, 'the established peer remains busy after answer delivery');
});

test('aborting an admitted HTTP offer resets only its owned session', async () => {
  const session = mockSession();
  const gate = createSignalingOfferGate({ session, isReady: () => true });
  const controller = new AbortController();
  const pending = gate.acceptOffer({ type: 'offer', sdp: 'sdp' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(session.snapshot().status, 'disconnected');
  await new Promise(resolve => setImmediate(resolve));

  const secondController = new AbortController();
  const second = gate.acceptOffer({ type: 'offer', sdp: 'sdp' }, { signal: secondController.signal });
  session.replace();
  secondController.abort();
  await assert.rejects(second);
  assert.deepEqual(session.snapshot(), { status: 'preparing', sessionId: 'session-2' });
});

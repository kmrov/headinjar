import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebRTCPanel } from '../renderer/webrtc-panel.mjs';

function makeElement() {
  const listeners = new Map();
  return {
    hidden: false, disabled: false, checked: false, value: '', textContent: '', readOnly: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type) { return listeners.get(type)?.(); },
  };
}

test('source choice shows the matching media controls and switches the project source', async () => {
  const ids = ['source-kind', 'reference-source-content', 'webrtc-panel', 'webrtc-panel-status',
    'webrtc-offer', 'webrtc-answer', 'webrtc-connect', 'webrtc-disconnect', 'signaling-start',
    'signaling-interface', 'signaling-require-token', 'signaling-access-note', 'signaling-url', 'signaling-copy', 'signaling-stop', 'sender-link-step', 'whip-url', 'whip-copy-url', 'whip-copy-token'];
  const elements = Object.fromEntries(ids.map(id => [id, makeElement()]));
  const root = { querySelector: selector => elements[selector.slice(1)] };
  let snapshot = { source: { kind: 'reference', status: 'running' }, signaling: { running: false } };
  const choices = [];
  const panel = createWebRTCPanel(root, {
    desktop: { selectSource: async kind => {
      choices.push(kind);
      snapshot = { ...snapshot, source: { kind, status: 'disconnected' } };
      return snapshot;
    } },
    run: action => action(),
    getSnapshot: () => snapshot,
  });

  assert.equal(elements['reference-source-content'].hidden, false);
  assert.equal(elements['webrtc-panel'].hidden, true);
  elements['source-kind'].value = 'webrtc';
  await elements['source-kind'].dispatch('change');
  panel.render(snapshot);
  assert.deepEqual(choices, ['webrtc']);
  assert.equal(elements['reference-source-content'].hidden, true);
  assert.equal(elements['webrtc-panel'].hidden, false);

  elements['source-kind'].value = 'reference';
  await elements['source-kind'].dispatch('change');
  panel.render(snapshot);
  assert.deepEqual(choices, ['webrtc', 'reference']);
  assert.equal(elements['reference-source-content'].hidden, false);
  assert.equal(elements['webrtc-panel'].hidden, true);
});

test('connection server forwards Require token and shows the active policy', async () => {
  const ids = ['source-kind', 'reference-source-content', 'webrtc-panel', 'webrtc-panel-status',
    'webrtc-offer', 'webrtc-answer', 'webrtc-connect', 'webrtc-disconnect', 'signaling-start',
    'signaling-interface', 'signaling-require-token', 'signaling-access-note', 'signaling-url',
    'signaling-copy', 'signaling-stop', 'sender-link-step', 'whip-url', 'whip-copy-url', 'whip-copy-token'];
  const elements = Object.fromEntries(ids.map(id => [id, makeElement()]));
  const calls = [];
  const snapshot = { source: { kind: 'webrtc', status: 'disconnected' },
    signaling: { running: false, lanInterfaces: [{ address: '192.168.1.10', name: 'eth0' }] } };
  const panel = createWebRTCPanel({ querySelector: selector => elements[selector.slice(1)] }, {
    desktop: { startSignaling: (...args) => { calls.push(args); } },
    run: action => action(), getSnapshot: () => snapshot,
  });
  elements['signaling-interface'].value = '192.168.1.10';
  elements['signaling-require-token'].checked = true;
  elements['signaling-require-token'].dispatch('change');
  assert.match(elements['signaling-access-note'].textContent, /token required/i);
  assert.equal(elements['sender-link-step'].hidden, true);
  await elements['signaling-start'].dispatch('click');
  assert.deepEqual(calls, [['192.168.1.10', true]]);
  panel.render({ ...snapshot, signaling: { ...snapshot.signaling, running: true, lan: true, requireToken: true } });
  assert.equal(elements['signaling-require-token'].disabled, true);
  assert.equal(elements['sender-link-step'].hidden, false);
  assert.match(elements['signaling-access-note'].textContent, /token required/i);
});

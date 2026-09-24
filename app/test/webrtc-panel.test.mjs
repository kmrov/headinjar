import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebRTCPanel } from '../renderer/webrtc-panel.mjs';

function makeElement() {
  const listeners = new Map();
  return {
    hidden: false, disabled: false, value: '', textContent: '', readOnly: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type) { return listeners.get(type)?.(); },
  };
}

test('source choice shows the matching media controls and switches the project source', async () => {
  const ids = ['source-kind', 'reference-source-content', 'webrtc-panel', 'webrtc-panel-status',
    'webrtc-offer', 'webrtc-answer', 'webrtc-connect', 'webrtc-disconnect', 'signaling-start',
    'signaling-url', 'signaling-copy', 'signaling-stop', 'whip-url', 'whip-copy-url', 'whip-copy-token'];
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

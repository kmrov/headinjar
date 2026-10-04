import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject } from '../src/project/model.mjs';
import { nextWorkflowStep } from '../renderer/workflow-guide.mjs';

const project = () => createProject({ id: 'guide', name: 'Guide', now: '2026-10-04T00:00:00.000Z' });
const state = (item, extras = {}) => ({ project: item, source: { kind: 'reference', status: 'disconnected' },
  referencePreview: null, output: { armed: false }, displayId: null, ...extras });

test('the guide follows a new operator from model through source, alignment, display, and projection', () => {
  const item = project();
  assert.equal(nextWorkflowStep(state(item)).id, 'model');
  item.mesh = { name: 'guide.obj', obj: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' };
  assert.equal(nextWorkflowStep(state(item)).id, 'source');
  item.reference = { path: '/tmp/guide.png' };
  assert.equal(nextWorkflowStep(state(item, { referencePreview: 'data:image/png;base64,test' })).id, 'align');
  item.placement.alignment.pairs = [
    { source: {u:.2,v:.2}, target: {u:.2,v:.2} },
    { source: {u:.8,v:.2}, target: {u:.8,v:.2} },
    { source: {u:.5,v:.8}, target: {u:.5,v:.8} },
  ];
  item.placement.grid.columns = 17;
  assert.equal(nextWorkflowStep(state(item, { referencePreview: 'ready' })).id, 'display');
  assert.equal(nextWorkflowStep(state(item, { referencePreview: 'ready', displayId: 'one' })).id, 'projection');
  assert.equal(nextWorkflowStep(state(item, { referencePreview: 'ready', displayId: 'one', output: { armed: true } })), null);
});

test('the guide asks for a video connection and skips point alignment for Model UV', () => {
  const item = project();
  item.mesh = { name: 'guide.obj', obj: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' };
  assert.equal(nextWorkflowStep(state(item, { source: { kind: 'webrtc', status: 'disconnected' } })).id, 'connect');
  assert.equal(nextWorkflowStep(state(item, { source: { kind: 'webrtc', status: 'running' } })).id, 'align');
  item.placement.mappingMode = 'uv';
  assert.equal(nextWorkflowStep(state(item, { source: { kind: 'webrtc', status: 'running' } })).id, 'display');
});

test('projector guidance follows the real object while the image still needs alignment', () => {
  const item = project();
  item.mesh = { name: 'guide.obj', obj: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' };
  item.reference = { path: '/tmp/guide.png' };
  assert.equal(nextWorkflowStep(state(item, { referencePreview: 'ready' }), 'projector').id, 'display');
  assert.equal(nextWorkflowStep(state(item, { referencePreview: 'ready', displayId: 'one' }), 'projector').id, 'physical-points');
  item.projector.calibration.pairs = [
    { source: {u:.2,v:.2}, target: {u:.2,v:.2} },
    { source: {u:.8,v:.2}, target: {u:.8,v:.2} },
    { source: {u:.5,v:.8}, target: {u:.5,v:.8} },
  ];
  assert.equal(nextWorkflowStep(state(item, { referencePreview: 'ready' }), 'projector').id, 'display');
});

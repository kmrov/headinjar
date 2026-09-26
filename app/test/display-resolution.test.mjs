import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXrandrDisplays, physicalDisplaySize, validateDisplaySelection, outputForDisplay } from '../electron/display-resolution.mjs';

test('scaled logical desktop reports its physical pixel resolution', () => {
  assert.deepEqual(physicalDisplaySize({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }),
    { width: 3840, height: 2160 });
  assert.deepEqual(physicalDisplaySize({ bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
    { width: 1920, height: 1080 });
});

test('XRandR resolves the exact 4K mode when fractional Electron bounds round upward', () => {
  const xrandr = `Screen 0: minimum 16 x 16, current 3840 x 2160, maximum 32767 x 32767
DP-1 connected primary 3840x2160+0+0 (0x41) normal (normal left inverted right x axis y axis)
    Identifier: 0x21
HDMI-1 connected 1920x1080+3840+0 (0x42) normal (normal left inverted right x axis y axis)
    Identifier: 0x23
`;
  const modes = parseXrandrDisplays(xrandr);
  const display = { id: 33, nativeOrigin: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 2255, height: 1269 }, scaleFactor: 1.703125 };
  assert.deepEqual(physicalDisplaySize(display, modes), { width: 3840, height: 2160 });
  assert.deepEqual(physicalDisplaySize({ id: 999, nativeOrigin: { x: 3840, y: 0 }, bounds: { x: 2255, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }, modes),
    { width: 1920, height: 1080 });
  assert.deepEqual(physicalDisplaySize(display), { width: 3841, height: 2161 });
});

test('selecting any display automatically updates project render dimensions', () => {
  const current = { width: 1920, height: 1080, displayId: null };
  const fourK = { id: 12, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 };
  assert.deepEqual(outputForDisplay(current, fourK), { width: 3840, height: 2160, displayId: '12' });
  const projector = { id: 20, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  assert.deepEqual(outputForDisplay({ width: 3840, height: 2160, displayId: '12' }, projector),
    { width: 1920, height: 1080, displayId: '20' });
});

test('selection rejects a display whose physical dimensions changed before confirmation', () => {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 };
  assert.deepEqual(validateDisplaySelection(display, { width: 3840, height: 2160 }), { width: 3840, height: 2160 });
  assert.throws(() => validateDisplaySelection(display, { width: 1920, height: 1080 }), /changed/i);
  assert.throws(() => validateDisplaySelection(display, { width: 3840.5, height: 2160 }), /invalid/i);
});

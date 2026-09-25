import { isSurfacePlacement } from '../src/mapping/surface.mjs';

const ACTION_FIELDS = new Map([
  ['resume', ['type']],
  ['stop', ['type']],
  ['blackout', ['type', 'enabled']],
  ['hold', ['type', 'enabled']],
]);

export function isTrustedEditorSender(event, editorWebContents, expectedUrl) {
  return Boolean(event
    && event.sender === editorWebContents
    && event.senderFrame === editorWebContents.mainFrame
    && event.senderFrame?.url === expectedUrl);
}

export function isValidOutputAction(event) {
  if (!plainRecord(event)) return false;
  const type = readData(event, 'type');
  if (typeof type !== 'string') return false;
  const fields = ACTION_FIELDS.get(type);
  return Boolean(fields && exactKeys(event, fields)
    && (!fields.includes('enabled') || typeof readData(event, 'enabled') === 'boolean'));
}

export function isValidProjectEditCommand(command) {
  if (!plainRecord(command)) return false;
  const type = readData(command, 'type');
  if (typeof type !== 'string') return false;
  const fields = {
    'placement-transform': ['type', 'value'],
    'grid-point': ['type', 'index', 'point'],
    mask: ['type', 'value'],
    'alignment-pairs': ['type', 'value'],
    'alignment-apply': ['type', 'value'],
    'calibration-pairs': ['type', 'value'],
    'calibration-apply': ['type', 'value'],
    'calibration-reseed': ['type', 'value'],
    'calibration-reset': ['type'],
    'mapping-mode': ['type', 'value'],
    'surface-placement': ['type', 'value'],
    'reset-placement': ['type'],
    projector: ['type', 'value'],
    output: ['type', 'value'],
  }[type];
  if (!fields || !exactKeys(command, fields)) return false;
  if (type === 'placement-transform') {
    const value = readData(command, 'value');
    return exactRecord(value, ['x', 'y', 'scale', 'rotation'])
      && ['x', 'y', 'scale', 'rotation'].every((key) => Number.isFinite(readData(value, key)))
      && readData(value, 'scale') > 0;
  }
  if (type === 'grid-point') {
    const point = readData(command, 'point');
    return Number.isSafeInteger(readData(command, 'index'))
      && exactRecord(point, ['u', 'v'])
      && Number.isFinite(readData(point, 'u')) && Number.isFinite(readData(point, 'v'));
  }
  if (type === 'alignment-pairs' || type === 'alignment-apply') {
    return validLandmarkPairs(readData(command, 'value'), type === 'alignment-apply' ? 3 : 0);
  }
  if (type === 'calibration-pairs' || type === 'calibration-apply' || type === 'calibration-reseed') {
    return validLandmarkPairs(readData(command, 'value'), type === 'calibration-apply' ? 3 : 0);
  }
  if (type === 'mapping-mode') return ['front', 'uv', 'surface'].includes(readData(command, 'value'));
  if (type === 'surface-placement') return isSurfacePlacement(readData(command, 'value'));
  return true;
}

function validLandmarkPairs(pairs, minimum) {
  if (!Array.isArray(pairs) || Object.getPrototypeOf(pairs) !== Array.prototype || pairs.length < minimum || pairs.length > 12) return false;
  const keys = Reflect.ownKeys(pairs);
  if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !Number.isSafeInteger(Number(key)) || Number(key) < 0 || Number(key) >= pairs.length || String(Number(key)) !== key))) return false;
  for (let index = 0; index < pairs.length; index += 1) {
    const pairDescriptor = Object.getOwnPropertyDescriptor(pairs, String(index));
    if (!pairDescriptor || !Object.hasOwn(pairDescriptor, 'value')) return false;
    const pair = pairDescriptor.value;
    if (!exactRecord(pair, ['source', 'target'])) return false;
    for (const key of ['source', 'target']) {
      const point = readData(pair, key);
      if (!exactRecord(point, ['u', 'v'])) return false;
      for (const axis of ['u', 'v']) {
        const coordinate = readData(point, axis);
        if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) return false;
      }
    }
  }
  return true;
}

export function getProjectOutputImpact(previous, next, reason) {
  if (reason === 'replace') return 'reset-display';
  if (!previous || !next) return 'reset-display';
  const before = previous.project ?? previous;
  const after = next.project ?? next;
  if (!before || !after) return 'reset-display';
  const outputChanged = before.output?.width !== after.output?.width
    || before.output?.height !== after.output?.height
    || before.output?.displayId !== after.output?.displayId;
  if (outputChanged) return 'reset-display';
  const meshChanged = before.mesh?.name !== after.mesh?.name || before.mesh?.obj !== after.mesh?.obj;
  const referenceChanged = before.reference?.path !== after.reference?.path;
  return meshChanged || referenceChanged ? 'disarm-source' : 'none';
}

export function isValidDisplayId(displayId, displays) {
  return typeof displayId === 'string'
    && displayId.length > 0
    && Array.isArray(displays)
    && displays.some((display) => String(display.id) === displayId);
}

export function validateProjectName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 256) {
    throw new RangeError('Project name must contain 1–256 characters');
  }
  return name.trim();
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(record, expected) {
  const keys = Reflect.ownKeys(record);
  return keys.length === expected.length && keys.every((key) => typeof key === 'string' && expected.includes(key))
    && expected.every((key) => Object.hasOwn(Object.getOwnPropertyDescriptor(record, key) ?? {}, 'value'));
}

function exactRecord(value, expected) {
  return plainRecord(value) && exactKeys(value, expected);
}

function readData(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

import { createProject, validateProject } from './model.mjs';
import { createGrid, moveGridPoint } from '../mapping/grid.mjs';
import { fitLandmarkGrid } from '../mapping/alignment.mjs';
import { isSurfacePlacement } from '../mapping/surface.mjs';

const HISTORY_LIMIT = 30;

export function createHistory(project) {
  assertProject(project);
  return { project: structuredClone(project), past: [], future: [] };
}

export function editHistory(history, command, nowISO) {
  validateHistory(history);
  validateCommand(command);
  const next = structuredClone(history.project);
  applyCommand(next, command);
  return commit(history, next, nowISO, [...history.past, history.project], []);
}

export function undoHistory(history, nowISO) {
  validateHistory(history);
  if (history.past.length === 0) return history;
  const target = history.past.at(-1);
  const past = history.past.slice(0, -1);
  return commit(history, target, nowISO, past, [...history.future, history.project]);
}

export function redoHistory(history, nowISO) {
  validateHistory(history);
  if (history.future.length === 0) return history;
  const target = history.future.at(-1);
  const future = history.future.slice(0, -1);
  return commit(history, target, nowISO, [...history.past, history.project], future);
}

function commit(history, project, nowISO, past, future) {
  if (history.project.revision === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('project revision cannot be incremented');
  }
  assertProject(project);
  const committed = structuredClone(project);
  committed.revision = history.project.revision + 1;
  committed.updatedAt = nowISO;
  assertProject(committed);
  return {
    project: committed,
    past: past.slice(-HISTORY_LIMIT).map((snapshot) => structuredClone(snapshot)),
    future: future.slice(-HISTORY_LIMIT).map((snapshot) => structuredClone(snapshot)),
  };
}

function applyCommand(project, command) {
  const projectorBefore = structuredClone(project.projector);
  const outputBefore = { width: project.output.width, height: project.output.height };
  switch (command.type) {
    case 'placement-transform':
      project.placement.transform = command.value;
      break;
    case 'grid-point':
      project.placement.grid = moveGridPoint(project.placement.grid, command.index, command.point);
      break;
    case 'mask':
      project.placement.mask = command.value;
      break;
    case 'alignment-pairs':
      project.placement.alignment = { pairs: command.value };
      break;
    case 'alignment-apply': {
      if (project.placement.mappingMode !== 'front') throw new RangeError('Alignment can only be applied in front mapping mode');
      const grid = fitLandmarkGrid(command.value);
      project.placement.alignment = { pairs: command.value };
      project.placement.grid = grid;
      project.placement.transform = { x: 0, y: 0, scale: 1, rotation: 0 };
      break;
    }
    case 'mapping-mode':
      project.placement.mappingMode = command.value;
      break;
    case 'surface-placement':
      project.placement.surface = command.value;
      break;
    case 'reset-placement':
      project.placement = createProject({ id: project.id, name: project.name, now: project.createdAt }).placement;
      break;
    case 'projector':
      project.projector = command.value;
      assertProject(project);
      project.projector = structuredClone(project.projector);
      if (projectorBefore.calibration) project.projector.calibration = structuredClone(projectorBefore.calibration);
      else delete project.projector.calibration;
      if (projectorGeometryChanged(projectorBefore, project.projector)) resetCalibration(project.projector);
      break;
    case 'mesh': {
      const defaults = createProject({ id: project.id, name: project.name, now: project.createdAt });
      project.mesh = command.value;
      project.placement = defaults.placement;
      project.projector = defaults.projector;
      break;
    }
    case 'reference':
      project.reference = command.value;
      if (project.placement.alignment) project.placement.alignment = { pairs: [] };
      break;
    case 'output':
      project.output = command.value;
      assertProject(project);
      project.output = structuredClone(project.output);
      if (outputBefore.width !== project.output.width || outputBefore.height !== project.output.height) {
        resetCalibration(project.projector);
      }
      break;
    case 'calibration-pairs':
      ensureCalibration(project.projector).pairs = command.value;
      break;
    case 'calibration-apply':
      ensureCalibration(project.projector).pairs = command.value;
      ensureCalibration(project.projector).grid = fitLandmarkGrid(command.value, 33, 33);
      break;
    case 'calibration-reseed':
      resetCalibration(project.projector);
      project.projector.calibration.pairs = command.value;
      break;
    case 'calibration-reset':
      resetCalibration(project.projector);
      break;
  }
}

function ensureCalibration(projector) {
  if (!projector.calibration) projector.calibration = { pairs: [], grid: createGrid(2, 2) };
  return projector.calibration;
}

function resetCalibration(projector) {
  projector.calibration = { pairs: [], grid: createGrid(2, 2) };
}

function projectorGeometryChanged(before, after) {
  return JSON.stringify([before.position, before.rotation, before.fov, before.offset, before.model])
    !== JSON.stringify([after.position, after.rotation, after.fov, after.offset, after.model]);
}

function assertProject(project) {
  const result = validateProject(project);
  if (!result.valid) throw new RangeError(`Invalid project: ${result.reason}`);
}

function validateHistory(history) {
  assertRecord(history, ['project', 'past', 'future'], 'history');
  assertProject(history.project);
  validateSnapshots(history.past, history.project.id, 'past');
  validateSnapshots(history.future, history.project.id, 'future');
}

function validateSnapshots(snapshots, projectId, label) {
  if (!Array.isArray(snapshots) || snapshots.length > HISTORY_LIMIT) {
    throw new RangeError(`Invalid history ${label}`);
  }
  for (const key of Reflect.ownKeys(snapshots)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' ? Number(key) : NaN;
    if (!Number.isSafeInteger(index) || index < 0 || index >= snapshots.length || String(index) !== key) {
      throw new RangeError(`Invalid history ${label}`);
    }
  }
  for (let index = 0; index < snapshots.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(snapshots, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new RangeError(`Invalid history ${label}`);
    assertProject(descriptor.value);
    if (descriptor.value.id !== projectId) throw new RangeError(`History ${label} project identity mismatch`);
  }
}

function validateCommand(command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new RangeError('Invalid project command');
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(command, 'type');
  if (!typeDescriptor || !Object.hasOwn(typeDescriptor, 'value') || typeof typeDescriptor.value !== 'string') {
    throw new RangeError('Invalid project command');
  }
  const commandFields = {
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
    mesh: ['type', 'value'],
    reference: ['type', 'value'],
    output: ['type', 'value'],
  }[typeDescriptor.value];
  if (!commandFields) throw new RangeError('Unknown project command');
  assertRecord(command, commandFields, 'command');
  if (typeDescriptor.value === 'grid-point') {
    const index = readDataProperty(command, 'index');
    if (!Number.isSafeInteger(index)) throw new RangeError('Grid point index must be an integer');
    const point = readDataProperty(command, 'point');
    assertRecord(point, ['u', 'v'], 'grid point');
    for (const key of ['u', 'v']) {
      if (typeof readDataProperty(point, key) !== 'number' || !Number.isFinite(readDataProperty(point, key))) {
        throw new RangeError('Grid point coordinates must be finite');
      }
    }
  }
  if (typeDescriptor.value === 'alignment-pairs' || typeDescriptor.value === 'alignment-apply') {
    validateLandmarkPairs(readDataProperty(command, 'value'), typeDescriptor.value === 'alignment-apply' ? 3 : 0);
  }
  if (typeDescriptor.value === 'calibration-pairs' || typeDescriptor.value === 'calibration-apply' || typeDescriptor.value === 'calibration-reseed') {
    validateLandmarkPairs(readDataProperty(command, 'value'), typeDescriptor.value === 'calibration-apply' ? 3 : 0);
  }
  if (typeDescriptor.value === 'mapping-mode' && !['front', 'uv', 'surface'].includes(readDataProperty(command, 'value'))) {
    throw new RangeError('Mapping mode must be front, uv, or surface');
  }
  if (typeDescriptor.value === 'surface-placement' && !isSurfacePlacement(readDataProperty(command, 'value'))) {
    throw new RangeError('Surface placement is invalid');
  }
}

function validateLandmarkPairs(pairs, minimum) {
  if (!Array.isArray(pairs) || Object.getPrototypeOf(pairs) !== Array.prototype || pairs.length < minimum || pairs.length > 12) {
    throw new RangeError(`Alignment pairs must contain ${minimum} to 12 landmarks`);
  }
  for (const key of Reflect.ownKeys(pairs)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' ? Number(key) : NaN;
    if (!Number.isSafeInteger(index) || index < 0 || index >= pairs.length || String(index) !== key) throw new RangeError('Alignment pairs have an unexpected property');
  }
  for (let index = 0; index < pairs.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(pairs, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new RangeError(`Alignment pair ${index} must be a data element`);
    const pair = descriptor.value;
    assertRecord(pair, ['source', 'target'], 'alignment pair');
    for (const key of ['source', 'target']) {
      const point = readDataProperty(pair, key);
      assertRecord(point, ['u', 'v'], `alignment ${key}`);
      for (const axis of ['u', 'v']) {
        const coordinate = readDataProperty(point, axis);
        if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) {
          throw new RangeError(`Alignment ${key}.${axis} must be finite and inside [0, 1]`);
        }
      }
    }
  }
}

function assertRecord(value, expectedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError(`Invalid ${label}`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
    throw new RangeError(`Invalid ${label} fields`);
  }
  for (const key of expectedKeys) readDataProperty(value, key);
}

function readDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new RangeError(`Invalid ${key} value`);
  return descriptor.value;
}

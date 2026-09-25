import { createGrid, validateGrid } from '../mapping/grid.mjs';
import { isSurfacePlacement } from '../mapping/surface.mjs';

const MAX_OBJ_BYTES = 32 * 1024 * 1024;
const ORIENTATIONS = new Set(['normal', 'flip-x', 'flip-y', 'rotate-180']);

function fail(message) {
  throw new RangeError(message);
}

function object(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} has missing or unknown fields`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${label}.${String(key)} must be a data property`);
  }
}

function optionalObject(value, requiredKeys, optionalKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string' || (!requiredKeys.includes(key) && !optionalKeys.includes(key))) ||
      requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} has missing or unknown fields`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${label}.${String(key)} must be a data property`);
  }
}

function dataArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a standard array`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' ? Number(key) : NaN;
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      fail(`${label} has an unexpected property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${label}[${index}] must be a data element`);
  }
}

function string(value, label, max) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) fail(`${label} must be a nonempty string of at most ${max} characters`);
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be finite`);
}

function vector(value, length, label) {
  dataArray(value, label);
  if (value.length !== length) fail(`${label} must contain ${length} numbers`);
  for (let index = 0; index < value.length; index += 1) finite(value[index], `${label}[${index}]`);
}

function timestamp(value, label) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-](\d\d):(\d\d))$/);
  if (!match || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an ISO timestamp`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = month >= 1 && month <= 12
    ? [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    : 0;
  if (day < 1 || day > daysInMonth || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
      (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) {
    fail(`${label} must be an ISO timestamp`);
  }
}

function validateData(value) {
  object(value, ['version', 'id', 'name', 'revision', 'createdAt', 'updatedAt', 'mesh', 'reference', 'placement', 'projector', 'output', 'source'], 'project');
  if (value.version !== 1) fail('unsupported project version');
  string(value.id, 'id', 128);
  string(value.name, 'name', 256);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) fail('revision must be a nonnegative safe integer');
  timestamp(value.createdAt, 'createdAt');
  timestamp(value.updatedAt, 'updatedAt');

  if (value.mesh !== null) {
    object(value.mesh, ['name', 'obj'], 'mesh');
    string(value.mesh.name, 'mesh.name', 4096);
    if (typeof value.mesh.obj !== 'string' || Buffer.byteLength(value.mesh.obj, 'utf8') > MAX_OBJ_BYTES) fail('mesh.obj must be text of at most 32 MiB');
  }
  if (value.reference !== null) {
    object(value.reference, ['path'], 'reference');
    string(value.reference.path, 'reference.path', 4096);
  }

  optionalObject(value.placement, ['grid', 'transform', 'mask'], ['alignment', 'mappingMode', 'surface'], 'placement');
  object(value.placement.grid, ['columns', 'rows', 'points'], 'placement.grid');
  dataArray(value.placement.grid.points, 'placement.grid.points');
  for (const point of value.placement.grid.points) object(point, ['u', 'v'], 'grid point');
  const gridResult = validateGrid(value.placement.grid);
  if (!gridResult.valid) fail(`invalid placement grid: ${gridResult.reason}`);
  object(value.placement.transform, ['x', 'y', 'scale', 'rotation'], 'placement.transform');
  for (const key of ['x', 'y', 'rotation']) finite(value.placement.transform[key], `placement.transform.${key}`);
  finite(value.placement.transform.scale, 'placement.transform.scale');
  if (value.placement.transform.scale <= 0) fail('placement scale must be positive');
  dataArray(value.placement.mask, 'placement.mask');
  for (const polygon of value.placement.mask) {
    object(polygon, ['excluded', 'points'], 'mask polygon');
    if (typeof polygon.excluded !== 'boolean') fail('mask polygon excluded must be boolean');
    dataArray(polygon.points, 'mask polygon.points');
    if (polygon.points.length < 3) fail('mask polygon needs at least three points');
    for (const point of polygon.points) {
      object(point, ['u', 'v'], 'mask point');
      finite(point.u, 'mask point u');
      finite(point.v, 'mask point v');
      if (point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1) fail('mask points must be inside [0, 1]');
    }
  }
  if (Object.hasOwn(value.placement, 'alignment')) {
    object(value.placement.alignment, ['pairs'], 'placement.alignment');
    dataArray(value.placement.alignment.pairs, 'placement.alignment.pairs');
    if (value.placement.alignment.pairs.length > 12) fail('placement.alignment.pairs may contain at most 12 landmarks');
    for (const pair of value.placement.alignment.pairs) {
      object(pair, ['source', 'target'], 'alignment pair');
      for (const key of ['source', 'target']) {
        object(pair[key], ['u', 'v'], `alignment ${key}`);
        for (const axis of ['u', 'v']) {
          finite(pair[key][axis], `alignment ${key}.${axis}`);
          if (pair[key][axis] < 0 || pair[key][axis] > 1) fail(`alignment ${key}.${axis} must be inside [0, 1]`);
        }
      }
    }
  }
  if (Object.hasOwn(value.placement, 'mappingMode') && !['front', 'uv', 'surface'].includes(value.placement.mappingMode)) {
    fail('placement.mappingMode must be front, uv, or surface');
  }
  if (Object.hasOwn(value.placement, 'surface') && !isSurfacePlacement(value.placement.surface)) fail('placement.surface is invalid');

  optionalObject(value.projector, ['position', 'rotation', 'fov', 'offset', 'model'], ['calibration'], 'projector');
  vector(value.projector.position, 3, 'projector.position');
  vector(value.projector.rotation, 3, 'projector.rotation');
  finite(value.projector.fov, 'projector.fov');
  if (value.projector.fov <= 0 || value.projector.fov >= 180) fail('projector fov must be between 0 and 180');
  vector(value.projector.offset, 2, 'projector.offset');
  object(value.projector.model, ['position', 'rotation', 'scale'], 'projector.model');
  vector(value.projector.model.position, 3, 'projector.model.position');
  vector(value.projector.model.rotation, 3, 'projector.model.rotation');
  finite(value.projector.model.scale, 'projector.model.scale');
  if (value.projector.model.scale <= 0) fail('projector model scale must be positive');
  if (Object.hasOwn(value.projector, 'calibration')) {
    object(value.projector.calibration, ['pairs', 'grid'], 'projector.calibration');
    dataArray(value.projector.calibration.pairs, 'projector.calibration.pairs');
    if (value.projector.calibration.pairs.length > 12) fail('projector.calibration.pairs may contain at most 12 landmarks');
    for (const pair of value.projector.calibration.pairs) {
      object(pair, ['source', 'target'], 'projector calibration pair');
      for (const key of ['source', 'target']) {
        object(pair[key], ['u', 'v'], `projector calibration ${key}`);
        for (const axis of ['u', 'v']) {
          finite(pair[key][axis], `projector calibration ${key}.${axis}`);
          if (pair[key][axis] < 0 || pair[key][axis] > 1) fail(`projector calibration ${key}.${axis} must be inside [0, 1]`);
        }
      }
    }
    object(value.projector.calibration.grid, ['columns', 'rows', 'points'], 'projector.calibration.grid');
    dataArray(value.projector.calibration.grid.points, 'projector.calibration.grid.points');
    for (const point of value.projector.calibration.grid.points) object(point, ['u', 'v'], 'projector calibration grid point');
    const calibrationGrid = validateGrid(value.projector.calibration.grid);
    if (!calibrationGrid.valid) fail(`invalid projector calibration grid: ${calibrationGrid.reason}`);
  }

  object(value.output, ['width', 'height', 'displayId'], 'output');
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(value.output[key]) || value.output[key] <= 0 || value.output[key] > 16384) fail(`output.${key} must be a positive integer no greater than 16384`);
  }
  if (value.output.displayId !== null) string(value.output.displayId, 'output.displayId', 4096);

  if (value.source !== null) {
    object(value.source, ['width', 'height', 'orientation', 'framing'], 'source');
    for (const key of ['width', 'height']) {
      if (!Number.isInteger(value.source[key]) || value.source[key] <= 0 || value.source[key] > 16384) fail(`source.${key} must be a positive integer no greater than 16384`);
    }
    if (!ORIENTATIONS.has(value.source.orientation)) fail('source.orientation is invalid');
    string(value.source.framing, 'source.framing', 4096);
  }
}

function detached(value) {
  return {
    version: 1,
    id: value.id,
    name: value.name,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    mesh: value.mesh === null ? null : { name: value.mesh.name, obj: value.mesh.obj },
    reference: value.reference === null ? null : { path: value.reference.path },
    placement: {
      grid: { columns: value.placement.grid.columns, rows: value.placement.grid.rows, points: value.placement.grid.points.map(({ u, v }) => ({ u, v })) },
      transform: { x: value.placement.transform.x, y: value.placement.transform.y, scale: value.placement.transform.scale, rotation: value.placement.transform.rotation },
      mask: value.placement.mask.map(({ excluded, points }) => ({ excluded, points: points.map(({ u, v }) => ({ u, v })) })),
      ...(Object.hasOwn(value.placement, 'alignment') ? { alignment: { pairs: value.placement.alignment.pairs.map(({ source, target }) => ({ source: { u: source.u, v: source.v }, target: { u: target.u, v: target.v } })) } } : {}),
      ...(Object.hasOwn(value.placement, 'mappingMode') ? { mappingMode: value.placement.mappingMode } : {}),
      ...(Object.hasOwn(value.placement, 'surface') ? { surface: value.placement.surface === null ? null : {
        position: [...value.placement.surface.position], normal: [...value.placement.surface.normal], up: [...value.placement.surface.up],
        scale: value.placement.surface.scale, rotation: value.placement.surface.rotation,
      } } : {}),
    },
    projector: {
      position: [...value.projector.position], rotation: [...value.projector.rotation], fov: value.projector.fov,
      offset: [...value.projector.offset],
      model: { position: [...value.projector.model.position], rotation: [...value.projector.model.rotation], scale: value.projector.model.scale },
      ...(Object.hasOwn(value.projector, 'calibration') ? { calibration: {
        pairs: value.projector.calibration.pairs.map(({ source, target }) => ({ source: { u: source.u, v: source.v }, target: { u: target.u, v: target.v } })),
        grid: { columns: value.projector.calibration.grid.columns, rows: value.projector.calibration.grid.rows,
          points: value.projector.calibration.grid.points.map(({ u, v }) => ({ u, v })) },
      } } : {}),
    },
    output: { width: value.output.width, height: value.output.height, displayId: value.output.displayId },
    source: value.source === null ? null : { width: value.source.width, height: value.source.height, orientation: value.source.orientation, framing: value.source.framing },
  };
}

export function createProject({ id, name, now }) {
  const project = {
    version: 1, id, name, revision: 0, createdAt: now, updatedAt: now,
    mesh: null, reference: null,
    placement: { grid: createGrid(5, 5), transform: { x: 0, y: 0, scale: 1, rotation: 0 }, mask: [], alignment: { pairs: [] }, mappingMode: 'front', surface: null },
    projector: { position: [0, 0, 3], rotation: [0, 0, 0], fov: 45, offset: [0, 0], model: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, calibration: { pairs: [], grid: createGrid(2, 2) } },
    output: { width: 1920, height: 1080, displayId: null }, source: null,
  };
  const result = validateProject(project);
  if (!result.valid) fail(result.reason);
  return project;
}

export function validateProject(value) {
  try {
    validateData(value);
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'project is invalid' };
  }
}

export function serializeProject(project) {
  const result = validateProject(project);
  if (!result.valid) fail(result.reason);
  return JSON.stringify(detached(project));
}

export function parseProject(text) {
  if (typeof text !== 'string') fail('project data must be text');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('project data is not valid JSON');
  }
  const result = validateProject(parsed);
  if (!result.valid) fail(result.reason);
  return detached(parsed);
}

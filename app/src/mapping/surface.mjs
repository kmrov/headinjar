const EPSILON = 1e-8;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const clean = value => Math.abs(value) < 1e-12 ? 0 : value;

function unit(vector) {
  if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) return null;
  const length = Math.hypot(...vector);
  return length > EPSILON ? vector.map(value => clean(value / length)) : null;
}

function tangentUp(normal, candidate) {
  const parallel = dot(candidate, normal);
  return unit(candidate.map((value, index) => value - parallel * normal[index]));
}

export function surfaceFromHit(position, normal, previous = null) {
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) return null;
  const n = unit(normal);
  if (!n) return null;
  const up = (previous?.up && tangentUp(n, previous.up)) || tangentUp(n, [0, 1, 0]) || tangentUp(n, [1, 0, 0]);
  if (!up) return null;
  return { position: [...position], normal: n, up, scale: previous?.scale ?? 1, rotation: previous?.rotation ?? 0 };
}

export function surfaceProjectionFrame(surface, bounds) {
  const right = cross(surface.up, surface.normal);
  const angle = (surface.rotation % 360) * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const rotatedRight = right.map((value, index) => clean(c * value + s * surface.up[index]));
  const rotatedUp = surface.up.map((value, index) => clean(-s * right[index] + c * value));
  const modelSize = bounds.max.map((value, index) => value - bounds.min[index]);
  const fallback = Math.max(...modelSize, 1e-9);
  const depths = [];
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]])
        depths.push(dot(subtract([x, y, z], surface.position), surface.normal));
  const depthMin = Math.min(...depths), depthMax = Math.max(...depths);
  return {
    origin: [...surface.position], right: rotatedRight, up: rotatedUp, normal: [...surface.normal],
    width: (modelSize[0] || fallback) * surface.scale,
    height: (modelSize[1] || fallback) * surface.scale,
    depthMin, depthRange: Math.max(depthMax - depthMin, 1e-9),
  };
}

function vectorData(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3) return false;
  if (Reflect.ownKeys(value).length !== 4) return false;
  return [0, 1, 2].every(index => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor && Object.hasOwn(descriptor, 'value') && Number.isFinite(descriptor.value);
  });
}

export function isSurfacePlacement(value) {
  if (value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = ['position', 'normal', 'up', 'scale', 'rotation'];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) return false;
  const values = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
    values[field] = descriptor.value;
  }
  if (!vectorData(values.position) || !vectorData(values.normal) || !vectorData(values.up)) return false;
  if (!Number.isFinite(values.scale) || values.scale <= 0 || !Number.isFinite(values.rotation)) return false;
  const normalLength = Math.hypot(...values.normal), upLength = Math.hypot(...values.up);
  return Math.abs(normalLength - 1) < 1e-4 && Math.abs(upLength - 1) < 1e-4
    && Math.abs(dot(values.normal, values.up)) < 1e-4;
}

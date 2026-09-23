import { validateGrid } from './grid.mjs';

const MIN_PAIRS = 3;
const MAX_PAIRS = 12;

function fail(message) {
  throw new RangeError(message);
}

function record(value, fields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    fail(`${label} must contain exactly ${fields.join(', ')}`);
  }
  const result = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${label}.${key} must be a data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function point(value, label) {
  const data = record(value, ['u', 'v'], label);
  for (const axis of ['u', 'v']) {
    if (typeof data[axis] !== 'number' || !Number.isFinite(data[axis]) || data[axis] < 0 || data[axis] > 1) {
      fail(`${label}.${axis} must be finite and inside [0, 1]`);
    }
  }
  return data;
}

function readPairs(pairs) {
  if (!Array.isArray(pairs) || Object.getPrototypeOf(pairs) !== Array.prototype) fail('pairs must be a standard array');
  if (pairs.length < MIN_PAIRS || pairs.length > MAX_PAIRS) fail(`pairs must contain ${MIN_PAIRS} to ${MAX_PAIRS} landmarks`);
  const ownKeys = Reflect.ownKeys(pairs);
  if (ownKeys.some((key) => key !== 'length' && (typeof key !== 'string' || !Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) >= pairs.length || String(Number(key)) !== key))) {
    fail('pairs has an unexpected property');
  }
  return Array.from({ length: pairs.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(pairs, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`pairs[${index}] must be a data element`);
    const pair = record(descriptor.value, ['source', 'target'], `pairs[${index}]`);
    return { source: point(pair.source, `pairs[${index}].source`), target: point(pair.target, `pairs[${index}].target`) };
  });
}

function kernel(distanceSquared) {
  return distanceSquared === 0 ? 0 : distanceSquared * Math.log(distanceSquared);
}

function solve(matrix, right) {
  const size = right.length;
  const rows = matrix.map((row, index) => [...row, right[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) fail('landmark system is singular; target points may be too close or collinear');
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let j = column; j <= size; j += 1) rows[column][j] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let j = column; j <= size; j += 1) rows[row][j] -= factor * rows[column][j];
    }
  }
  return rows.map((row) => row[size]);
}

function fitAxis(pairs, axis) {
  const count = pairs.length;
  const size = count + 3;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const right = Array(size).fill(0);
  for (let row = 0; row < count; row += 1) {
    const { u, v } = pairs[row].target;
    for (let column = 0; column < count; column += 1) {
      const other = pairs[column].target;
      const du = u - other.u;
      const dv = v - other.v;
      matrix[row][column] = kernel(du * du + dv * dv);
    }
    matrix[row][count] = 1;
    matrix[row][count + 1] = u;
    matrix[row][count + 2] = v;
    matrix[count][row] = 1;
    matrix[count + 1][row] = u;
    matrix[count + 2][row] = v;
    right[row] = pairs[row].source[axis];
  }
  return solve(matrix, right);
}

function evaluate(target, pairs, coefficients) {
  const count = pairs.length;
  let value = coefficients[count] + coefficients[count + 1] * target.u + coefficients[count + 2] * target.v;
  for (let index = 0; index < count; index += 1) {
    const du = target.u - pairs[index].target.u;
    const dv = target.v - pairs[index].target.v;
    value += coefficients[index] * kernel(du * du + dv * dv);
  }
  return value;
}

function ensureDistinctAndNonCollinear(pairs) {
  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      const du = pairs[i].target.u - pairs[j].target.u;
      const dv = pairs[i].target.v - pairs[j].target.v;
      if (du * du + dv * dv <= 1e-18) {
        fail(`landmarks ${i + 1} and ${j + 1} have duplicate or nearly duplicate target positions`);
      }
    }
  }
  const [origin, second] = pairs;
  const hasArea = pairs.slice(2).some(({ target }) =>
    Math.abs((second.target.u - origin.target.u) * (target.v - origin.target.v)
      - (second.target.v - origin.target.v) * (target.u - origin.target.u)) > 1e-10);
  if (!hasArea) fail('target landmarks must not be collinear');
}

export function fitLandmarkGrid(pairs, columns = 17, rows = 17) {
  if (!Number.isInteger(columns) || columns < 2 || columns > 64) fail('columns must be an integer from 2 to 64');
  if (!Number.isInteger(rows) || rows < 2 || rows > 64) fail('rows must be an integer from 2 to 64');
  const points = readPairs(pairs);
  ensureDistinctAndNonCollinear(points);
  const uCoefficients = fitAxis(points, 'u');
  const vCoefficients = fitAxis(points, 'v');
  const vertices = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const target = { u: x / (columns - 1), v: y / (rows - 1) };
      vertices.push({ u: evaluate(target, points, uCoefficients), v: evaluate(target, points, vCoefficients) });
    }
  }
  const grid = { columns, rows, points: vertices };
  const validation = validateGrid(grid);
  if (!validation.valid) fail(`landmark alignment creates an invalid grid: ${validation.reason}`);
  return grid;
}

const MIN_SIZE = 2;
const MAX_SIZE = 64;
const MIN_DETERMINANT = 1e-10;

function explain(message) {
  return new RangeError(message);
}

function validDimension(value, name) {
  if (!Number.isInteger(value) || value < MIN_SIZE || value > MAX_SIZE) {
    throw explain(`${name} must be an integer from ${MIN_SIZE} to ${MAX_SIZE}`);
  }
}

function readPoint(point, label = 'point') {
  if (point === null || typeof point !== 'object' ||
      !Number.isFinite(point.u) || !Number.isFinite(point.v)) {
    throw explain(`${label} must contain finite numeric u and v coordinates`);
  }
  return { u: point.u, v: point.v };
}

function gridData(grid) {
  if (grid === null || typeof grid !== 'object') throw explain('grid must be an object');
  validDimension(grid.columns, 'columns');
  validDimension(grid.rows, 'rows');
  if (!Array.isArray(grid.points) || grid.points.length !== grid.columns * grid.rows) {
    throw explain('grid.points must contain one point for every grid vertex');
  }
  const points = [];
  for (let index = 0; index < grid.points.length; index += 1) {
    points.push(readPoint(grid.points[index], `grid.points[${index}]`));
  }
  return { columns: grid.columns, rows: grid.rows, points };
}

function determinant(a, b, c) {
  return (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
}

function pointIndex(columns, x, y) {
  return y * columns + x;
}

function validateData({ columns, rows, points }) {
  for (let y = 0; y < rows - 1; y += 1) {
    for (let x = 0; x < columns - 1; x += 1) {
      const tl = points[pointIndex(columns, x, y)];
      const tr = points[pointIndex(columns, x + 1, y)];
      const br = points[pointIndex(columns, x + 1, y + 1)];
      const bl = points[pointIndex(columns, x, y + 1)];
      const firstDeterminant = determinant(tl, tr, br);
      if (!Number.isFinite(firstDeterminant) || firstDeterminant <= MIN_DETERMINANT) {
        return { valid: false, reason: `cell (${x}, ${y}) triangle TL-TR-BR is collapsed or inverted` };
      }
      const secondDeterminant = determinant(tl, br, bl);
      if (!Number.isFinite(secondDeterminant) || secondDeterminant <= MIN_DETERMINANT) {
        return { valid: false, reason: `cell (${x}, ${y}) triangle TL-BR-BL is collapsed or inverted` };
      }
    }
  }
  return { valid: true };
}

export function createGrid(columns, rows) {
  validDimension(columns, 'columns');
  validDimension(rows, 'rows');
  const points = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      points.push({ u: x / (columns - 1), v: y / (rows - 1) });
    }
  }
  return { columns, rows, points };
}

export function validateGrid(grid) {
  try {
    return validateData(gridData(grid));
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'grid is invalid' };
  }
}

export function moveGridPoint(grid, index, point) {
  const data = gridData(grid);
  if (!Number.isInteger(index) || index < 0 || index >= data.points.length) {
    throw explain('index must refer to an existing grid point');
  }
  const replacement = readPoint(point, 'point');
  const points = data.points.slice();
  points[index] = replacement;
  const moved = { columns: data.columns, rows: data.rows, points };
  const result = validateData(moved);
  if (!result.valid) throw explain(result.reason);
  return moved;
}

export function mapPoint(grid, point) {
  const data = gridData(grid);
  const front = readPoint(point);
  if (front.u < 0 || front.u > 1 || front.v < 0 || front.v > 1) return null;
  const { columns, rows, points } = data;
  const gx = front.u * (columns - 1);
  const gy = front.v * (rows - 1);
  const x = Math.min(Math.floor(gx), columns - 2);
  const y = Math.min(Math.floor(gy), rows - 2);
  const fx = gx - x;
  const fy = gy - y;
  const tl = points[pointIndex(columns, x, y)];
  const tr = points[pointIndex(columns, x + 1, y)];
  const br = points[pointIndex(columns, x + 1, y + 1)];
  const bl = points[pointIndex(columns, x, y + 1)];
  let vertices;
  let weights;
  if (fy <= fx) {
    vertices = [tl, tr, br];
    weights = [1 - fx, fx - fy, fy];
  } else {
    vertices = [tl, br, bl];
    weights = [1 - fy, fx, fy - fx];
  }
  return {
    u: vertices.reduce((sum, p, i) => sum + p.u * weights[i], 0),
    v: vertices.reduce((sum, p, i) => sum + p.v * weights[i], 0),
  };
}

export function isInsideSource(point) {
  return point !== null && typeof point === 'object' &&
    Number.isFinite(point.u) && Number.isFinite(point.v) &&
    point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1;
}

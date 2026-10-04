import { fileURLToPath } from 'node:url';
import { createProject } from '../src/project/model.mjs';

function trainingHeadObj() {
  const rows = 36, columns = 48, lines = ['# Head in Jar practice bust'];
  for (let row = 0; row <= rows; row += 1) {
    const latitude = Math.PI * row / rows;
    const y = Math.cos(latitude);
    const radius = Math.sin(latitude);
    for (let column = 0; column < columns; column += 1) {
      const longitude = 2 * Math.PI * column / columns;
      const x = .78 * radius * Math.sin(longitude);
      const front = Math.cos(longitude);
      const cheek = .72 * radius * front;
      const gaussian = (cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2) / 2);
      const nose = front > 0 ? .23 * gaussian(0, .02, .12, .25) : 0;
      const sockets = front > 0 ? -.055 * (gaussian(-.27, .23, .14, .08) + gaussian(.27, .23, .14, .08)) : 0;
      const lips = front > 0 ? .045 * gaussian(0, -.38, .22, .07) : 0;
      lines.push(`v ${x.toFixed(5)} ${(y * 1.18).toFixed(5)} ${(cheek + nose + sockets + lips).toFixed(5)}`);
    }
  }
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const a = row * columns + column + 1;
    const b = row * columns + (column + 1) % columns + 1;
    const c = (row + 1) * columns + column + 1;
    const d = (row + 1) * columns + (column + 1) % columns + 1;
    lines.push(`f ${a} ${c} ${b}`, `f ${b} ${c} ${d}`);
  }
  return lines.join('\n') + '\n';
}

export function createExampleProject({ id, now }) {
  const project = createProject({ id, name: 'Practice · face projection', now });
  project.mesh = { name: 'practice-head.obj', obj: trainingHeadObj() };
  project.reference = { path: fileURLToPath(new URL('./practice-face.png', import.meta.url)) };
  return project;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createExampleProject } from '../examples/face-example.mjs';
import { validateProject } from '../src/project/model.mjs';

test('bundled practice scene is valid and its image is present', async () => {
  const example = createExampleProject({ id: 'example', now: '2026-10-04T00:00:00.000Z' });
  assert.equal(validateProject(example).valid, true);
  assert.match(example.mesh.obj, /^v /m);
  assert.equal(example.placement.alignment.pairs.length, 0);
  const bytes = await readFile(example.reference.path);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

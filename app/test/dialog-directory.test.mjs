import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDialogDirectoryStore } from '../electron/dialog-directory.mjs';

test('dialog directory persists between store instances and falls back when missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'headinjar-dialog-directory-'));
  try {
    const documents = join(root, 'Documents');
    const home = join(root, 'Home');
    const images = join(root, 'Images');
    const settingsPath = join(root, 'settings', 'file-dialog.json');
    for (const directory of [documents, home, images]) mkdirSync(directory);
    const createStore = () => createDialogDirectoryStore(settingsPath, [documents, home]);

    assert.equal(createStore().get(), documents);
    createStore().set(images);
    assert.equal(createStore().get(), images);
    rmSync(images, { recursive: true });
    assert.equal(createStore().get(), documents);
    rmSync(documents, { recursive: true });
    assert.equal(createStore().get(), home);
    writeFileSync(settingsPath, '{broken json');
    assert.equal(createStore().get(), home);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

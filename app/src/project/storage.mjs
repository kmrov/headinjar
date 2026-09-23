import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseProject, serializeProject, validateProject } from './model.mjs';

async function atomicWrite(filePath, contents) {
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function saveProject(filePath, project) {
  const serialized = serializeProject(project);
  await atomicWrite(filePath, serialized);
}

export async function loadProject(filePath) {
  return parseProject(await readFile(filePath, 'utf8'));
}

export async function writeRecovery(filePath, project) {
  const serialized = serializeProject(project);
  await atomicWrite(`${filePath}.recovery.json`, serialized);
}

export async function loadNewerRecovery(filePath, project) {
  const validation = validateProject(project);
  if (!validation.valid) throw new RangeError(validation.reason);
  let recoveryText;
  try {
    recoveryText = await readFile(`${filePath}.recovery.json`, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const recovery = parseProject(recoveryText);
  if (recovery.id !== project.id || recovery.revision <= project.revision) return null;
  return recovery;
}

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

function existingDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) return false;
  try { return statSync(value).isDirectory(); }
  catch { return false; }
}

export function createDialogDirectoryStore(settingsPath, fallbackDirectories) {
  let lastDirectory = null;
  try {
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (existingDirectory(saved.lastDirectory)) lastDirectory = saved.lastDirectory;
  } catch { /* Missing or invalid settings use a familiar fallback. */ }

  return {
    get() {
      if (existingDirectory(lastDirectory)) return lastDirectory;
      return fallbackDirectories.find(existingDirectory) ?? null;
    },
    set(directory) {
      if (!existingDirectory(directory)) return;
      lastDirectory = directory;
      try {
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({ lastDirectory }), 'utf8');
      } catch { /* File dialogs still work when preferences cannot be written. */ }
    },
  };
}

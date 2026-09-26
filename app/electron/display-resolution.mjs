import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseXrandrDisplays(output) {
  const displays = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const header = /^(\S+)\s+connected(?:\s+primary)?\s+(\d+)x(\d+)([+-]\d+)([+-]\d+)\s/.exec(line);
    if (header) {
      current = {
        name: header[1], width: Number(header[2]), height: Number(header[3]),
        x: Number(header[4]), y: Number(header[5]), id: null,
      };
      displays.push(current);
      continue;
    }
    if (/^\S+\s+(?:connected|disconnected)\b/.test(line)) current = null;
    const identifier = /^\s+Identifier:\s+0x([0-9a-f]+)\s*$/i.exec(line);
    if (current && identifier) current.id = Number.parseInt(identifier[1], 16);
  }
  return displays.filter(({ width, height }) => width > 0 && height > 0 && width <= 16384 && height <= 16384);
}

export async function readXrandrDisplays() {
  if (process.platform !== 'linux') return [];
  try {
    const { stdout } = await execFileAsync('xrandr', ['--verbose', '--current'], {
      encoding: 'utf8', timeout: 1500, maxBuffer: 1024 * 1024,
    });
    return parseXrandrDisplays(stdout);
  } catch {
    return [];
  }
}

export function physicalDisplaySize(display, xrandrDisplays = []) {
  const { width, height } = display.bounds;
  const scale = display.scaleFactor;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(scale)
    || width <= 0 || height <= 0 || scale <= 0) {
    throw new RangeError('Invalid display dimensions');
  }
  const size = { width: Math.round(width * scale), height: Math.round(height * scale) };
  if (size.width < 1 || size.height < 1 || size.width > 16384 || size.height > 16384) {
    throw new RangeError('Invalid display resolution');
  }
  const byId = xrandrDisplays.find((mode) => mode.id === display.id);
  const origin = display.nativeOrigin;
  const byOrigin = origin && xrandrDisplays.find((mode) => mode.x === origin.x && mode.y === origin.y
    && Math.abs(mode.width - size.width) <= 4 && Math.abs(mode.height - size.height) <= 4);
  if (byId || byOrigin) return { width: (byId || byOrigin).width, height: (byId || byOrigin).height };
  return size;
}

export function validateDisplaySelection(display, expectedSize, xrandrDisplays = []) {
  if (!expectedSize || !Number.isInteger(expectedSize.width) || !Number.isInteger(expectedSize.height)
    || expectedSize.width < 1 || expectedSize.height < 1) {
    throw new RangeError('Invalid display selection');
  }
  const actualSize = physicalDisplaySize(display, xrandrDisplays);
  if (actualSize.width !== expectedSize.width || actualSize.height !== expectedSize.height) {
    throw new RangeError('Display resolution changed. Choose the display again.');
  }
  return actualSize;
}

export function outputForDisplay(currentOutput, display, xrandrDisplays = []) {
  return { ...currentOutput, ...physicalDisplaySize(display, xrandrDisplays), displayId: String(display.id) };
}

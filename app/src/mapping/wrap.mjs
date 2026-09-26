export const WRAP_HALF_ANGLE = 5 * Math.PI / 9;
export const WRAP_FADE_START = Math.PI / 2;

export function wrapDomain(position, bounds) {
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  const angle = Math.atan2(position[0] - centerX, position[2] - centerZ);
  if (Math.abs(angle) >= WRAP_HALF_ANGLE) return null;
  return {
    u: 0.5 + angle / (2 * WRAP_HALF_ANGLE),
    v: (bounds.max[1] - position[1]) / Math.max(bounds.max[1] - bounds.min[1], 1e-9),
  };
}

export function wrapFade(angle) {
  return Math.max(0, Math.min(1, (WRAP_HALF_ANGLE - Math.abs(angle)) / (WRAP_HALF_ANGLE - WRAP_FADE_START)));
}

export function movedWrapTransform(original, start, current) {
  return { ...original, x: original.x + current.u - start.u, y: original.y + current.v - start.v };
}

export function rotatedWrapTransform(original, startX, currentX) {
  const angle = original.rotation + (currentX - startX) * 0.5;
  return { ...original, rotation: ((angle + 180) % 360 + 360) % 360 - 180 };
}

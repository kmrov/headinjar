// Keep the central ±80° at the original 200° texture scale. Compress only
// the side strips to reach behind the ears without moving fitted facial UVs.
export const WRAP_HALF_ANGLE = 7 * Math.PI / 9;
export const WRAP_FADE_START = 13 * Math.PI / 18;
export const WRAP_FACE_ANGLE = 4 * Math.PI / 9;
export const WRAP_TEXTURE_HALF_ANGLE = 5 * Math.PI / 9;

export function wrapUFromAngle(angle) {
  const magnitude = Math.abs(angle);
  const mapped = magnitude <= WRAP_FACE_ANGLE ? magnitude
    : WRAP_FACE_ANGLE + (magnitude - WRAP_FACE_ANGLE)
      * (WRAP_TEXTURE_HALF_ANGLE - WRAP_FACE_ANGLE) / (WRAP_HALF_ANGLE - WRAP_FACE_ANGLE);
  return 0.5 + Math.sign(angle) * mapped / (2 * WRAP_TEXTURE_HALF_ANGLE);
}

export function wrapAngleFromU(u) {
  const mapped = (u - 0.5) * 2 * WRAP_TEXTURE_HALF_ANGLE;
  const magnitude = Math.abs(mapped);
  return Math.sign(mapped) * (magnitude <= WRAP_FACE_ANGLE ? magnitude
    : WRAP_FACE_ANGLE + (magnitude - WRAP_FACE_ANGLE)
      * (WRAP_HALF_ANGLE - WRAP_FACE_ANGLE) / (WRAP_TEXTURE_HALF_ANGLE - WRAP_FACE_ANGLE));
}

export function wrapDomain(position, bounds) {
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  const angle = Math.atan2(position[0] - centerX, position[2] - centerZ);
  if (Math.abs(angle) >= WRAP_HALF_ANGLE) return null;
  return {
    u: wrapUFromAngle(angle),
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

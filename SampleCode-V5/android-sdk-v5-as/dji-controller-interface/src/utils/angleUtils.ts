export function normalizeAngleDeg(angle: number): number {
  let result = angle % 360;
  if (result < 0) result += 360;
  return result;
}

export function shortestAngleDiffDeg(a: number, b: number): number {
  let diff = normalizeAngleDeg(a) - normalizeAngleDeg(b);
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

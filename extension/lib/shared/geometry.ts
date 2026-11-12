/**
 * The geometry vocabulary every layer shares: a rectangle, a point and a size
 * in whatever coordinate space the caller states, plus the two numeric helpers
 * the geometry code keeps needing. Dependency-free, at the bottom of lib/.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Rounds to hundredths: stored geometry keeps two decimals. */
export function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Every field finite and the area positive. */
export function isPositiveRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

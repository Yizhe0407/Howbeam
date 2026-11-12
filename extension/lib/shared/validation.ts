import type { Rect } from '@/lib/shared/geometry';
/**
 * Pure validation primitives shared across trust boundaries: runtime messages,
 * cross-frame relays, and persisted state all revalidate structurally because
 * their data crosses a JavaScript context boundary. lib/shared stays
 * dependency-free, so every limit is an explicit argument — domain modules own
 * their own constants and pass them in.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Non-empty string within an explicit length budget. Empty strings fail:
 * every current caller treats absence and empty identically (ids, URLs, error
 * messages), and unbounded strings must never cross a message boundary. */
export function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/** Finite number inside an explicit inclusive range. Callers expressing a
 * magnitude limit pass `(-limit, limit)`; one-sided checks pass 0 or the
 * limit on the closed side. */
export function isFiniteWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** Safe non-negative integer: browser tab/window/request ids and timestamps.
 * Zero is deliberately allowed — request counters start at 0 and Chromium
 * reserves but may surface id 0. */
export function isSafeId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** C0 and C1 control characters: never part of an identifier or a URL. */
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

/** The longest identifier anywhere (steps, projects, sections, masks, edits). */
export const MAX_IDENTIFIER_LENGTH = 256;

/** The one identifier rule: non-empty, bounded, no surrounding space, no control characters. */
export function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTERS.test(value)
  );
}

export interface FiniteRectOptions {
  /** Inclusive bound for |x|, |y|, width, and height. */
  maxMagnitude: number;
  /** Inclusive minimum for width and height. Defaults to strictly positive
   * (zero-sized rects fail), the strictest behavior among existing copies. */
  minSize?: number;
}

/**
 * Structural rect guard for untrusted geometry. Semantics follow the
 * strictest existing hand-rolled validators: every field finite, coordinates
 * bounded by magnitude, and dimensions strictly positive unless the caller
 * asks for a larger minimum size.
 */
export function isFiniteRect(value: unknown, opts: FiniteRectOptions): value is Rect {
  if (!isRecord(value)) return false;
  const { maxMagnitude, minSize } = opts;
  const { x, y, width, height } = value;
  return (
    isFiniteWithin(x, -maxMagnitude, maxMagnitude) &&
    isFiniteWithin(y, -maxMagnitude, maxMagnitude) &&
    isFiniteWithin(width, -maxMagnitude, maxMagnitude) &&
    isFiniteWithin(height, -maxMagnitude, maxMagnitude) &&
    width > 0 &&
    height > 0 &&
    (minSize === undefined || (width >= minSize && height >= minSize))
  );
}

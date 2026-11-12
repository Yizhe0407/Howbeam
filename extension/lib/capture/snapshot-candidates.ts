import { clamp } from '../shared/geometry';
/**
 * Pure ordering/dedup logic for snapshot-mode keyboard candidate traversal
 * (UX_PLAN §9.5). The DOM-dependent collection lives in the content script;
 * this module keeps the geometry decisions unit-testable.
 */

/** A viewport-space candidate rect plus its accessible label. */
export interface RawKeyboardCandidate {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

/** A resolved keyboard anchor: the point handed to the existing probe engine. */
export interface KeyboardAnchor {
  x: number;
  y: number;
  label: string;
}

/** Ceiling on the traversable list so huge pages cannot stall startup (§9.5). */
export const KEYBOARD_CANDIDATE_LIMIT = 150;

/** Same-row tolerance (px) so a ragged baseline still reads left-to-right. */
const ROW_BAND = 12;

/**
 * Orders candidates in reading order (top-to-bottom, then left-to-right),
 * drops off-viewport or zero-area rects, dedupes coincident anchors, and caps
 * the result. Anchors are the rect centre clamped one pixel inside the
 * viewport so `elementFromPoint` still resolves them.
 */
export function orderKeyboardCandidates(
  candidates: readonly RawKeyboardCandidate[],
  viewportWidth: number,
  viewportHeight: number,
  limit: number = KEYBOARD_CANDIDATE_LIMIT,
): KeyboardAnchor[] {
  const visible = candidates.filter(
    (candidate) =>
      candidate.width > 0 &&
      candidate.height > 0 &&
      candidate.x < viewportWidth &&
      candidate.y < viewportHeight &&
      candidate.x + candidate.width > 0 &&
      candidate.y + candidate.height > 0,
  );

  const anchored = visible.map((candidate) => ({
    x: clamp(candidate.x + candidate.width / 2, 1, Math.max(1, viewportWidth - 1)),
    y: clamp(candidate.y + candidate.height / 2, 1, Math.max(1, viewportHeight - 1)),
    label: candidate.label,
  }));

  anchored.sort((a, b) => {
    if (Math.abs(a.y - b.y) > ROW_BAND) return a.y - b.y;
    return a.x - b.x;
  });

  const seen = new Set<string>();
  const ordered: KeyboardAnchor[] = [];
  for (const anchor of anchored) {
    const key = `${Math.round(anchor.x)}:${Math.round(anchor.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(anchor);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

/**
 * Advances a roving index with wrap-around. Returns -1 when there is nothing
 * to traverse so callers can distinguish "no candidates" from a real index.
 */
export function nextCandidateIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : total - 1;
  return (((current + delta) % total) + total) % total;
}

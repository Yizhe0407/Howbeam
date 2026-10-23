import { describe, expect, it } from 'vitest';
import {
  KEYBOARD_CANDIDATE_LIMIT,
  nextCandidateIndex,
  orderKeyboardCandidates,
  type RawKeyboardCandidate,
} from '@/lib/capture/snapshot-candidates';
import { itemAt } from '../setup/item-at';

function rect(x: number, y: number, width = 20, height = 20, label = ''): RawKeyboardCandidate {
  return { x, y, width, height, label: label || `${x},${y}` };
}

describe('orderKeyboardCandidates', () => {
  it('orders top-to-bottom then left-to-right', () => {
    const anchors = orderKeyboardCandidates(
      [rect(200, 0, 20, 20, 'a'), rect(10, 0, 20, 20, 'b'), rect(0, 100, 20, 20, 'c')],
      1000,
      1000,
    );
    expect(anchors.map((anchor) => anchor.label)).toEqual(['b', 'a', 'c']);
  });

  it('treats near-equal rows as one band and sorts them by x', () => {
    // 5px apart vertically < ROW_BAND, so x decides order despite the y jitter.
    const anchors = orderKeyboardCandidates([rect(100, 5, 20, 20, 'right'), rect(10, 0, 20, 20, 'left')], 1000, 1000);
    expect(anchors.map((anchor) => anchor.label)).toEqual(['left', 'right']);
  });

  it('drops rects outside the viewport and zero-area rects', () => {
    const anchors = orderKeyboardCandidates(
      [rect(-50, 10, 20, 20, 'offleft'), rect(10, 10, 0, 20, 'zero'), rect(10, 10, 20, 20, 'ok')],
      800,
      600,
    );
    expect(anchors.map((anchor) => anchor.label)).toEqual(['ok']);
  });

  it('clamps anchor centres one pixel inside the viewport', () => {
    const anchor = itemAt(orderKeyboardCandidates([rect(790, 590, 40, 40, 'edge')], 800, 600), 0);
    expect(anchor.x).toBeLessThanOrEqual(799);
    expect(anchor.y).toBeLessThanOrEqual(599);
    expect(anchor.x).toBeGreaterThanOrEqual(1);
  });

  it('dedupes coincident anchors', () => {
    const anchors = orderKeyboardCandidates([rect(10, 10, 20, 20, 'a'), rect(10, 10, 20, 20, 'b')], 800, 600);
    expect(anchors).toHaveLength(1);
  });

  it('caps the list length', () => {
    const many = Array.from({ length: KEYBOARD_CANDIDATE_LIMIT + 50 }, (_, i) => rect(0, i * 30, 20, 20, `n${i}`));
    expect(orderKeyboardCandidates(many, 800, 100_000)).toHaveLength(KEYBOARD_CANDIDATE_LIMIT);
  });
});

describe('nextCandidateIndex', () => {
  it('returns -1 when there is nothing to traverse', () => {
    expect(nextCandidateIndex(0, 0, 1)).toBe(-1);
  });

  it('seeds from either end on the first move', () => {
    expect(nextCandidateIndex(-1, 3, 1)).toBe(0);
    expect(nextCandidateIndex(-1, 3, -1)).toBe(2);
  });

  it('wraps forward and backward', () => {
    expect(nextCandidateIndex(2, 3, 1)).toBe(0);
    expect(nextCandidateIndex(0, 3, -1)).toBe(2);
    expect(nextCandidateIndex(1, 3, 1)).toBe(2);
  });
});

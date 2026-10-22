import { describe, expect, it } from 'vitest';
import { balancedColumnHeight, chooseAnnotationColumns, fillColumns } from '@/lib/export/annotation-columns';

describe('fillColumns', () => {
  it('fills each column up to the capacity, in order', () => {
    expect(fillColumns([1, 1, 2, 1, 1], 2, 3)).toEqual({ count: 4, starts: [0, 2] });
  });

  it('places nothing when the first item is taller than the capacity', () => {
    expect(fillColumns([4, 1], 3, 3)).toEqual({ count: 0, starts: [] });
  });
});

describe('balancedColumnHeight', () => {
  it('finds the shortest height that takes every item', () => {
    expect(balancedColumnHeight([1, 1, 1, 1], 2)).toBe(2);
    expect(balancedColumnHeight([2, 1, 1, 1, 1], 2)).toBe(3);
    expect(balancedColumnHeight([5, 1, 1], 3)).toBe(5);
    expect(balancedColumnHeight([], 2)).toBe(0);
  });
});

describe('chooseAnnotationColumns', () => {
  /** `lengths` in characters, wrapped into columns of 30, 14 and 9 characters. */
  const layout = (lengths: number[]) => chooseAnnotationColumns(
    (columns) => lengths.map((length) => Array.from({ length: Math.max(1, Math.ceil(length / [30, 14, 9][columns - 1])) }, () => 'line')),
    (lines) => lines,
  );
  const choose = (lengths: number[]) => layout(lengths).columns;
  const short = (count: number) => Array.from({ length: count }, () => 4);

  it('takes the column count that makes the list shortest', () => {
    expect(choose(Array.from({ length: 12 }, () => 8))).toBe(3);
    expect(choose(Array.from({ length: 12 }, () => 12))).toBe(2);
  });

  it('lets a marker wrap to two lines in its column', () => {
    const result = layout([...short(7), 20]);

    expect(result.columns).toBe(2);
    expect(result.lines[7]).toHaveLength(2);
    expect(result.spans.some(Boolean)).toBe(false);
  });

  it('runs a marker that would need more than two lines in a column across the full width', () => {
    const result = layout([...short(9), 40]);

    expect(result.columns).toBe(3);
    expect(result.spans).toEqual([...Array.from({ length: 9 }, () => false), true]);
    // Its lines are the full-width ones.
    expect(result.lines[9]).toHaveLength(2);
  });

  it('balances the markers on each side of a spanning one by themselves', () => {
    const result = layout([...short(4), 40, ...short(4)]);

    // Two columns: two rows, the spanning marker, two rows. A third column would save nothing.
    expect(result.columns).toBe(2);
    expect(result.spans.indexOf(true)).toBe(4);
  });

  it('runs a stretch between long markers too short for two rows of columns across the full width too', () => {
    const result = layout([...short(3), 40, ...short(4)]);

    expect(result.columns).toBe(2);
    expect(result.spans).toEqual([true, true, true, true, false, false, false, false]);
  });

  it('gives every column at least two markers', () => {
    expect(choose([4, 4, 4])).toBe(1);
    expect(choose([4, 4, 4, 4, 4])).toBe(2);
  });

  it('prefers fewer columns when more would not make the list at least two lines shorter', () => {
    expect(choose([10, 5, 10, 5, 10, 5])).toBe(2);
    // Three columns would be one line shorter, at the cost of wrapping the first marker.
    expect(choose([10, 4, 4, 4, 4, 4, 4, 4, 4])).toBe(2);
  });
});

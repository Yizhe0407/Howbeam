import { describe, expect, it } from 'vitest';
import { isBoundedString, isFiniteRect, isFiniteWithin, isRecord, isSafeId } from '@/lib/shared/validation';

describe('isRecord', () => {
  it('accepts plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('rejects null, arrays, and primitives', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

describe('isBoundedString', () => {
  it('accepts non-empty strings up to the limit', () => {
    expect(isBoundedString('a', 1)).toBe(true);
    expect(isBoundedString('abc', 3)).toBe(true);
  });

  it('rejects empty, oversized, and non-string values', () => {
    expect(isBoundedString('', 10)).toBe(false);
    expect(isBoundedString('abcd', 3)).toBe(false);
    expect(isBoundedString(1, 10)).toBe(false);
    expect(isBoundedString(undefined, 10)).toBe(false);
    expect(isBoundedString(null, 10)).toBe(false);
  });
});

describe('isFiniteWithin', () => {
  it('accepts finite numbers inside the inclusive range', () => {
    expect(isFiniteWithin(0, -10, 10)).toBe(true);
    expect(isFiniteWithin(-10, -10, 10)).toBe(true);
    expect(isFiniteWithin(10, -10, 10)).toBe(true);
    expect(isFiniteWithin(0.5, 0, 1)).toBe(true);
  });

  it('rejects out-of-range, non-finite, and non-number values', () => {
    expect(isFiniteWithin(11, -10, 10)).toBe(false);
    expect(isFiniteWithin(-11, -10, 10)).toBe(false);
    expect(isFiniteWithin(Number.NaN, -10, 10)).toBe(false);
    expect(isFiniteWithin(Number.POSITIVE_INFINITY, -10, 10)).toBe(false);
    expect(isFiniteWithin(Number.NEGATIVE_INFINITY, -10, 10)).toBe(false);
    expect(isFiniteWithin('5', -10, 10)).toBe(false);
    expect(isFiniteWithin(null, -10, 10)).toBe(false);
  });
});

describe('isSafeId', () => {
  it('accepts safe non-negative integers, including zero', () => {
    expect(isSafeId(0)).toBe(true);
    expect(isSafeId(42)).toBe(true);
    expect(isSafeId(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('rejects negatives, fractions, unsafe magnitudes, and non-numbers', () => {
    expect(isSafeId(-1)).toBe(false);
    expect(isSafeId(1.5)).toBe(false);
    expect(isSafeId(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isSafeId(Number.NaN)).toBe(false);
    expect(isSafeId('7')).toBe(false);
    expect(isSafeId(null)).toBe(false);
  });
});

describe('isFiniteRect', () => {
  const opts = { maxMagnitude: 1_000_000 };

  it('accepts a strictly positive rect within magnitude', () => {
    expect(isFiniteRect({ x: 0, y: 0, width: 10, height: 10 }, opts)).toBe(true);
    expect(isFiniteRect({ x: -1_000_000, y: 1_000_000, width: 0.5, height: 1_000_000 }, opts)).toBe(true);
  });

  it('rejects non-record values', () => {
    expect(isFiniteRect(null, opts)).toBe(false);
    expect(isFiniteRect([], opts)).toBe(false);
    expect(isFiniteRect('rect', opts)).toBe(false);
  });

  it('rejects missing or non-finite fields', () => {
    expect(isFiniteRect({ x: 0, y: 0, width: 10 }, opts)).toBe(false);
    expect(isFiniteRect({ x: Number.NaN, y: 0, width: 10, height: 10 }, opts)).toBe(false);
    expect(isFiniteRect({ x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 }, opts)).toBe(false);
    expect(isFiniteRect({ x: 0, y: 0, width: '10', height: 10 }, opts)).toBe(false);
  });

  it('rejects zero-sized and negative-sized rects by default', () => {
    expect(isFiniteRect({ x: 0, y: 0, width: 0, height: 10 }, opts)).toBe(false);
    expect(isFiniteRect({ x: 0, y: 0, width: 10, height: 0 }, opts)).toBe(false);
    expect(isFiniteRect({ x: 0, y: 0, width: -5, height: 10 }, opts)).toBe(false);
  });

  it('rejects coordinates or dimensions beyond the magnitude limit', () => {
    expect(isFiniteRect({ x: 1_000_001, y: 0, width: 10, height: 10 }, opts)).toBe(false);
    expect(isFiniteRect({ x: 0, y: -1_000_001, width: 10, height: 10 }, opts)).toBe(false);
    expect(isFiniteRect({ x: 0, y: 0, width: 1_000_001, height: 10 }, opts)).toBe(false);
    expect(isFiniteRect({ x: 0, y: 0, width: 10, height: 1_000_001 }, opts)).toBe(false);
  });

  it('enforces the optional minimum size on both dimensions', () => {
    const sized = { maxMagnitude: 1_000_000, minSize: 8 };
    expect(isFiniteRect({ x: 0, y: 0, width: 8, height: 8 }, sized)).toBe(true);
    expect(isFiniteRect({ x: 0, y: 0, width: 7.9, height: 8 }, sized)).toBe(false);
    expect(isFiniteRect({ x: 0, y: 0, width: 8, height: 7 }, sized)).toBe(false);
  });
});

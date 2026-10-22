// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSY_DELAY_MS, BUSY_MIN_SHOWN_MS, useDeferredBusy } from '@/lib/shared/use-deferred-busy';

describe('useDeferredBusy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  it('stays hidden for work that finishes within the delay', () => {
    const { result, rerender } = renderHook(({ active }) => useDeferredBusy(active), { initialProps: { active: false } });
    rerender({ active: true });
    advance(BUSY_DELAY_MS - 1);
    rerender({ active: false });
    advance(BUSY_MIN_SHOWN_MS * 2);
    expect(result.current).toBe(false);
  });

  it('shows after the delay and holds for the minimum time', () => {
    const { result, rerender } = renderHook(({ active }) => useDeferredBusy(active), { initialProps: { active: false } });
    rerender({ active: true });
    expect(result.current).toBe(false);
    advance(BUSY_DELAY_MS);
    expect(result.current).toBe(true);

    advance(100);
    rerender({ active: false });
    advance(BUSY_MIN_SHOWN_MS - 101);
    expect(result.current).toBe(true);
    advance(1);
    expect(result.current).toBe(false);
  });

  it('hides at once when the minimum time has already passed', () => {
    const { result, rerender } = renderHook(({ active }) => useDeferredBusy(active), { initialProps: { active: false } });
    rerender({ active: true });
    advance(BUSY_DELAY_MS + BUSY_MIN_SHOWN_MS);
    rerender({ active: false });
    advance(0);
    expect(result.current).toBe(false);
  });

  it('also waits for work that was already running when it mounted', () => {
    const { result } = renderHook(() => useDeferredBusy(true));
    expect(result.current).toBe(false);
    advance(BUSY_DELAY_MS);
    expect(result.current).toBe(true);
  });

  it('keeps showing when work resumes before it hid', () => {
    const { result, rerender } = renderHook(({ active }) => useDeferredBusy(active), { initialProps: { active: false } });
    rerender({ active: true });
    advance(BUSY_DELAY_MS);
    rerender({ active: false });
    advance(100);
    rerender({ active: true });
    advance(BUSY_MIN_SHOWN_MS * 2);
    expect(result.current).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  childFrameProbeTimeout,
  classifyFrameProbeOutcome,
  createFrameProbeRateLimiter,
  createLatestAsyncRequestRunner,
  isExplicitFrameProbeFallback,
  resolveFrameProbeTargetOrigin,
} from '@/lib/capture/frame-probe';

describe('classifyFrameProbeOutcome', () => {
  it('falls back only for transport timeout or an explicit fallback response', () => {
    expect(classifyFrameProbeOutcome(null, true)).toEqual({ kind: 'fallback' });
    expect(classifyFrameProbeOutcome(null, false)).toEqual({ kind: 'empty' });
    expect(classifyFrameProbeOutcome({ id: 'button' }, false)).toEqual({
      kind: 'target',
      target: { id: 'button' },
    });
    expect(isExplicitFrameProbeFallback({ fallback: true })).toBe(true);
    expect(isExplicitFrameProbeFallback({ fallback: false })).toBe(false);
    expect(isExplicitFrameProbeFallback({ target: null })).toBe(false);
    expect(isExplicitFrameProbeFallback(null)).toBe(false);
  });
});

describe('resolveFrameProbeTargetOrigin', () => {
  const baseUrl = 'https://parent.example/path/page';

  it.each([
    [null, { hasSrcdoc: false, opaqueSandbox: false }, 'https://parent.example'],
    ['', { hasSrcdoc: false, opaqueSandbox: false }, 'https://parent.example'],
    ['about:blank', { hasSrcdoc: false, opaqueSandbox: false }, 'https://parent.example'],
    ['/child', { hasSrcdoc: false, opaqueSandbox: false }, 'https://parent.example'],
    ['https://child.example/frame', { hasSrcdoc: false, opaqueSandbox: false }, 'https://child.example'],
    ['blob:https://child.example/id', { hasSrcdoc: false, opaqueSandbox: false }, 'https://child.example'],
    ['https://ignored.example', { hasSrcdoc: true, opaqueSandbox: false }, 'https://parent.example'],
  ] as const)('derives a specific origin for addressable frames %#', (source, options, expected) => {
    expect(resolveFrameProbeTargetOrigin(source, baseUrl, options)).toBe(expected);
  });

  it.each([
    ['data:text/html,hello', { hasSrcdoc: false, opaqueSandbox: false }],
    ['javascript:void 0', { hasSrcdoc: false, opaqueSandbox: false }],
    ['https://child.example', { hasSrcdoc: false, opaqueSandbox: true }],
  ] as const)('fails closed for an opaque or unsafe frame %#', (source, options) => {
    expect(resolveFrameProbeTargetOrigin(source, baseUrl, options)).toBeNull();
  });
});

describe('frame probe nesting budget', () => {
  it('subtracts a child margin and terminates deep nesting at zero', () => {
    let timeout = 120;
    const observed = [timeout];
    while (timeout > 0) {
      timeout = childFrameProbeTimeout(timeout, 20);
      observed.push(timeout);
    }
    expect(observed).toEqual([120, 100, 80, 60, 40, 20, 0]);
    expect(childFrameProbeTimeout(10, 20)).toBe(0);
  });

  it('rejects invalid deadlines instead of propagating NaN or negative values', () => {
    expect(() => childFrameProbeTimeout(Number.NaN, 20)).toThrow(TypeError);
    expect(() => childFrameProbeTimeout(-1, 20)).toThrow(TypeError);
    expect(() => childFrameProbeTimeout(20, -1)).toThrow(TypeError);
  });
});

describe('createFrameProbeRateLimiter', () => {
  it('bounds concurrent work and releases permits idempotently', () => {
    const limiter = createFrameProbeRateLimiter({
      maxConcurrent: 2,
      maxRequestsPerWindow: 10,
      windowMs: 1_000,
      now: () => 0,
    });
    const releaseFirst = limiter.tryAcquire();
    const releaseSecond = limiter.tryAcquire();
    expect(releaseFirst).toBeTypeOf('function');
    expect(releaseSecond).toBeTypeOf('function');
    expect(limiter.tryAcquire()).toBeNull();
    releaseFirst?.();
    releaseFirst?.();
    expect(limiter.tryAcquire()).toBeTypeOf('function');
  });

  it('never exceeds concurrency during recursive deferred work', async () => {
    const limiter = createFrameProbeRateLimiter({
      maxConcurrent: 3,
      maxRequestsPerWindow: 1_000,
      windowMs: 10_000,
      now: () => 0,
    });
    let active = 0;
    let peak = 0;
    let rejected = 0;

    const visit = async (depth: number): Promise<void> => {
      const release = limiter.tryAcquire();
      if (!release) {
        rejected += 1;
        return;
      }
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      if (depth > 0) await Promise.all([visit(depth - 1), visit(depth - 1), visit(depth - 1)]);
      active -= 1;
      release();
    };

    await visit(5);
    expect(peak).toBe(3);
    expect(rejected).toBeGreaterThan(0);
    expect(active).toBe(0);
    expect(limiter.tryAcquire()).toBeTypeOf('function');
  });

  it('enforces the request budget, renews on rollover, and resets after clock rollback', () => {
    let now = 1_000;
    const limiter = createFrameProbeRateLimiter({
      maxConcurrent: 5,
      maxRequestsPerWindow: 2,
      windowMs: 1_000,
      now: () => now,
    });
    limiter.tryAcquire()?.();
    limiter.tryAcquire()?.();
    expect(limiter.tryAcquire()).toBeNull();
    now = 2_000;
    expect(limiter.tryAcquire()).toBeTypeOf('function');
    now = 500;
    expect(limiter.tryAcquire()).toBeTypeOf('function');
  });

  it('rejects invalid limits', () => {
    expect(() => createFrameProbeRateLimiter({ maxConcurrent: 0, maxRequestsPerWindow: 1, windowMs: 1 })).toThrow(
      TypeError,
    );
  });
});

describe('createLatestAsyncRequestRunner', () => {
  it('coalesces 240 Hz input into one active probe and only the latest pending point', async () => {
    const seen: number[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const runner = createLatestAsyncRequestRunner<number>(async (value) => {
      seen.push(value);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    });

    for (let point = 0; point < 240; point += 1) runner.submit(point);
    expect(seen).toEqual([0]);
    expect(runner.isRunning()).toBe(true);

    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([0, 239]);
    expect(peak).toBe(1);

    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.isRunning()).toBe(false);
  });

  it('drops pending work on cleanup and continues after worker rejection', async () => {
    const seen: number[] = [];
    let release!: () => void;
    const errors: unknown[] = [];
    const runner = createLatestAsyncRequestRunner<number>(
      async (value) => {
        seen.push(value);
        if (value === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        else throw new Error('probe failed');
      },
      (error) => errors.push(error),
    );

    runner.submit(1);
    runner.submit(2);
    runner.clearPending();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([1]);

    runner.submit(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
    expect(runner.isRunning()).toBe(false);
  });
});

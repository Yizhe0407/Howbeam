export type FrameProbeOutcome<T> = { kind: 'target'; target: T } | { kind: 'empty' } | { kind: 'fallback' };

/** A responsive child returning null is a valid empty hit, not evidence that
 * instrumentation is unavailable. Only transport timeout permits fallback. */
export function classifyFrameProbeOutcome<T>(target: T | null, timedOut: boolean): FrameProbeOutcome<T> {
  if (timedOut) return { kind: 'fallback' };
  return target === null ? { kind: 'empty' } : { kind: 'target', target };
}

/** postMessage must never use "*" for frame probes because the request carries
 * run-scoped context. Opaque sandbox/data frames cannot be addressed safely,
 * so callers should fail closed and select the visible iframe itself. */
export function resolveFrameProbeTargetOrigin(
  source: string | null,
  baseUrl: string,
  options: { hasSrcdoc: boolean; opaqueSandbox: boolean },
): string | null {
  if (options.opaqueSandbox) return null;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (base.origin === 'null') return null;
  if (options.hasSrcdoc || !source?.trim()) return base.origin;

  let target: URL;
  try {
    target = new URL(source, base);
  } catch {
    return null;
  }
  if (target.href === 'about:blank') return base.origin;
  if (target.protocol === 'http:' || target.protocol === 'https:' || target.protocol === 'blob:') {
    return target.origin === 'null' ? null : target.origin;
  }
  return null;
}

export interface FrameProbeRateLimiterOptions {
  maxConcurrent: number;
  maxRequestsPerWindow: number;
  windowMs: number;
  now?: () => number;
}

export interface FrameProbeRateLimiter {
  /** Returns an idempotent release callback, or null when the request budget is
   * exhausted. A request consumes budget even when its later work fails. */
  tryAcquire(): (() => void) | null;
}

/** Closing a transferred MessagePort can throw when the sender already
 * detached or closed it before validation completed; that failure is benign
 * for every relay/probe path. */
export function closePortQuietly(port: MessagePort | undefined): void {
  try {
    port?.close();
  } catch {
    // The sender can detach a transferred port before validation completes.
  }
}

/** Fixed-window admission control for one child-frame content-script instance.
 * Concurrency bounds expensive recursive probing, while the request window
 * prevents a host page that learned the run token from flooding MessagePorts. */
export function createFrameProbeRateLimiter(options: FrameProbeRateLimiterOptions): FrameProbeRateLimiter {
  if (
    !Number.isSafeInteger(options.maxConcurrent) ||
    options.maxConcurrent <= 0 ||
    !Number.isSafeInteger(options.maxRequestsPerWindow) ||
    options.maxRequestsPerWindow <= 0 ||
    !Number.isFinite(options.windowMs) ||
    options.windowMs <= 0
  ) {
    throw new TypeError('Frame probe rate-limit options must be positive finite values.');
  }
  const now = options.now ?? Date.now;
  let windowStartedAt = now();
  let requestsInWindow = 0;
  let activeRequests = 0;

  const resetWindowIfNeeded = (timestamp: number) => {
    if (timestamp < windowStartedAt || timestamp - windowStartedAt >= options.windowMs) {
      windowStartedAt = timestamp;
      requestsInWindow = 0;
    }
  };

  return {
    tryAcquire() {
      const timestamp = now();
      resetWindowIfNeeded(timestamp);
      if (activeRequests >= options.maxConcurrent || requestsInWindow >= options.maxRequestsPerWindow) {
        return null;
      }
      activeRequests += 1;
      requestsInWindow += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeRequests = Math.max(0, activeRequests - 1);
      };
    },
  };
}

/** Reserves a small transport/processing margin at every nesting level. A zero
 * result is terminal: callers must select the visible iframe instead of opening
 * another MessageChannel with an already exhausted deadline. */
export function childFrameProbeTimeout(parentTimeoutMs: number, childBudgetMs: number): number {
  if (
    !Number.isFinite(parentTimeoutMs) ||
    parentTimeoutMs < 0 ||
    !Number.isFinite(childBudgetMs) ||
    childBudgetMs < 0
  ) {
    throw new TypeError('Frame probe timeouts must be finite non-negative values.');
  }
  return Math.max(0, parentTimeoutMs - childBudgetMs);
}

export function isExplicitFrameProbeFallback(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { fallback?: unknown }).fallback === true);
}

export interface LatestAsyncRequestRunner<T> {
  /** Starts immediately when idle; while busy, replaces the pending item so
   * high-frequency pointer input cannot create an unbounded async backlog. */
  submit(value: T): void;
  clearPending(): void;
  /** @internal Test-only: observes the busy flag to assert coalescing. No
   * production caller branches on it. */
  isRunning(): boolean;
}

export function createLatestAsyncRequestRunner<T>(
  worker: (value: T) => void | Promise<void>,
  onError: (error: unknown) => void = () => undefined,
): LatestAsyncRequestRunner<T> {
  let running = false;
  let hasPending = false;
  let pending!: T;

  const drain = async () => {
    if (running || !hasPending) return;
    const value = pending;
    hasPending = false;
    running = true;
    try {
      await worker(value);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (hasPending) void drain();
    }
  };

  return {
    submit(value) {
      pending = value;
      hasPending = true;
      void drain();
    },
    clearPending() {
      hasPending = false;
    },
    isRunning() {
      return running;
    },
  };
}

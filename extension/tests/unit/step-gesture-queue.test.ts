import { describe, expect, it } from 'vitest';
import { createStepGestureQueue, type StepGesture } from '@/lib/capture/step-gesture-queue';
import { itemAt } from '../setup/item-at';

/** A start() the test fully controls: resolves only when the test calls
 *  `finish()`, and records every lifecycle event into the shared `log`. */
function createControlledEntry(id: string, log: string[]) {
  let resolveStart!: () => void;
  let gestureRef!: StepGesture;
  const started = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  return {
    entry: {
      captureId: id,
      onSkipped: () => log.push(`${id}:skipped`),
      start: (gesture: StepGesture): Promise<void> => {
        gestureRef = gesture;
        log.push(`${id}:start`);
        return started;
      },
    },
    /** Mirrors calling `endGesture()` (release) before the wrapping promise settles. */
    release: () => {
      log.push(`${id}:release`);
      gestureRef.release();
    },
    finish: () => resolveStart(),
    gesture: () => gestureRef,
  };
}

describe('createStepGestureQueue', () => {
  it('queues a second entry that arrives while one is running instead of dropping it', async () => {
    const log: string[] = [];
    const queue = createStepGestureQueue();
    const a = createControlledEntry('a', log);
    const b = createControlledEntry('b', log);

    queue.enqueue(a.entry);
    expect(log).toEqual(['a:start']);
    expect(queue.pendingCount()).toBe(0);

    queue.enqueue(b.entry);
    // b must not start while a is still running, and must not be dropped.
    expect(log).toEqual(['a:start']);
    expect(queue.pendingCount()).toBe(1);
    expect(queue.isBusy()).toBe(true);

    a.release();
    a.finish();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['a:start', 'a:release', 'b:start']);
    expect(queue.pendingCount()).toBe(0);
  });

  it('drains a backlog in strict arrival order regardless of outcome', async () => {
    const log: string[] = [];
    const queue = createStepGestureQueue();
    const entries = ['a', 'b', 'c'].map((id) => createControlledEntry(id, log));

    for (const e of entries) queue.enqueue(e.entry);
    expect(log).toEqual(['a:start']);

    itemAt(entries, 0).release();
    itemAt(entries, 0).finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['a:start', 'a:release', 'b:start']);

    itemAt(entries, 1).release();
    itemAt(entries, 1).finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['a:start', 'a:release', 'b:start', 'b:release', 'c:start']);

    itemAt(entries, 2).release();
    itemAt(entries, 2).finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.isBusy()).toBe(false);
  });

  it('skips an entry whose validate() fails at its turn, without ever calling start', async () => {
    const log: string[] = [];
    const queue = createStepGestureQueue();
    const a = createControlledEntry('a', log);
    let bShouldRun = false;
    const b = createControlledEntry('b', log);

    queue.enqueue(a.entry);
    queue.enqueue({ ...b.entry, validate: () => bShouldRun });

    a.release();
    a.finish();
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toEqual(['a:start', 'a:release', 'b:skipped']);
    expect(queue.isBusy()).toBe(false);

    // A fresh entry with the same id, now allowed through, proves the queue
    // itself is not stuck after a skip.
    bShouldRun = true;
    const c = createControlledEntry('c', log);
    queue.enqueue(c.entry);
    expect(log).toContain('c:start');
  });

  it('cancelActive() only affects the running gesture, never queued ones', () => {
    const log: string[] = [];
    const queue = createStepGestureQueue();
    const a = createControlledEntry('a', log);
    const b = createControlledEntry('b', log);
    queue.enqueue(a.entry);
    queue.enqueue(b.entry);

    queue.cancelActive();
    expect(a.gesture().isCancelled()).toBe(true);

    // b never started, so it has no gesture yet to be cancelled — it must
    // still be sitting untouched in the backlog.
    expect(queue.pendingCount()).toBe(1);
  });

  it('purgePending() drops queued entries via onSkipped without touching the active one', () => {
    const log: string[] = [];
    const queue = createStepGestureQueue();
    const a = createControlledEntry('a', log);
    const b = createControlledEntry('b', log);
    const c = createControlledEntry('c', log);
    queue.enqueue(a.entry);
    queue.enqueue(b.entry);
    queue.enqueue(c.entry);

    queue.purgePending();

    expect(log).toEqual(['a:start', 'b:skipped', 'c:skipped']);
    expect(queue.pendingCount()).toBe(0);
    expect(a.gesture().isCancelled()).toBe(false);
    expect(queue.isBusy()).toBe(true);
  });

  it('isBusy() drops as soon as the active gesture releases, even before its own promise settles, so nothing downstream mistakes it for still blocking', async () => {
    const log: string[] = [];
    const queue = createStepGestureQueue();
    const a = createControlledEntry('a', log);
    queue.enqueue(a.entry);
    expect(queue.isBusy()).toBe(true);

    a.release();
    // Still "running" (the promise has not settled), but no longer "blocking".
    expect(queue.isBusy()).toBe(false);

    // A new arrival in this window must still queue, not run immediately —
    // draining the next entry has to wait for a.finish()'s full settlement so
    // two gestures' shared scroll-lock/preview state never overlaps.
    const b = createControlledEntry('b', log);
    queue.enqueue(b.entry);
    expect(log).not.toContain('b:start');

    a.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toContain('b:start');
  });

  it('cancelAll() cancels the active gesture and purges the backlog', () => {
    const log: string[] = [];
    const queue = createStepGestureQueue();
    const a = createControlledEntry('a', log);
    const b = createControlledEntry('b', log);
    queue.enqueue(a.entry);
    queue.enqueue(b.entry);

    queue.cancelAll();

    expect(a.gesture().isCancelled()).toBe(true);
    expect(log).toContain('b:skipped');
    expect(queue.pendingCount()).toBe(0);
  });
});

describe('whenIdle', () => {
  it('resolves immediately when nothing is queued', async () => {
    await expect(createStepGestureQueue().whenIdle()).resolves.toBeUndefined();
  });

  it('waits for every accepted gesture to settle, replay included, before a toolbar command runs', async () => {
    const queue = createStepGestureQueue();
    const log: string[] = [];
    const a = createControlledEntry('a', log);
    const b = createControlledEntry('b', log);
    queue.enqueue(a.entry);
    queue.enqueue(b.entry);
    void queue.whenIdle().then(() => log.push('idle'));

    a.release();
    a.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).not.toContain('idle');

    b.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log[log.length - 1]).toBe('idle');
  });

  it('resolves once purged entries are skipped', async () => {
    const queue = createStepGestureQueue();
    const log: string[] = [];
    const a = createControlledEntry('a', log);
    queue.enqueue(a.entry);
    queue.enqueue(createControlledEntry('b', log).entry);
    const idle = queue.whenIdle();
    queue.purgePending();
    a.finish();
    await idle;
    expect(log).toContain('b:skipped');
  });
});

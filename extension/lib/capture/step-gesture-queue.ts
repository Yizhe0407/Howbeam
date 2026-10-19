/** FIFO queue for step-mode gestures, so a trusted press that arrives while
 * the previous step's screenshot is still in flight is queued instead of
 * silently dropped. Deliberately serial: only one entry's `start` ever runs
 * at a time, and the next one is not pulled until that promise fully settles
 * (including whatever replay/cleanup it does), so the `HOWBEAM_CLICK`
 * messages this drives always reach the background in the user's real click
 * order — see step-repository.ts's read-then-write `order` computation,
 * which depends on that ordering being preserved. */

const QUEUE_DEPTH_WARN_THRESHOLD = 5;

export interface StepGesture {
  readonly captureId: string;
  readonly isCancelled: () => boolean;
  readonly cancelled: Promise<void>;
  cancel(): void;
  /**
   * Call this at the same point `orchestrateStepCapture`'s `endGesture`
   * handler fires — i.e. before replay, not once `start`'s own promise
   * settles. It clears this gesture's contribution to `isBusy()` immediately,
   * which is what lets a post-capture hover-preview `schedule()` call
   * (invoked from inside `start`, before it returns) actually re-arm the
   * preview instead of observing `isBusy()` still true and bailing.
   *
   * The queue itself still waits for `start`'s promise to fully settle
   * (replay included) before starting the next entry — calling `release()`
   * early only affects `isBusy()`, never when the next entry is allowed to
   * begin, so two gestures' shared scroll-lock/preview state never overlaps.
   */
  release(): void;
}

interface StepGestureQueueEntry {
  captureId: string;
  /** Re-checked synchronously right before `start` actually runs (immediately
   * if idle, or when this entry's turn comes if it had to wait). Returning
   * false skips `start` entirely and calls `onSkipped` instead — used to
   * avoid spending a capture attempt on a target that went stale while
   * queued (detached from the DOM, or a relayed hop whose child-frame-local
   * failsafe budget has already elapsed). */
  validate?: () => boolean;
  /** Called when this entry is skipped (failed `validate`) or purged before
   * it ever started. The original trusted press was already prevented at
   * pointerdown time, so this is where a caller replays the click without
   * recording a step — otherwise the page would never react to it at all. */
  onSkipped?: () => void;
  start: (gesture: StepGesture) => Promise<void>;
}

export interface StepGestureQueue {
  /** True while a gesture is running or waiting its turn. Drives hover-preview
   * suspension and step/region-capture mutual exclusion. */
  isBusy(): boolean;
  /** Backlog depth: entries waiting, not counting the one currently running. */
  pendingCount(): number;
  /** Runs `entry.start` now if idle, otherwise queues it. */
  enqueue(entry: StepGestureQueueEntry): void;
  /** Cancels only the gesture currently running — mirrors the single-slot
   * behavior this replaces. Queued-but-not-started entries are deliberately
   * left alone: there is no reliable way to attribute a raw `pointercancel`
   * to one of several waiting entries (a mouse's PointerEvent.pointerId is a
   * constant in this codebase's target browsers, and relayed child-frame
   * hops carry no pointerId at all), so cancellation only ever targets the
   * one gesture that is unambiguous — the active one. */
  cancelActive(): void;
  /** Drops every queued-but-not-started entry, calling each one's
   * `onSkipped`. Does not touch the active gesture. */
  purgePending(): void;
  /** cancelActive() + purgePending(). */
  cancelAll(): void;
  /** Resolves once nothing is running or waiting — every gesture accepted so
   * far has fully settled, replay included. Toolbar commands wait on this so
   * they apply after the clicks the user already made, never between. */
  whenIdle(): Promise<void>;
}

function createGesture(captureId: string, onRelease: () => void): StepGesture {
  let cancel!: () => void;
  let cancelledFlag = false;
  const cancelled = new Promise<void>((resolve) => {
    cancel = () => {
      cancelledFlag = true;
      resolve();
    };
  });
  return { captureId, isCancelled: () => cancelledFlag, cancel, cancelled, release: onRelease };
}

export function createStepGestureQueue(): StepGestureQueue {
  // `blocking` clears as soon as a gesture calls `release()` (mirrors
  // yesterday's single `stepGesture = null`, timed to before replay).
  // `running` only clears once that gesture's whole `start` promise settles,
  // and is what actually gates whether the next entry may begin — keeping
  // these separate is what lets `isBusy()` drop early for the finishing
  // gesture's own benefit while still preventing a new gesture's scroll-lock/
  // preview state from ever running concurrently with the previous one's tail.
  let blocking: StepGesture | null = null;
  let running = false;
  const pending: StepGestureQueueEntry[] = [];
  let idleWaiters: Array<() => void> = [];

  const isIdle = () => !running && pending.length === 0;
  const notifyIdle = (): void => {
    if (!isIdle() || idleWaiters.length === 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const drainNext = (): void => {
    if (running) return;
    const next = pending.shift();
    if (!next) {
      notifyIdle();
      return;
    }
    runEntry(next);
  };

  const runEntry = (entry: StepGestureQueueEntry): void => {
    if (entry.validate && !entry.validate()) {
      entry.onSkipped?.();
      drainNext();
      return;
    }
    const gesture = createGesture(entry.captureId, () => {
      if (blocking === gesture) blocking = null;
    });
    blocking = gesture;
    running = true;
    void entry
      .start(gesture)
      .catch((error) => {
        console.error('[howbeam] step gesture failed unexpectedly', error);
      })
      .finally(() => {
        gesture.release();
        running = false;
        drainNext();
      });
  };

  return {
    isBusy: () => blocking !== null || pending.length > 0,
    pendingCount: () => pending.length,
    enqueue(entry) {
      if (!running) {
        runEntry(entry);
        return;
      }
      pending.push(entry);
      if (pending.length > QUEUE_DEPTH_WARN_THRESHOLD) {
        console.warn(`[howbeam] step capture backlog is ${pending.length} deep`);
      }
    },
    cancelActive() {
      blocking?.cancel();
    },
    purgePending() {
      const dropped = pending.splice(0, pending.length);
      for (const entry of dropped) entry.onSkipped?.();
      notifyIdle();
    },
    cancelAll() {
      blocking?.cancel();
      const dropped = pending.splice(0, pending.length);
      for (const entry of dropped) entry.onSkipped?.();
      notifyIdle();
    },
    whenIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}

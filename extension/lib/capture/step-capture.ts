/** Orchestration for a single step-mode capture, extracted so the ordering
 *  contract can be verified without a browser. */

/**
 * The result of one capture attempt, in decreasing order of health:
 * - `captured`: the real screenshot was taken; the step is stored (or still
 *   being stored, with its own delivery result).
 * - `failed`: the background ran but dropped the step (stale run, guard, etc.).
 * - `cancelled`: the gesture was abandoned (pointercancel / recorder teardown).
 * - `timeout`: the real capture out-ran its failsafe budget; the page is kept
 *   usable by replaying the click, but no trustworthy screenshot exists.
 */
export type StepCaptureOutcome = 'captured' | 'failed' | 'cancelled' | 'timeout';
const CANCEL_REQUEST_TIMEOUT_MS = 250;

export interface LateClickSuppressor<T> {
  /** Arms suppression for the replayed gesture's trailing trusted click. */
  arm(target: T): void;
  /** Disarms unconditionally (teardown, replaced gesture). */
  clear(): void;
  /**
   * A new trusted pointerdown starts a new gesture. Trusted events are ordered,
   * so the previous gesture's trailing click (if the browser emits one at all)
   * has already been dispatched by now; any click that follows this pointerdown
   * is a genuine new activation and must never be swallowed.
   */
  onTrustedPointerDown(): void;
  /**
   * Returns true when a trusted click is the replayed gesture's trailing
   * duplicate and must be swallowed. Consuming a click disarms the suppressor,
   * so at most one trusted click is ever eaten per replay.
   */
  shouldSuppress(eventTarget: unknown, isTrusted: boolean, matches: (armed: T, eventTarget: unknown) => boolean): boolean;
}

export function createLateClickSuppressor<T>(windowMs: number, now: () => number = Date.now): LateClickSuppressor<T> {
  let target: T | null = null;
  let until = 0;
  return {
    arm(next) {
      target = next;
      until = now() + windowMs;
    },
    clear() {
      target = null;
    },
    onTrustedPointerDown() {
      target = null;
    },
    shouldSuppress(eventTarget, isTrusted, matches) {
      if (!isTrusted || target === null) return false;
      if (now() >= until) {
        target = null;
        return false;
      }
      if (!matches(target, eventTarget)) return false;
      target = null;
      return true;
    },
  };
}

export interface ScrollSnapshot {
  x: number;
  y: number;
  containers?: Array<{ element: Element; x: number; y: number }>;
}

export interface StepCaptureHandlers {
  /** Hide the hover preview and settle enough paints that the compositor no
   * longer shows it. Runs before the screenshot is ever requested. */
  hidePreview: () => Promise<void>;
  /**
   * Resolves ONLY after the real screenshot has actually been taken: `true`
   * once it exists (storing the step may still be in flight), `false` when the
   * background dropped the capture. It must never resolve while the capture is
   * merely queued — that guarantee is what lets the replay below always run
   * against the post-capture page.
   */
  capture: () => Promise<boolean>;
  /** Resolves if the gesture is cancelled before its capture settles. */
  cancelled: Promise<void>;
  /** Invalidates an in-flight background capture before the page is replayed. */
  cancelCapture?: () => Promise<void>;
  /** Failsafe budget. If the real capture has not settled by now the page is
   * kept usable anyway; picked large enough that a normal-latency capture can
   * never lose this race. */
  failsafeMs: number;
  readScroll: () => ScrollSnapshot;
  /** Close the capture window: stop swallowing page events and release the
   * scroll pin so the restore below is not immediately undone. */
  endGesture: () => void;
  restoreScroll: (origin: ScrollSnapshot) => void;
  replay: () => void;
  resumePreview: () => void;
}

/**
 * Sequences a step capture so the stored screenshot always predates the replayed
 * click and the preview never re-appears mid-capture:
 *
 *   hide preview → (real capture ‖ cancel ‖ failsafe) → end gesture →
 *   restore scroll → replay click → resume preview
 *
 * Racing the real capture against the failsafe — instead of awaiting it and then
 * settling — is what prevents a hung capture from stranding the gesture and
 * dead-locking every later click.
 */
export async function orchestrateStepCapture(handlers: StepCaptureHandlers): Promise<StepCaptureOutcome> {
  const origin = handlers.readScroll();
  let failsafe: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  void handlers.cancelled.then(() => {
    cancelled = true;
  });

  try {
    // Keep preview preparation inside the same race as the screenshot. A
    // throttled tab can otherwise leave the gesture swallowed forever while its
    // two requestAnimationFrame callbacks wait for a paint that never arrives.
    const captureOutcome = (async (): Promise<StepCaptureOutcome> => {
      await handlers.hidePreview();
      if (cancelled) return 'cancelled';
      return (await handlers.capture()) ? 'captured' : 'failed';
    })().catch(() => 'failed' as const);
    const outcome = await Promise.race<StepCaptureOutcome>([
      captureOutcome,
      handlers.cancelled.then(() => 'cancelled' as const),
      new Promise<StepCaptureOutcome>((resolve) => {
        failsafe = setTimeout(() => resolve('timeout'), handlers.failsafeMs);
      }),
    ]);

    if ((outcome === 'timeout' || outcome === 'cancelled') && handlers.cancelCapture) {
      try {
        await Promise.race([
          handlers.cancelCapture(),
          new Promise<void>((resolve) => setTimeout(resolve, CANCEL_REQUEST_TIMEOUT_MS)),
        ]);
      } catch {
        // The background may already be gone; the foreground still needs to
        // release the gesture and restore the user's scroll position.
      }
    }
    handlers.endGesture();
    // The screenshot (or the failsafe budget) is done. Undo any auto-scroll
    // before the click; element.click() does not need the target in view.
    handlers.restoreScroll(origin);
    if (outcome !== 'cancelled') handlers.replay();
    handlers.resumePreview();
    return outcome;
  } finally {
    if (failsafe) clearTimeout(failsafe);
  }
}

/**
 * Frame-coalesced hover probing for the snapshot shield page.
 *
 * The shield cannot hit-test the frozen page itself, so every hover preview is
 * a round-trip over the shield channel. Invariants:
 * - At most one probe is in flight; new input bumps the point revision and the
 *   next probe sends once the current one settles or times out.
 * - A response applies only if it answers the latest request and the point
 *   hasn't moved since; otherwise it re-schedules.
 * - `sentPointRevision` suppresses re-probing an unchanged point; resetting it
 *   to -1 forces one fresh probe.
 */

export interface HoverProbeRequest {
  requestId: number;
  clientX: number;
  clientY: number;
}

export interface HoverPreviewResponse {
  requestId: number;
}

export type HoverPreviewOutcome = 'ignored' | 'stale' | 'accepted';

export interface HoverSchedulerDeps {
  /** Hovering is allowed at all (toolbar state says recording). */
  isEnabled(): boolean;
  /** A capture is in flight; probing pauses until it settles. */
  isCapturing(): boolean;
  /** Sends one probe over the shield channel. */
  post(request: HoverProbeRequest): void;
  /** Budget for one probe round-trip before it is abandoned and retried. */
  hoverTimeoutMs: number;
  /** Injectable for tests; defaults to requestAnimationFrame. */
  requestFrame?(callback: () => void): number;
  cancelFrame?(handle: number): void;
}

export interface HoverScheduler {
  /** Requests a probe on the next frame; no-ops while one is pending, while
   * capturing, without a point, or when the sent point is still current. */
  schedule(): void;
  /** Pointer moved to a new point. */
  pointerMove(clientX: number, clientY: number): void;
  /** Keyboard roving landed on an anchor: moves the point there. */
  setAnchor(clientX: number, clientY: number): void;
  /** Capture bookkeeping for a commit at the given point: invalidates any
   * scheduled probe so a late preview cannot repaint during the capture. */
  beginCapture(clientX: number, clientY: number): void;
  /** Drops the point and all pending work (pointer left, hover cleared). */
  clear(): void;
  /** Classifies a preview response; on 'accepted' the caller should render the
   * rect, then call schedule(). */
  resolvePreview(response: HoverPreviewResponse): HoverPreviewOutcome;
  /** Forces the next schedule() to re-probe the unchanged point (capture
   * settled or timed out, so the page under the cursor may have changed). */
  invalidateSentRevision(): void;
  hasPoint(): boolean;
}

export function createHoverScheduler(deps: HoverSchedulerDeps): HoverScheduler {
  const requestFrame = deps.requestFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
  const cancelFrame = deps.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));

  let frame: number | null = null;
  let point: { clientX: number; clientY: number } | null = null;
  let requestSequence = 0;
  let latestRequestId = 0;
  let pointRevision = 0;
  let sentPointRevision = -1;
  let pendingRequestId: number | null = null;
  let pendingPointRevision: number | null = null;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearPending = () => {
    if (pendingTimeout !== null) clearTimeout(pendingTimeout);
    pendingTimeout = null;
    pendingRequestId = null;
    pendingPointRevision = null;
  };

  const cancelScheduledFrame = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
  };

  const schedule = () => {
    if (
      !deps.isEnabled() ||
      deps.isCapturing() ||
      !point ||
      frame !== null ||
      pendingRequestId !== null ||
      sentPointRevision === pointRevision
    ) {
      return;
    }
    frame = requestFrame(() => {
      frame = null;
      if (
        !deps.isEnabled() ||
        deps.isCapturing() ||
        !point ||
        pendingRequestId !== null ||
        sentPointRevision === pointRevision
      ) {
        return;
      }
      latestRequestId = ++requestSequence;
      pendingRequestId = latestRequestId;
      sentPointRevision = pointRevision;
      pendingPointRevision = pointRevision;
      const hoverRequestId = latestRequestId;
      if (pendingTimeout !== null) clearTimeout(pendingTimeout);
      pendingTimeout = setTimeout(() => {
        if (pendingRequestId !== hoverRequestId) return;
        clearPending();
        sentPointRevision = -1;
        schedule();
      }, deps.hoverTimeoutMs);
      deps.post({
        requestId: latestRequestId,
        clientX: point.clientX,
        clientY: point.clientY,
      });
    });
  };

  return {
    schedule,
    pointerMove(clientX, clientY) {
      point = { clientX, clientY };
      pointRevision++;
      schedule();
    },
    setAnchor(clientX, clientY) {
      point = { clientX, clientY };
      pointRevision++;
      schedule();
    },
    beginCapture(clientX, clientY) {
      point = { clientX, clientY };
      pointRevision++;
      latestRequestId = ++requestSequence;
      cancelScheduledFrame();
    },
    clear() {
      point = null;
      pointRevision++;
      latestRequestId = ++requestSequence;
      cancelScheduledFrame();
      clearPending();
    },
    resolvePreview(response) {
      if (response.requestId !== pendingRequestId) return 'ignored';
      const responsePointRevision = pendingPointRevision;
      clearPending();
      if (deps.isCapturing() || response.requestId !== latestRequestId || responsePointRevision !== pointRevision) {
        return 'stale';
      }
      return 'accepted';
    },
    invalidateSentRevision() {
      sentPointRevision = -1;
    },
    hasPoint() {
      return point !== null;
    },
  };
}

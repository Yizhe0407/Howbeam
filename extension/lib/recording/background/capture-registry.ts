import { StaleCaptureError } from '../background-queues';

/** Shared cancellation/commit registry for in-flight captures: a capture already
 * in its commit window wins over a late cancellation for the same id. */

/** Bounded memory for cancellations whose capture id never arrives (e.g. the
 * capture failed before reaching the registry-cleaning finally block). */
const MAX_TRACKED_CANCELLATIONS = 1_024;

const cancelledCaptureIds = new Set<string>();
const committingCaptureIds = new Set<string>();

/** Marks a capture id cancelled unless its transaction is already committing. */
export function cancelCapture(captureId: string): void {
  if (committingCaptureIds.has(captureId)) return;
  cancelledCaptureIds.add(captureId);
  while (cancelledCaptureIds.size > MAX_TRACKED_CANCELLATIONS) {
    const oldest = cancelledCaptureIds.values().next().value as string | undefined;
    if (!oldest) break;
    cancelledCaptureIds.delete(oldest);
  }
}

export function assertCaptureNotCancelled(captureId: string): void {
  if (cancelledCaptureIds.has(captureId))
    throw new StaleCaptureError('Capture was cancelled before it could be saved.');
}

export function isCaptureCommitting(captureId: string): boolean {
  return committingCaptureIds.has(captureId);
}

/** Synchronous commit marker: no await may separate it from the persisting
 * write, or a cancellation arriving in between could half-cancel the
 * transaction (see the comments at the call sites). */
export function markCaptureCommitting(captureId: string): void {
  committingCaptureIds.add(captureId);
}

export function releaseCapture(captureId: string): void {
  committingCaptureIds.delete(captureId);
  cancelledCaptureIds.delete(captureId);
}

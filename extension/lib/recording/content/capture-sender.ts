import { browser } from 'wxt/browser';
import { getRecordingState } from '../../storage/storage';
import { isClickCaptureResult, requireRuntimeMessageResult } from '../../runtime/runtime-message-result';
import type { ClickCapture, ClickCaptureResult } from '../../runtime/messages';
import type { ResolvedSnapshotTarget } from '../snapshot-targeting';
import type { SnapshotShieldRect } from '../snapshot-shield-protocol';
import { t } from '@/lib/shared/i18n';

export type CaptureSender = ReturnType<typeof createCaptureSender>;

/**
 * How a step capture request ended, from the page's point of view:
 * - `saved`: the background stored the step.
 * - `rejected`: the background answered and declined it (stale run, paused,
 *   guard failure — anything worth telling the user it reports itself).
 * - `lost`: no usable answer (the service worker died or restarted mid-request)
 *   and the recording state shows no new step: the click was not recorded and
 *   nobody else will say so.
 */
export type CaptureDelivery = 'saved' | 'rejected' | 'lost';

/** The background's own fallback when a capture handler crashed. */
const CAPTURE_REQUEST_FAILED = 'capture-request-failed';

/** The run's capture channel to the background, plus the annotation counting
 * both snapshot commit paths reconcile against. */
export function createCaptureSender(runId: string) {
  async function sendCapture(
    rect: SnapshotShieldRect,
    target: Pick<ResolvedSnapshotTarget, 'text' | 'tagName'>,
    intent: ClickCapture['intent'],
    now: number,
    captureId: string = crypto.randomUUID(),
    captureKind: ClickCapture['captureKind'] = 'element',
  ): Promise<boolean> {
    const result = await requestCapture(rect, target, intent, now, captureId, captureKind);
    if (result.ok) return true;
    console.warn('[stepmark] step was not captured:', result.error);
    return false;
  }

  async function requestCapture(
    rect: SnapshotShieldRect,
    target: Pick<ResolvedSnapshotTarget, 'text' | 'tagName'>,
    intent: ClickCapture['intent'],
    now: number,
    captureId: string,
    captureKind: ClickCapture['captureKind'],
  ): Promise<ClickCaptureResult> {
    const payload: ClickCapture = {
      type: 'STEPMARK_CLICK',
      captureKind,
      captureId,
      runId,
      rect,
      devicePixelRatio: window.devicePixelRatio,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      text: target.text,
      tagName: target.tagName,
      intent,
      url: location.href,
      timestamp: now,
    };
    return requireRuntimeMessageResult<ClickCaptureResult>(
      await browser.runtime.sendMessage(payload),
      isClickCaptureResult,
      t().runtime.captureResponseInvalid,
    );
  }

  /**
   * Step-mode capture that never fails silently: a request whose answer is
   * lost is reconciled against the durable recording state (the background
   * records the committed captureId right after storing the step), so the
   * caller can tell the user exactly when a click was not recorded.
   */
  async function deliverStepCapture(
    rect: SnapshotShieldRect,
    target: Pick<ResolvedSnapshotTarget, 'text' | 'tagName'>,
    intent: ClickCapture['intent'],
    now: number,
    captureId: string,
    captureKind: ClickCapture['captureKind'] = 'element',
  ): Promise<CaptureDelivery> {
    let failure: unknown;
    try {
      const result = await requestCapture(rect, target, intent, now, captureId, captureKind);
      if (result.ok) return 'saved';
      if (result.error !== CAPTURE_REQUEST_FAILED) {
        console.warn('[stepmark] step was not captured:', result.error);
        return 'rejected';
      }
      failure = result.error;
    } catch (error) {
      failure = error;
    }
    console.warn('[stepmark] step capture request failed; reconciling with recording state', failure);
    return (await wasCaptureCommitted(captureId)) ? 'saved' : 'lost';
  }

  async function wasCaptureCommitted(captureId: string): Promise<boolean> {
    try {
      const state = await getRecordingState();
      return state.operation === 'recording' && state.runId === runId && state.lastCommittedCaptureId === captureId;
    } catch {
      return false;
    }
  }

  // The background's itemCount is the single source of truth for how many
  // annotations the current snapshot holds (it resets per snapshot and moves
  // on undo/restore). Deriving labels from it keeps overlay numbering
  // correct even when a capture response is lost after the background
  // already committed the step.
  async function readAuthoritativeAnnotationCount(): Promise<number | null> {
    try {
      const state = await getRecordingState();
      return state.operation === 'recording' && state.runId === runId ? state.itemCount : null;
    } catch {
      return null;
    }
  }

  /** 回傳已提交標註的權威 1-based 編號。 */
  async function commitSnapshotAnnotation(
    rect: SnapshotShieldRect,
    target: Pick<ResolvedSnapshotTarget, 'text' | 'tagName'>,
    captureKind: ClickCapture['captureKind'],
    now: number,
  ): Promise<number | null> {
    const before = (await readAuthoritativeAnnotationCount()) ?? 0;
    try {
      if (!(await sendCapture(rect, target, 'mark', now, crypto.randomUUID(), captureKind))) return null;
      return (await readAuthoritativeAnnotationCount()) ?? before + 1;
    } catch (error) {
      // The response was lost after the background may already have
      // committed the step; the durable recording state decides which of
      // the two actually happened, so labels cannot drift off-by-one.
      console.warn('[stepmark] snapshot capture response was lost; reconciling with recording state', error);
      const after = await readAuthoritativeAnnotationCount();
      return after !== null && after > before ? after : null;
    }
  }

  return {
    sendCapture,
    deliverStepCapture,
    readAuthoritativeAnnotationCount,
    commitSnapshotAnnotation,
  };
}

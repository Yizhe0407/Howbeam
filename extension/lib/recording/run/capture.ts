import type { Browser } from 'wxt/browser';
import { generateActionDescription } from '../../capture/action-description';
import { isMissingTabError } from '../../runtime/browser-errors';
import type {
  BackgroundRequest,
  ClickCapture,
  ClickCaptureResult,
  HowbeamCaptureTakenMessage,
  HowbeamSnapshotActiveMessage,
} from '../../runtime/messages';
import { isTrustedRecorderControlSender } from '../../runtime/background-message-validation';
import { UserFacingError, userFacingErrorCopy } from '../../runtime/user-facing-errors';
import { StaleCaptureError } from '../background-queues';
import {
  assertCaptureNotCancelled,
  cancelCapture,
  markCaptureCommitting,
  releaseCapture,
} from '../background/capture-registry';
import { isMatchingSnapshotViewport, isTrustedRecordedPageSender, isValidSnapshotViewportContext } from '../recording-guards';
import { isSuperseded, type OperationContext, type RunActor } from './actor';
import type { Lifecycle } from './lifecycle';
import type { RunPorts } from './ports';
import type { RecorderGate, SnapshotContext } from './recorder-gate';
import type { Recording, SnapshotAnchor } from './state';
import { captureCommitted, liveRecording, notice, snapshotInvalidated, withNotice, withRecording } from './transitions';

/** The page no longer matches the snapshot's base image. */
class SnapshotViewportChangedError extends Error {}
/** The snapshot's base image is gone: no annotation can be drawn on it again. */
class SnapshotAnchorMissingError extends Error {}

export interface CaptureDeps {
  actor: RunActor;
  ports: RunPorts;
  gate: RecorderGate;
  lifecycle: Lifecycle;
  discardUndo(): void;
}

type Sender = Browser.runtime.MessageSender;

/** Clicks turned into steps and snapshot annotations, and what the recorder reports on its own. */
export function createCapture(deps: CaptureDeps) {
  const { actor, ports, gate, lifecycle } = deps;

  /**
   * Screenshot guard: still this run in this tab, the tab still in front of
   * its window, and still on the page the click came from. Runs before every
   * capture attempt, because captureVisibleTab shoots whatever is in front.
   */
  function guardFor(ctx: OperationContext, recording: Recording, windowId: number, expectedUrl: string) {
    return async () => {
      if (ctx.signal.aborted) throw new StaleCaptureError('The recording changed before the screenshot.');
      const live = liveRecording(ctx.state(), recording.runId);
      if (!live || live.sessionId !== recording.sessionId || live.tabId !== recording.tabId) {
        throw new StaleCaptureError('The recording changed before the screenshot.');
      }
      const active = await ports.tabs.activeInWindow(windowId);
      // These two are shown to the user.
      if (active?.id !== recording.tabId) throw new UserFacingError('background.stepSkippedInactiveTab');
      if (active.url && active.url !== expectedUrl) throw new UserFacingError('background.stepSkippedPageChanged');
    };
  }

  /**
   * Captures a snapshot's base image, stores it (pending until its first
   * annotation), publishes it to the run and activates the shield. Leaves
   * nothing behind when any of that fails.
   */
  async function captureAnchor(
    ctx: OperationContext,
    recording: Recording,
    tab: { id: number; windowId: number },
    context: SnapshotContext,
  ): Promise<SnapshotAnchor> {
    const captureId = ports.newId();
    let anchorId: string | null = null;
    try {
      const shot = await ctx.until(ports.capture(
        { tabId: tab.id, windowId: tab.windowId, viewport: context.viewport, devicePixelRatio: context.devicePixelRatio, captureId },
        guardFor(ctx, recording, tab.windowId, context.url),
      ));
      anchorId = ports.newId();
      await ports.steps.add([{
        id: anchorId,
        sessionId: recording.sessionId,
        runId: recording.runId,
        screenshotBlob: shot.blob,
        bounds: null,
        devicePixelRatio: context.devicePixelRatio,
        screenshotScale: shot.scale,
        description: '',
        url: context.url,
        timestamp: context.timestamp,
        groupId: anchorId,
      }], recording.insertAfterStepId);
      const anchor: SnapshotAnchor = { id: anchorId, viewport: context.viewport, devicePixelRatio: context.devicePixelRatio };
      const live = liveRecording(ctx.state(), recording.runId);
      if (!live) throw new StaleCaptureError('The recording changed while saving the snapshot.');
      // Published before the shield activates, so its first annotation finds it.
      await ctx.commit((state) => withRecording(state, { ...live, anchor, notice: null }));
      const activate: HowbeamSnapshotActiveMessage = { type: 'HOWBEAM_SNAPSHOT_ACTIVE', runId: recording.runId };
      if ((await ctx.until(ports.tabs.send(tab.id, activate))) !== true) {
        throw new Error('Snapshot recorder could not be activated after saving its base image.');
      }
      return anchor;
    } catch (error) {
      if (anchorId) await withdrawAnchor(ctx, recording.runId, anchorId);
      throw error;
    } finally {
      releaseCapture(captureId);
    }
  }

  /**
   * Undoes a base image that could not be activated. A superseded operation
   * leaves the published anchor to whatever superseded it: ending a run
   * discards a pending base image anyway.
   */
  async function withdrawAnchor(ctx: OperationContext, runId: string, anchorId: string): Promise<void> {
    try {
      await ports.steps.discardPendingAnchor(anchorId);
    } catch (error) {
      console.error('[howbeam] failed to remove an incomplete snapshot base image', error);
    }
    if (ctx.signal.aborted) return;
    const live = liveRecording(ctx.state(), runId);
    if (live?.anchor?.id === anchorId) await ctx.commit((state) => withRecording(state, { ...live, anchor: null }));
  }

  async function captureStep(ctx: OperationContext, recording: Recording, message: ClickCapture, windowId: number): Promise<void> {
    const taken: HowbeamCaptureTakenMessage = { type: 'HOWBEAM_CAPTURE_TAKEN', runId: message.runId, captureId: message.captureId };
    const guard = guardFor(ctx, recording, windowId, message.url);
    const shot = await ctx.until(ports.capture(
      { tabId: recording.tabId, windowId, viewport: message.viewport, devicePixelRatio: message.devicePixelRatio, captureId: message.captureId },
      async () => {
        await guard();
        assertCaptureNotCancelled(message.captureId);
      },
      // The pixels exist: the recorder may replay the click it is holding while the step is stored.
      () => void ports.tabs.send(recording.tabId, taken).catch(() => {}),
    ));
    // Once the recorder replayed the click the page may already show another
    // URL, so only a cancellation or a newer control can still void the pixels.
    if (ctx.signal.aborted || !liveRecording(ctx.state(), recording.runId)) {
      throw new StaleCaptureError('The recording changed while saving the step.');
    }
    assertCaptureNotCancelled(message.captureId);
    await lifecycle.ensureRunProject(recording);
    assertCaptureNotCancelled(message.captureId);
    // No await between the commit marker and the write: a later cancellation must not half-cancel it.
    markCaptureCommitting(message.captureId);
    await ports.steps.add([{
      id: ports.newId(),
      sessionId: recording.sessionId,
      runId: message.runId,
      screenshotBlob: shot.blob,
      bounds: message.rect,
      devicePixelRatio: message.devicePixelRatio,
      screenshotScale: shot.scale,
      description: generateActionDescription(message),
      url: message.url,
      timestamp: message.timestamp,
    }], recording.insertAfterStepId);
  }

  async function annotate(recording: Recording, message: ClickCapture): Promise<void> {
    const { anchor } = recording;
    if (
      anchor?.viewport &&
      anchor.devicePixelRatio != null &&
      !isMatchingSnapshotViewport(anchor.viewport, anchor.devicePixelRatio, message.viewport, message.devicePixelRatio)
    ) {
      throw new SnapshotViewportChangedError();
    }
    if (!anchor) throw new SnapshotAnchorMissingError('The run has no snapshot base image.');
    const stored = await ports.steps.get(anchor.id);
    if (stored?.sessionId !== recording.sessionId || !stored.screenshotBlob) {
      throw new SnapshotAnchorMissingError('The snapshot base image or its screenshot is gone.');
    }
    if (stored.url !== message.url) throw new UserFacingError('background.annotationSkippedPageChanged');
    await lifecycle.ensureRunProject(recording);
    markCaptureCommitting(message.captureId);
    await ports.steps.add([{
      id: ports.newId(),
      sessionId: recording.sessionId,
      runId: message.runId,
      bounds: message.rect,
      devicePixelRatio: stored.devicePixelRatio,
      screenshotScale: stored.screenshotScale,
      description: '',
      url: message.url,
      timestamp: message.timestamp,
      groupId: anchor.id,
    }], recording.insertAfterStepId);
  }

  async function click(ctx: OperationContext, message: ClickCapture, sender: Sender): Promise<ClickCaptureResult> {
    const recording = liveRecording(ctx.state(), message.runId);
    if (!recording) return { ok: false, error: 'not-recording' };
    if (recording.phase !== 'recording' && recording.phase !== 'finishing') return { ok: false, error: 'wrong-phase' };
    if (!isTrustedRecordedPageSender(message.url, sender, recording.tabId)) return { ok: false, error: 'untrusted-sender' };
    const windowId = sender.tab?.windowId;
    if (windowId == null) return { ok: false, error: 'missing-tab-context' };

    deps.discardUndo();
    try {
      if (recording.mode === 'snapshot') await annotate(recording, message);
      else await captureStep(ctx, recording, message, windowId);
      const live = liveRecording(ctx.state(), message.runId);
      if (live) await ctx.commit((state) => withRecording(state, captureCommitted(live, message.captureId)));
      return { ok: true };
    } catch (error) {
      return failedClick(ctx, recording, message, error);
    }
  }

  /** Says why a click was not recorded, and whether the user was already told. */
  async function failedClick(
    ctx: OperationContext,
    recording: Recording,
    message: ClickCapture,
    error: unknown,
  ): Promise<ClickCaptureResult> {
    if (isSuperseded(error) || error instanceof StaleCaptureError) {
      return { ok: false, error: `stale-capture: ${error instanceof Error ? error.message : 'superseded'}` };
    }
    const reported = (reason: string): ClickCaptureResult => ({ ok: false, error: reason, reported: true });
    try {
      if (error instanceof SnapshotViewportChangedError) {
        await invalidate(ctx, recording.runId, message);
        return reported('snapshot-viewport-changed');
      }
      if (error instanceof SnapshotAnchorMissingError) {
        console.error('[howbeam] snapshot anchor is gone; settling the run:', error.message);
        await lifecycle.endWithError(ctx, recording, notice('SNAPSHOT_ANCHOR_MISSING', 'background.snapshotAnchorLost'));
        return reported('snapshot-anchor-missing');
      }
      if (isMissingTabError(error)) {
        // Queued behind this click; the page that would show a notice is gone.
        void lifecycle.recordedTabGone(recording.tabId);
        return reported('tab-closed');
      }
      console.error('[howbeam] failed to capture/annotate/save step:', error);
      const live = liveRecording(ctx.state(), recording.runId);
      if (live) {
        const copy = userFacingErrorCopy(error, 'background.captureFailed');
        await ctx.commit((state) => withRecording(state, withNotice(live, notice('CAPTURE_FAILED', copy))));
      }
      return reported(error instanceof Error ? error.message : 'capture-failed');
    } catch (recoveryError) {
      console.error('[howbeam] failed to persist capture failure:', recoveryError);
      return { ok: false, error: 'capture-failed' };
    }
  }

  /** Marks the snapshot invalidated, once; answers whether it is invalidated now. */
  async function invalidate(ctx: OperationContext, runId: string, report?: { viewport: ClickCapture['viewport']; devicePixelRatio: number }): Promise<boolean> {
    const recording = liveRecording(ctx.state(), runId);
    if (!recording || recording.mode !== 'snapshot') return false;
    if (recording.phase === 'invalidated') return true;
    const anchor = recording.anchor;
    if (recording.phase !== 'recording' || !anchor?.viewport || anchor.devicePixelRatio == null) return false;
    if (report && isMatchingSnapshotViewport(anchor.viewport, anchor.devicePixelRatio, report.viewport, report.devicePixelRatio)) {
      return false;
    }
    deps.discardUndo();
    await ctx.commit((state) => withRecording(state, snapshotInvalidated(recording)));
    return true;
  }

  async function handleClick(message: ClickCapture, sender: Sender): Promise<ClickCaptureResult> {
    await actor.ready();
    try {
      return await actor.run((ctx) => click(ctx, message, sender));
    } catch (error) {
      if (isSuperseded(error)) return { ok: false, error: 'stale-capture: superseded' };
      throw error;
    } finally {
      releaseCapture(message.captureId);
    }
  }

  /** The recorder's message comes from the top frame of the run's tab. */
  function recorderRun(runId: string, sender: Sender): Recording | null {
    const recording = liveRecording(actor.state(), runId);
    return recording && sender.frameId === 0 && sender.tab?.id === recording.tabId ? recording : null;
  }

  /**
   * HOWBEAM_READY. Not queued: a start waiting for this handshake holds the queue.
   * Answers whether the recorder should stay: a startup's own recorder, or one
   * re-injected into a run that is live (after a navigation or a tab move).
   */
  async function handleRecorderReady(message: BackgroundRequest<'HOWBEAM_READY'>, sender: Sender): Promise<boolean> {
    await actor.ready();
    const recording = recorderRun(message.runId, sender);
    if (!recording || !isTrustedRecorderControlSender(sender, recording.tabId)) return false;
    const ready = message.snapshotContext ? { snapshotContext: message.snapshotContext } : {};
    if (gate.signal(recording.runId, recording.tabId, ready)) return true;
    return recording.phase === 'recording' || recording.phase === 'paused' || recording.phase === 'preparing-next';
  }

  async function handleSnapshotInvalidated(message: BackgroundRequest<'SNAPSHOT_INVALIDATED'>, sender: Sender): Promise<boolean> {
    if (!isValidSnapshotViewportContext(message.viewport, message.devicePixelRatio)) return false;
    await actor.ready();
    const recording = recorderRun(message.runId, sender);
    if (recording?.mode !== 'snapshot') return false;
    if (recording.phase === 'invalidated') return true;
    return actor.run((ctx) => invalidate(ctx, message.runId, message)).catch(() => false);
  }

  async function handleSnapshotRecorderFailure(message: BackgroundRequest<'SNAPSHOT_RECORDER_FAILED'>, sender: Sender): Promise<boolean> {
    await actor.ready();
    const recording = recorderRun(message.runId, sender);
    if (recording?.mode !== 'snapshot') return false;
    await lifecycle.stopWithError(message.runId, notice('SNAPSHOT_SHIELD_FAILED', 'background.shieldInterrupted'));
    return true;
  }

  /** Not queued: the capture it cancels may be the operation running right now. */
  async function handleCancelCapture(message: BackgroundRequest<'HOWBEAM_CANCEL_CAPTURE'>, sender: Sender): Promise<ClickCaptureResult> {
    await actor.ready();
    if (!recorderRun(message.runId, sender)) return { ok: false, error: 'untrusted-sender' };
    cancelCapture(message.captureId);
    return { ok: true };
  }

  return {
    captureAnchor,
    handleClick,
    handleRecorderReady,
    handleSnapshotInvalidated,
    handleSnapshotRecorderFailure,
    handleCancelCapture,
  };
}

export type Capture = ReturnType<typeof createCapture>;

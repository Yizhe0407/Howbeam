import type { Browser } from 'wxt/browser';
import { isTrustedRecaptureSourceSender } from '../../capture/recapture-guards';
import type { CopyKey } from '../../shared/i18n/copy';
import type {
  BackgroundRequest,
  CancelStepRecaptureResult,
  FocusStepRecaptureSourceResult,
  PreflightStepRecaptureSourcePermissionResult,
  StartStepRecaptureResult,
  StepRecaptureTargetResult,
} from '../../runtime/messages';
import { UserFacingError, userFacingErrorCopy } from '../../runtime/user-facing-errors';
import type { StepRecaptureContext, StepRecaptureResult } from '../../storage/recording-state';
import { StepRecaptureError, type CaptureReplacement, type StepRecaptureTarget } from '../../storage/step-repository';
import { StaleCaptureError } from '../background-queues';
import {
  assertCaptureNotCancelled,
  cancelCapture,
  isCaptureCommitting,
  markCaptureCommitting,
  releaseCapture,
} from '../background/capture-registry';
import type { SourceTabAcquisition } from '../background/source-tab';
import { recaptureTargetErrorCopy, StepRecaptureStartError, type ValidatedRecaptureTarget } from '../background/recapture-target';
import { isSuperseded, type OperationContext, type RunActor } from './actor';
import type { RunPorts } from './ports';
import type { RecorderGate } from './recorder-gate';
import type { RunState } from './state';

type Sender = Browser.runtime.MessageSender;
type StartFailureCode = Extract<StartStepRecaptureResult, { ok: false }>['code'];

/** The source-tab and target helpers the flow builds on; the background wires the real ones. */
export interface RecaptureSources {
  isEditorSenderForSession(sender: Sender, sessionId: string): boolean;
  validateTarget(sessionId: string, target: StepRecaptureTarget): Promise<ValidatedRecaptureTarget>;
  permissionPreflight(sourceUrl: string): Extract<PreflightStepRecaptureSourcePermissionResult, { ok: true }> | null;
  checkPermission(sourceUrl: string): Promise<'granted' | 'restricted' | 'permission-required'>;
  openSourceTab(sourceUrl: string, preferredTabId: number | undefined):
    Promise<{ ok: true; source: SourceTabAcquisition } | { ok: false; reason: 'open-failed' | 'redirected' | 'unreachable' }>;
  /** Closes a tab this flow opened unless `commit` was called before `body` settled. */
  withUncommittedTab<T>(source: SourceTabAcquisition, body: (commit: () => void) => Promise<T>): Promise<T>;
  replaceCapture(sessionId: string, target: StepRecaptureTarget, capture: CaptureReplacement, runId: string): Promise<unknown>;
  wasCommitted(context: StepRecaptureContext): Promise<boolean>;
  isSourceTabIntact(context: StepRecaptureContext): Promise<boolean>;
  closeTab(tabId: number): Promise<void>;
}

export interface RecaptureDeps {
  actor: RunActor;
  ports: RunPorts;
  /** Its own gate: a recapture never waits on a recording's recorder. */
  gate: RecorderGate;
  sources: RecaptureSources;
  discardUndo(): void;
}

const startFailure = (code: StartFailureCode, error: CopyKey): StartStepRecaptureResult => ({ ok: false, code, error });

/**
 * The one-shot replacement of one step's screenshot (or a one-mark
 * snapshot's): the editor starts it, the user picks the target in the source
 * tab, and it settles back into the editor with a result the editor
 * acknowledges.
 */
export function createRecapture(deps: RecaptureDeps) {
  const { actor, ports, gate, sources } = deps;
  /** Serializes starts, which publish their state only after opening a tab. */
  let starting = false;
  let activeCaptureId: string | null = null;

  const current = (state: RunState, runId: string): StepRecaptureContext | null =>
    state.operation.kind === 'recapture' && state.operation.context.runId === runId ? state.operation.context : null;

  async function settle(
    ctx: OperationContext,
    runId: string,
    status: StepRecaptureResult['status'],
    errorCode?: string,
    copy?: CopyKey,
  ): Promise<boolean> {
    const context = current(ctx.state(), runId);
    if (!context) return false;
    gate.cancel();
    if (activeCaptureId) cancelCapture(activeCaptureId);
    activeCaptureId = null;
    const result: StepRecaptureResult = {
      runId,
      status,
      sessionId: context.sessionId,
      entryId: context.entryId,
      ...(errorCode ? { errorCode } : {}),
      ...(copy ? { copy } : {}),
      completedAt: ports.now(),
    };
    await ctx.commit((state) => ({
      recaptureResult: result,
      operation: {
        kind: 'idle',
        sessionId: context.sessionId,
        mode: 'steps',
        failed: false,
        notice: status === 'failed' ? { code: null, copy: copy ?? 'recaptureFlow.failed' } : null,
        itemCount: 0,
        runItemCount: 0,
        lastCommittedCaptureId: state.operation.kind === 'idle' ? state.operation.lastCommittedCaptureId : null,
      },
    }));
    await ports.recorder.stop(context.sourceTabId);
    if (context.sourceTabCreated) {
      await sources.closeTab(context.sourceTabId).catch((error) => {
        console.warn('[howbeam] failed to close temporary recapture tab', error);
      });
    }
    try {
      // Back to the one editor tab, at the entry this recapture worked on.
      await ports.editor.open({ sessionId: context.sessionId, entryId: context.entryId });
    } catch (error) {
      console.error('[howbeam] failed to return to editor after recapture', error);
    }
    return true;
  }

  /** Ends the recapture from outside its operations: supersedes them first. */
  async function fail(runId: string, errorCode: string, copy: CopyKey): Promise<void> {
    if (!current(actor.state(), runId)) return;
    actor.claim();
    await actor.run((ctx) => settle(ctx, runId, 'failed', errorCode, copy)).catch((error) => {
      if (!isSuperseded(error)) throw error;
    });
  }

  async function preflight(
    message: BackgroundRequest<'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION'>,
    sender: Sender,
  ): Promise<PreflightStepRecaptureSourcePermissionResult> {
    if (!sources.isEditorSenderForSession(sender, message.sessionId)) {
      return { ok: false, code: 'INVALID_EDITOR', message: 'recaptureFlow.editorOnlyPreflight' };
    }
    let validated: ValidatedRecaptureTarget;
    try {
      validated = await sources.validateTarget(message.sessionId, message.target);
    } catch (error) {
      if (error instanceof StepRecaptureStartError) return { ok: false, code: error.code, message: error.copy };
      throw error;
    }
    return sources.permissionPreflight(validated.sourceUrl)
      ?? { ok: false, code: 'RESTRICTED_SOURCE', message: 'recaptureFlow.restrictedSource' };
  }

  async function start(message: BackgroundRequest<'START_STEP_RECAPTURE'>, sender: Sender): Promise<StartStepRecaptureResult> {
    if (!sources.isEditorSenderForSession(sender, message.sessionId)) {
      return startFailure('INVALID_EDITOR', 'recaptureFlow.editorOnlyProjectStart');
    }
    if (starting) return startFailure('ACTIVE_OPERATION', 'recaptureFlow.alreadyStarting');
    await actor.ready();
    if (actor.state().operation.kind !== 'idle') return startFailure('ACTIVE_OPERATION', 'recaptureFlow.activeOperation');
    starting = true;
    try {
      let validated: ValidatedRecaptureTarget;
      try {
        validated = await sources.validateTarget(message.sessionId, message.target);
      } catch (error) {
        if (error instanceof StepRecaptureStartError) return startFailure(error.code, error.copy);
        throw error;
      }
      const permission = await sources.checkPermission(validated.sourceUrl);
      if (permission === 'restricted') return startFailure('RESTRICTED_SOURCE', 'recaptureFlow.restrictedSource');
      if (permission === 'permission-required') return startFailure('HOST_PERMISSION_REQUIRED', 'recaptureFlow.accessRequired');

      actor.claim();
      gate.cancel();
      deps.discardUndo();
      const opened = await sources.openSourceTab(validated.sourceUrl, message.preferredTabId);
      if (!opened.ok) {
        return startFailure('SOURCE_TAB_FAILED', opened.reason === 'open-failed'
          ? 'background.sourceTabOpenFailed'
          : opened.reason === 'unreachable' ? 'recaptureFlow.sourceUnreachable' : 'recaptureFlow.sourceRedirected');
      }
      return await sources.withUncommittedTab(opened.source, (commit) => actor.run((ctx) => runStart(ctx, message, validated, opened.source, commit)))
        .catch((error: unknown) => {
          if (isSuperseded(error)) return startFailure('ACTIVE_OPERATION', 'recaptureFlow.operationChanged');
          throw error;
        });
    } finally {
      starting = false;
    }
  }

  async function runStart(
    ctx: OperationContext,
    message: BackgroundRequest<'START_STEP_RECAPTURE'>,
    validated: ValidatedRecaptureTarget,
    source: SourceTabAcquisition,
    commit: () => void,
  ): Promise<StartStepRecaptureResult> {
    const { tab } = source;
    if (tab.id == null || tab.windowId == null) return startFailure('SOURCE_TAB_FAILED', 'recaptureFlow.sourceRedirected');
    if (ctx.state().operation.kind !== 'idle') return startFailure('ACTIVE_OPERATION', 'recaptureFlow.activeOperation');
    const runId = ports.newId();
    const context: StepRecaptureContext = {
      runId,
      sessionId: message.sessionId,
      target: validated.target,
      entryId: validated.entryId,
      phase: 'starting',
      sourceTabId: tab.id,
      sourceWindowId: tab.windowId,
      sourceUrl: validated.sourceUrl,
      sourceTabCreated: !source.reused,
      startedAt: ports.now(),
    };
    await ctx.commit(() => ({ operation: { kind: 'recapture', context }, recaptureResult: null }));
    // From here the persisted context owns the tab: settling closes one this flow created.
    commit();
    try {
      const ready = gate.open(runId, tab.id);
      const [, reported] = await ctx.until(Promise.all([ports.recorder.inject(tab.id), ready]));
      if (!reported) throw new Error('Recapture recorder did not become ready before timeout.');
      await ctx.commit((state) => {
        const live = current(state, runId);
        return live ? { ...state, operation: { kind: 'recapture', context: { ...live, phase: 'awaiting-target' } } } : state;
      });
      await ports.tabs.focus(tab.id, tab.windowId);
      return { ok: true, runId, tabId: tab.id, reusedTab: source.reused };
    } catch (error) {
      if (isSuperseded(error)) throw error;
      console.error('[howbeam] failed to start recapture recorder', error);
      await settle(ctx, runId, 'failed', 'INJECTION_FAILED', 'recaptureFlow.injectFailed');
      return startFailure('INJECTION_FAILED', 'recaptureFlow.injectFailed');
    }
  }

  /** HOWBEAM_RECAPTURE_READY; not queued, since the start waiting for it holds the queue. */
  async function handleReady(message: BackgroundRequest<'HOWBEAM_RECAPTURE_READY'>, sender: Sender): Promise<boolean> {
    await actor.ready();
    const context = current(actor.state(), message.runId);
    if (!context || context.phase !== 'starting' || !isTrustedRecaptureSourceSender(sender, context) || message.url !== context.sourceUrl) {
      return false;
    }
    return gate.signal(message.runId, context.sourceTabId, {});
  }

  function contextGuard(ctx: OperationContext, runId: string, context: StepRecaptureContext) {
    return async () => {
      const live = current(ctx.state(), runId);
      if (ctx.signal.aborted || !live || live.phase !== 'capturing') {
        throw new StaleCaptureError('Recapture changed before the screenshot could be taken.');
      }
      // Stricter than a recording's guard: an unreadable active-tab URL fails.
      const active = await ports.tabs.activeInWindow(context.sourceWindowId);
      if (active?.id !== context.sourceTabId) throw new UserFacingError('recaptureFlow.sourceNotActive');
      if (active.url !== context.sourceUrl) throw new UserFacingError('recaptureFlow.sourceChanged');
    };
  }

  async function handleTarget(message: BackgroundRequest<'HOWBEAM_RECAPTURE_TARGET'>, sender: Sender): Promise<StepRecaptureTargetResult> {
    const reject = (status: 'rejected' | 'cancelled' | 'failed', error?: CopyKey): StepRecaptureTargetResult =>
      ({ ok: false, status, ...(error ? { error } : {}) });
    await actor.ready();
    const result = await actor.run(async (ctx): Promise<StepRecaptureTargetResult> => {
      const context = current(ctx.state(), message.runId);
      if (
        !context ||
        context.phase !== 'awaiting-target' ||
        !isTrustedRecaptureSourceSender(sender, context) ||
        message.url !== context.sourceUrl ||
        activeCaptureId
      ) {
        return reject('rejected');
      }
      await ctx.commit((state) => ({ ...state, operation: { kind: 'recapture', context: { ...context, phase: 'capturing' } } }));
      activeCaptureId = message.captureId;
      try {
        const shot = await ctx.until(ports.capture(
          { tabId: context.sourceTabId, windowId: context.sourceWindowId, viewport: message.viewport, devicePixelRatio: message.devicePixelRatio, captureId: message.captureId },
          contextGuard(ctx, message.runId, context),
        ));
        assertCaptureNotCancelled(message.captureId);
        if (ctx.signal.aborted || current(ctx.state(), message.runId)?.phase !== 'capturing') {
          throw new StaleCaptureError('Recapture changed before the replacement.');
        }
        // A cancellation after this point waits for the replacement and reports it done.
        markCaptureCommitting(message.captureId);
        await sources.replaceCapture(context.sessionId, context.target, {
          screenshotBlob: shot.blob,
          bounds: message.rect,
          devicePixelRatio: message.devicePixelRatio,
          screenshotScale: shot.scale,
          url: message.url,
          timestamp: message.timestamp,
        }, message.runId);
        await settle(ctx, message.runId, 'replaced');
        return { ok: true, status: 'replaced' };
      } catch (error) {
        if (isSuperseded(error) || error instanceof StaleCaptureError) return reject('cancelled');
        const errorCode = error instanceof StepRecaptureError ? error.code : 'CAPTURE_FAILED';
        // The editor shows this copy: never a raw repository or browser diagnostic.
        const copy = error instanceof StepRecaptureError
          ? recaptureTargetErrorCopy(error.code, context.target.kind)
          : userFacingErrorCopy(error, 'recaptureFlow.failedUnchanged');
        console.error('[howbeam] failed to replace step capture', error);
        await settle(ctx, message.runId, 'failed', errorCode, copy);
        return reject('failed', copy);
      } finally {
        if (activeCaptureId === message.captureId) activeCaptureId = null;
      }
    }).catch((error: unknown) => {
      if (isSuperseded(error)) return reject('cancelled');
      throw error;
    });
    releaseCapture(message.captureId);
    return result;
  }

  async function cancel(message: BackgroundRequest<'CANCEL_STEP_RECAPTURE'>, sender: Sender): Promise<CancelStepRecaptureResult> {
    await actor.ready();
    const state = actor.state();
    if (state.recaptureResult?.runId === message.runId) return { ok: true, status: 'already-completed' };
    const context = current(state, message.runId);
    if (!context) return { ok: false, error: 'recaptureFlow.alreadyEnded' };
    if (!sources.isEditorSenderForSession(sender, context.sessionId) && !isTrustedRecaptureSourceSender(sender, context)) {
      return { ok: false, error: 'recaptureFlow.invalidSource' };
    }
    if (activeCaptureId && isCaptureCommitting(activeCaptureId)) {
      await actor.settled();
      return { ok: true, status: 'already-completed' };
    }
    if (activeCaptureId) cancelCapture(activeCaptureId);
    actor.claim();
    gate.cancel();
    const settled = await actor.run((ctx) => settle(ctx, message.runId, 'cancelled', 'CANCELLED', 'recaptureFlow.cancelled'))
      .catch(() => false);
    return { ok: true, status: settled ? 'cancelled' : 'already-completed' };
  }

  async function acknowledge(message: BackgroundRequest<'ACK_STEP_RECAPTURE_RESULT'>, sender: Sender): Promise<boolean> {
    if (!sources.isEditorSenderForSession(sender, message.sessionId)) return false;
    await actor.ready();
    return actor.run(async (ctx) => {
      const result = ctx.state().recaptureResult;
      if (result?.runId !== message.runId || result.sessionId !== message.sessionId) return false;
      await ctx.commit((state) => ({ ...state, recaptureResult: null }));
      return true;
    }).catch(() => false);
  }

  async function focusSource(message: BackgroundRequest<'FOCUS_STEP_RECAPTURE_SOURCE'>, sender: Sender): Promise<FocusStepRecaptureSourceResult> {
    await actor.ready();
    const context = current(actor.state(), message.runId);
    if (!context) return { ok: false, error: 'recaptureFlow.alreadyEnded' };
    if (!sources.isEditorSenderForSession(sender, context.sessionId)) return { ok: false, error: 'recaptureFlow.invalidEditor' };
    try {
      await ports.tabs.focus(context.sourceTabId, context.sourceWindowId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'recaptureFlow.tabMissing' };
    }
  }

  /** Once selection is on, any navigation of the source tab ends the job. Returns whether the tab was the source. */
  async function handleSourceTabUpdated(tabId: number, changeInfo: { status?: string; url?: string }): Promise<boolean> {
    await actor.ready();
    const op = actor.state().operation;
    if (op.kind !== 'recapture' || op.context.sourceTabId !== tabId) return false;
    const { context } = op;
    if (context.phase !== 'starting' && (changeInfo.status === 'loading' || (changeInfo.url != null && changeInfo.url !== context.sourceUrl))) {
      await fail(context.runId, 'SOURCE_NAVIGATED', 'recaptureFlow.sourceNavigated');
    }
    return true;
  }

  async function handleSourceTabRemoved(tabId: number): Promise<boolean> {
    await actor.ready();
    const op = actor.state().operation;
    if (op.kind !== 'recapture' || op.context.sourceTabId !== tabId) return false;
    await fail(op.context.runId, 'SOURCE_TAB_CLOSED', 'recaptureFlow.sourceTabClosed');
    return true;
  }

  /**
   * A restarted worker: selection survives (its recorder lives in the source
   * tab) unless a browser restart reissued the tab id; a capture in flight is
   * settled by whether its replacement was committed.
   */
  async function recover(): Promise<void> {
    await actor.ready();
    const op = actor.state().operation;
    if (op.kind !== 'recapture') return;
    const { context } = op;
    if (context.phase === 'awaiting-target') {
      if (await sources.isSourceTabIntact(context)) return;
      await actor.run((ctx) => settle(ctx, context.runId, 'failed', 'SOURCE_TAB_CLOSED', 'recaptureFlow.sourceTabChanged'));
      return;
    }
    const committed = context.phase === 'capturing' && await sources.wasCommitted(context);
    await actor.run((ctx) => committed
      ? settle(ctx, context.runId, 'replaced')
      : settle(ctx, context.runId, 'failed', 'WORKER_RESTARTED', 'recaptureFlow.interrupted'));
  }

  return {
    isStarting: () => starting,
    preflight,
    start,
    handleReady,
    handleTarget,
    cancel,
    acknowledge,
    focusSource,
    handleSourceTabUpdated,
    handleSourceTabRemoved,
    recover,
  };
}

export type Recapture = ReturnType<typeof createRecapture>;

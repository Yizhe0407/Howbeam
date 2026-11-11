import type { Browser } from 'wxt/browser';
import type { CopyKey } from '../../shared/i18n/copy';
import type { RecordingControlResult, StartRecordingMessage, StartRecordingResult } from '../../runtime/messages';
import { isTrustedExtensionPageSender, isTrustedRecorderControlSender, type RuntimeMessageSenderLike } from '../../runtime/background-message-validation';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import { projectDisplayTitle } from '../../storage/models';
import { isSuperseded, type OperationContext, type RunActor } from './actor';
import type { RunPorts } from './ports';
import type { RecorderGate, SnapshotContext } from './recorder-gate';
import type { Notice, Recording, RunState, SnapshotAnchor } from './state';
import {
  ended,
  endedWithError,
  editorOpenFailed,
  finishing,
  liveRecording,
  notice,
  paused,
  recordingLive,
  resumed,
  startFailed,
  startingRun,
  stopped,
  withNotice,
  withRecording,
} from './transitions';

export interface LifecycleDeps {
  actor: RunActor;
  ports: RunPorts;
  gate: RecorderGate;
  extensionOrigin: string;
  /** Captures, stores and activates a snapshot's base image (snapshot.ts). */
  captureAnchor(ctx: OperationContext, recording: Recording, tab: { id: number; windowId: number }, context: SnapshotContext): Promise<SnapshotAnchor>;
  /** Ends the run's undo window (undo.ts). */
  discardUndo(): void;
  /** A recapture start that has not published its state yet also owns the recorder. */
  isRecaptureStarting(): boolean;
  /** Resolves and opens the tab an editor continuation records in (source-tab.ts). */
  resolveContinuationTab(
    message: StartRecordingMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<{ ok: true; tab: Browser.tabs.Tab } | Extract<StartRecordingResult, { ok: false }>>;
  /** Where a run goes when its tab closes (navigation.ts): 'moved', or nowhere to go. */
  continueAfterTabClosed(ctx: OperationContext, recording: Recording): Promise<'moved' | 'nowhere'>;
}

const failure = (error: CopyKey): RecordingControlResult => ({ ok: false, error });

export function createLifecycle(deps: LifecycleDeps) {
  const { actor, ports, gate } = deps;

  /** Supersedes whatever is running: the gate, the undo window and every queued operation. */
  function claim(): void {
    actor.claim();
    gate.cancel();
    deps.discardUndo();
  }

  /** Cleanup every way of ending a run shares, once the end is committed. */
  async function afterRunEnded(recording: Recording): Promise<void> {
    await discardEmptyAnchor(recording);
    await ports.recorder.stop(recording.tabId);
  }

  /** A snapshot base image that never got an annotation never joined the Project: drop it. */
  async function discardEmptyAnchor(recording: Recording): Promise<void> {
    if (recording.mode !== 'snapshot' || !recording.anchor) return;
    try {
      await ports.steps.discardPendingAnchor(recording.anchor.id);
    } catch (error) {
      console.error('[howbeam] failed to remove the empty snapshot base image', error);
    }
  }

  async function reclaimIfAutoCreated(recording: Recording): Promise<void> {
    if (!recording.autoCreated) return;
    try {
      await ports.projects.discardIfPristine(recording.sessionId);
    } catch (error) {
      console.error('[howbeam] failed to reclaim the abandoned auto-created project', error);
    }
  }

  /** Ends the run inside an operation that owns it. */
  async function endWithError(ctx: OperationContext, recording: Recording, shown: Notice): Promise<void> {
    gate.cancel();
    await ctx.commit((state) => endedWithError(state, recording, shown));
    await afterRunEnded(recording);
  }

  /**
   * Ends the run from outside any operation: supersedes whatever it was doing
   * first. Inside an operation use endWithError, or this would wait for itself.
   */
  async function stopWithError(runId: string, shown: Notice): Promise<void> {
    await actor.ready();
    if (!liveRecording(actor.state(), runId)) return;
    claim();
    await actor.run(async (ctx) => {
      const recording = liveRecording(ctx.state(), runId);
      if (recording) await endWithError(ctx, recording, shown);
    });
  }

  function startFailure(ctx: OperationContext, mode: StartRecordingMessage['mode'], code: string, copy: CopyKey) {
    return ctx.commit((state) => startFailed(state, null, mode, notice(code, copy)));
  }

  async function startRecording(
    message: StartRecordingMessage,
    sender: Browser.runtime.MessageSender,
    targetTab: Browser.tabs.Tab | null = null,
  ): Promise<StartRecordingResult> {
    await actor.ready();
    // A capture operation has a single owner: never let a second start take over another one.
    if (actor.state().operation.kind !== 'idle' || deps.isRecaptureStarting()) {
      return { ok: false, error: 'recaptureFlow.activeOperation' };
    }
    if (!(await ports.projects.get(message.sessionId))) return { ok: false, error: 'background.recordTargetMissing' };

    let tab = targetTab;
    if (message.continuation) {
      const resolved = await deps.resolveContinuationTab(message, sender);
      if (!resolved.ok) return resolved;
      tab = resolved.tab;
    }

    claim();
    try {
      return await actor.run((ctx) => runStart(ctx, message, tab));
    } catch (error) {
      if (!isSuperseded(error)) throw error;
      return startReply(actor.state(), message.sessionId, null);
    }
  }

  function startReply(state: RunState, sessionId: string, runId: string | null): StartRecordingResult {
    const op = state.operation;
    if (op.kind === 'recording' && op.sessionId === sessionId && (runId === null || op.runId === runId) && op.phase !== 'starting') {
      return { ok: true, sessionId, runId: op.runId };
    }
    const shown = op.kind === 'idle' ? op.notice : null;
    return { ok: false, error: shown?.copy ?? 'background.cannotStartHere' };
  }

  async function runStart(
    ctx: OperationContext,
    message: StartRecordingMessage,
    continuationTab: Browser.tabs.Tab | null,
  ): Promise<StartRecordingResult> {
    const { mode } = message;
    const tab = continuationTab ?? await ctx.until(ports.tabs.activeInCurrentWindow());
    if (tab?.id == null) {
      await startFailure(ctx, mode, 'NO_ACTIVE_TAB', 'background.noActiveTab');
      return startReply(ctx.state(), message.sessionId, null);
    }
    if (!isRecordableTabUrl(tab.url)) {
      await startFailure(ctx, mode, 'RESTRICTED_PAGE', 'background.restrictedBrowserPage');
      return startReply(ctx.state(), message.sessionId, null);
    }
    const tabId = tab.id;
    // Captures read the visible viewport, so a continuation's tab is brought forward before injecting.
    if (continuationTab) {
      try {
        await ctx.until(ports.tabs.focus(tabId, tab.windowId));
      } catch (error) {
        if (isSuperseded(error)) throw error;
        console.error('[howbeam] failed to focus the continuation source tab', error);
        await startFailure(ctx, mode, 'SOURCE_TAB_FAILED', 'background.sourceTabSwitchFailed');
        return startReply(ctx.state(), message.sessionId, null);
      }
    }

    const autoCreated = message.autoCreatedProject === true;
    const project = autoCreated ? undefined : await ctx.until(ports.projects.get(message.sessionId));
    const insertAfterStepId = message.insertAfterEntryId === undefined
      ? null
      : (await ctx.until(ports.projects.continuationAnchor(message.sessionId, message.insertAfterEntryId)))?.afterStepId ?? null;
    const runId = ports.newId();
    const starting = startingRun({
      runId,
      sessionId: message.sessionId,
      tabId,
      mode,
      autoCreated,
      targetProjectTitle: project ? projectDisplayTitle(project.title) : null,
      insertAfterStepId,
    });
    await ctx.commit((state) => withRecording(state, starting));

    try {
      const ready = await ctx.until(injectAndAwaitReady(runId, tabId));
      let anchor: SnapshotAnchor | null = null;
      if (mode === 'snapshot') {
        if (!ready.snapshotContext) throw new Error('Snapshot recorder did not provide its capture context.');
        if (tab.windowId == null) throw new Error('Snapshot capture context is incomplete.');
        anchor = await deps.captureAnchor(ctx, starting, { id: tabId, windowId: tab.windowId }, ready.snapshotContext);
      }
      const current = liveRecording(ctx.state(), runId);
      if (!current) return startReply(ctx.state(), message.sessionId, runId);
      await ctx.commit((state) => withRecording(state, recordingLive(current, anchor)));
    } catch (error) {
      if (isSuperseded(error)) throw error;
      console.error('[howbeam] failed to inject recorder:', error);
      const current = liveRecording(ctx.state(), runId);
      if (current) await endWithError(ctx, current, notice('RECORDING_STOPPED', 'background.injectFailed'));
    }
    return startReply(ctx.state(), message.sessionId, runId);
  }

  /** Injects the recorder and waits for it to report ready; throws when it never does. */
  async function injectAndAwaitReady(runId: string, tabId: number) {
    const ready = gate.open(runId, tabId);
    try {
      const [, reported] = await Promise.all([ports.recorder.inject(tabId), ready]);
      if (!reported) throw new Error('Recorder did not become ready before the startup timeout.');
      return reported;
    } catch (error) {
      gate.cancel();
      throw error;
    }
  }

  /** STOP (the e2e harness): ends the run, keeping whatever notice it showed. */
  async function stopRecording(): Promise<void> {
    await actor.ready();
    if (actor.state().operation.kind !== 'recording') return;
    claim();
    await actor.run(async (ctx) => {
      const recording = ctx.state().operation;
      if (recording.kind !== 'recording') return;
      await ctx.commit((state) => stopped(state, recording));
      await afterRunEnded(recording);
      // After the anchor cleanup, so a snapshot run with no annotation counts as empty.
      await reclaimIfAutoCreated(recording);
    });
  }

  function pause(runId: string): Promise<RecordingControlResult> {
    return actor.run(async (ctx) => {
      const recording = liveRecording(ctx.state(), runId);
      if (!recording || recording.mode !== 'steps' || recording.phase !== 'recording') {
        return failure('background.cannotPause');
      }
      await ctx.commit((state) => withRecording(state, paused(recording)));
      return { ok: true };
    });
  }

  function resume(runId: string): Promise<RecordingControlResult> {
    return actor.run(async (ctx) => {
      const recording = liveRecording(ctx.state(), runId);
      if (!recording || recording.mode !== 'steps' || recording.phase !== 'paused') {
        return failure('background.cannotResume');
      }
      await ctx.commit((state) => withRecording(state, resumed(recording)));
      return { ok: true };
    });
  }

  /** The entry the editor opens at: the run's last captured step, as an entry id. */
  async function lastRunEntry(recording: Recording) {
    const steps = await ports.steps.outlines(recording.sessionId);
    const runItems = steps.filter((step) => step.runId === recording.runId && step.bounds !== null);
    const last = runItems.at(-1) ?? null;
    return { sessionId: recording.sessionId, entryId: last?.groupId ?? last?.id ?? null, itemCount: runItems.length };
  }

  async function finish(runId: string): Promise<RecordingControlResult> {
    await actor.ready();
    const initial = liveRecording(actor.state(), runId);
    const finishable = ['recording', 'paused', 'preparing-next', 'invalidated'];
    if (!initial || !finishable.includes(initial.phase)) {
      return failure(initial?.phase === 'finishing' ? 'background.finishing' : 'background.alreadyEnded');
    }
    deps.discardUndo();
    // Not a claim: captures already queued are kept and land before the finish.
    return actor.run(async (ctx) => {
      const recording = liveRecording(ctx.state(), runId);
      if (!recording) return failure('background.alreadyEnded');
      if (!finishable.includes(recording.phase)) {
        return failure(recording.phase === 'finishing' ? 'background.finishing' : 'background.alreadyEnded');
      }
      await ctx.commit((state) => withRecording(state, finishing(recording)));
      const result = await lastRunEntry(recording);
      // No reclaim even with nothing recorded: the editor opens this very Project.
      await ctx.commit((state) => ended(state, recording));
      await afterRunEnded(recording);
      try {
        await ports.editor.open({ sessionId: result.sessionId, entryId: result.entryId });
      } catch (error) {
        console.error('[howbeam] failed to open editor after recording', error);
        await ctx.commit(editorOpenFailed);
      }
      return { ok: true, finish: result };
    });
  }

  async function discard(runId: string): Promise<RecordingControlResult> {
    await actor.ready();
    const initial = liveRecording(actor.state(), runId);
    if (!initial || initial.phase === 'starting' || initial.phase === 'finishing') {
      return failure('background.cannotDiscard');
    }
    claim();
    try {
      return await actor.run(async (ctx) => {
        const recording = liveRecording(ctx.state(), runId);
        if (!recording) return failure('background.stateChangedRetry');
        try {
          await ports.steps.deleteForRun(recording.sessionId, runId);
        } catch (error) {
          console.error('[howbeam] failed to discard current recording', error);
          await ctx.commit((state) => withRecording(state, withNotice(recording, notice('DISCARD_FAILED', 'background.discardFailed'))));
          return failure('background.discardFailed');
        }
        await ctx.commit((state) => ended(state, recording));
        await afterRunEnded(recording);
        // The run's steps are gone, so a popup-created Project is an empty shell again.
        await reclaimIfAutoCreated(recording);
        return { ok: true };
      });
    } catch (error) {
      if (isSuperseded(error)) return failure('background.stateChangedRetry');
      throw error;
    }
  }

  /**
   * The tab the run lives in is gone. A run that may follow the user goes on
   * in another tab; otherwise it ends, and the popup offers to open what was
   * recorded.
   */
  function recordedTabGone(tabId: number): Promise<void> {
    return actor.run(async (ctx) => {
      const recording = ctx.state().operation;
      if (recording.kind !== 'recording' || recording.tabId !== tabId) return;
      if ((await deps.continueAfterTabClosed(ctx, recording)) === 'moved') return;
      const current = liveRecording(ctx.state(), recording.runId);
      if (current) await endWithError(ctx, current, notice('RECORDED_TAB_CLOSED', 'runtime.recordingTabClosed'));
    }).catch((error) => {
      if (!isSuperseded(error)) throw error;
    });
  }

  /**
   * Who may control a run: Howbeam's own pages, or the top frame of the tab
   * the run lives in (its in-page toolbar).
   */
  function isTrustedControlSender(runId: string, sender: RuntimeMessageSenderLike): boolean {
    if (isTrustedExtensionPageSender(sender, deps.extensionOrigin)) return true;
    const recording = liveRecording(actor.state(), runId);
    return recording !== null && isTrustedRecorderControlSender(sender, recording.tabId);
  }

  return {
    startRecording,
    stopRecording,
    pause,
    resume,
    finish,
    discard,
    stopWithError,
    endWithError,
    recordedTabGone,
    isTrustedControlSender,
    claim,
    afterRunEnded,
    discardEmptyAnchor,
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;

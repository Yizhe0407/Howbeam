import type { CopyKey } from '../../shared/i18n/copy';
import type { RecordingControlResult } from '../../runtime/messages';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import { isSuperseded, type OperationContext, type RunActor } from './actor';
import type { Capture } from './capture';
import type { Lifecycle } from './lifecycle';
import type { RunPorts } from './ports';
import type { Recording, RecordingPhase } from './state';
import {
  capturingSnapshot,
  liveRecording,
  notice,
  preparingNextSnapshot,
  recordingLive,
  switchedToSnapshot,
  switchingToSteps,
  withNotice,
  withRecording,
} from './transitions';

export interface SnapshotDeps {
  actor: RunActor;
  ports: RunPorts;
  lifecycle: Lifecycle;
  capture: Capture;
  discardUndo(): void;
}

const failure = (error: CopyKey): RecordingControlResult => ({ ok: false, error });

/** A live run's snapshot steps, and its switches between steps and snapshot mode. */
export function createSnapshotControls(deps: SnapshotDeps) {
  const { actor, ports, lifecycle, capture } = deps;

  /** Runs a control as one operation; a newer control superseding it is reported as a change. */
  async function control(operation: (ctx: OperationContext) => Promise<RecordingControlResult>) {
    try {
      return await actor.run(operation);
    } catch (error) {
      if (isSuperseded(error)) return failure('background.stateChangedRetry');
      throw error;
    }
  }

  async function reinject(tabId: number, failureLog: string): Promise<void> {
    try {
      await ports.recorder.inject(tabId);
    } catch (error) {
      console.error(failureLog, error);
    }
  }

  function is(recording: Recording | null, mode: Recording['mode'], phases: readonly RecordingPhase[]): recording is Recording {
    return recording !== null && recording.mode === mode && phases.includes(recording.phase);
  }

  /** Ends the current snapshot; the recorder shows the controls for taking the next one. */
  async function prepareNext(runId: string): Promise<RecordingControlResult> {
    await actor.ready();
    if (!is(liveRecording(actor.state(), runId), 'snapshot', ['recording'])) return failure('background.cannotCreateNextSnapshot');
    deps.discardUndo();
    return control(async (ctx) => {
      const previous = liveRecording(ctx.state(), runId);
      if (!is(previous, 'snapshot', ['recording'])) return failure('background.nextSnapshotStateChanged');
      await ctx.commit((state) => withRecording(state, preparingNextSnapshot(previous)));
      await lifecycle.discardEmptyAnchor(previous);
      try {
        // Re-injecting tears the shield down and mounts the preparation toolbar.
        await ports.recorder.inject(previous.tabId);
      } catch (error) {
        console.error('[howbeam] failed to enter snapshot preparation state', error);
        const live = liveRecording(ctx.state(), runId);
        if (live) await ctx.commit((state) => withRecording(state, withNotice(live, notice('CAPTURE_FAILED', 'background.nextSnapshotControlsFailed'))));
        return failure('background.nextSnapshotPrepareFailed');
      }
      return { ok: true };
    });
  }

  /**
   * Captures the next snapshot, or rebuilds an invalidated one on the page as
   * it is now. A failed rebuild keeps the invalidated snapshot's annotations.
   */
  async function createNext(runId: string, from: 'preparing-next' | 'invalidated'): Promise<RecordingControlResult> {
    await actor.ready();
    if (!is(liveRecording(actor.state(), runId), 'snapshot', [from])) return failure('background.cannotCreateNextSnapshot');
    lifecycle.claim();
    return control(async (ctx) => {
      const previous = liveRecording(ctx.state(), runId);
      if (!is(previous, 'snapshot', [from])) return failure('background.cannotCreateNextSnapshot');
      await ctx.commit((state) => withRecording(state, capturingSnapshot(previous)));
      try {
        const tab = await ctx.until(ports.tabs.get(previous.tabId));
        if (tab.windowId == null || !isRecordableTabUrl(tab.url)) throw new Error('Snapshot tab cannot be captured.');
        const ready = await ctx.until(lifecycle.injectAndAwaitReady(runId, previous.tabId));
        if (!ready.snapshotContext) throw new Error('Snapshot recorder did not provide its capture context.');
        const starting = liveRecording(ctx.state(), runId);
        if (!starting) return failure('background.cannotCreateNextSnapshot');
        const anchor = await capture.captureAnchor(ctx, starting, { id: previous.tabId, windowId: tab.windowId }, ready.snapshotContext);
        const live = liveRecording(ctx.state(), runId);
        if (!live) return failure('background.cannotCreateNextSnapshot');
        await ctx.commit((state) => withRecording(state, recordingLive(live, anchor)));
        return { ok: true };
      } catch (error) {
        if (isSuperseded(error)) throw error;
        console.error('[howbeam] failed to create next snapshot', error);
        const rebuilding = from === 'invalidated';
        const copy: CopyKey = rebuilding ? 'background.rebuildSnapshotFailed' : 'background.createSnapshotFailed';
        const live = liveRecording(ctx.state(), runId);
        if (live) {
          await ctx.commit((state) => withRecording(state, {
            ...live,
            phase: from,
            itemCount: rebuilding ? previous.itemCount : 0,
            anchor: rebuilding ? previous.anchor : null,
            notice: notice(rebuilding ? 'REBUILD_SNAPSHOT_FAILED' : 'CREATE_SNAPSHOT_FAILED', copy),
          }));
          await reinject(previous.tabId, '[howbeam] failed to restore snapshot preparation toolbar');
        }
        return failure(copy);
      }
    });
  }

  async function switchToSnapshot(runId: string): Promise<RecordingControlResult> {
    await actor.ready();
    if (!is(liveRecording(actor.state(), runId), 'steps', ['recording', 'paused'])) return failure('background.cannotSwitchToSnapshot');
    deps.discardUndo();
    return control(async (ctx) => {
      const previous = liveRecording(ctx.state(), runId);
      if (!is(previous, 'steps', ['recording', 'paused'])) return failure('background.switchStateChanged');
      await ctx.commit((state) => withRecording(state, switchedToSnapshot(previous)));
      try {
        await ports.recorder.inject(previous.tabId);
        return { ok: true };
      } catch (error) {
        console.error('[howbeam] failed to switch to snapshot mode', error);
        if (liveRecording(ctx.state(), runId)) await ctx.commit((state) => withRecording(state, previous));
        await reinject(previous.tabId, '[howbeam] failed to restore the step recorder');
        return failure('background.switchToSnapshotFailed');
      }
    });
  }

  async function switchToSteps(runId: string): Promise<RecordingControlResult> {
    await actor.ready();
    const switchable = ['recording', 'preparing-next', 'invalidated'] as const;
    if (!is(liveRecording(actor.state(), runId), 'snapshot', switchable)) return failure('background.cannotSwitchToSteps');
    lifecycle.claim();
    return control(async (ctx) => {
      const previous = liveRecording(ctx.state(), runId);
      if (!is(previous, 'snapshot', switchable)) return failure('background.switchStateChanged');
      await ctx.commit((state) => withRecording(state, switchingToSteps(previous)));
      // What was annotated stays; only a base image that never got an annotation goes.
      await lifecycle.discardEmptyAnchor(previous);
      try {
        await ctx.until(lifecycle.injectAndAwaitReady(runId, previous.tabId));
        const live = liveRecording(ctx.state(), runId);
        if (!live) return failure('background.switchStateChanged');
        await ctx.commit((state) => withRecording(state, recordingLive(live, null)));
        return { ok: true };
      } catch (error) {
        if (isSuperseded(error)) throw error;
        console.error('[howbeam] failed to switch to steps mode', error);
        const live = liveRecording(ctx.state(), runId);
        if (live) {
          await ctx.commit((state) => withRecording(state, {
            ...live,
            mode: 'snapshot',
            phase: 'preparing-next',
            notice: notice('SWITCH_TO_STEPS_FAILED', 'background.switchToStepsFailed'),
          }));
          await reinject(previous.tabId, '[howbeam] failed to restore snapshot preparation toolbar');
        }
        return failure('background.switchToStepsFailed');
      }
    });
  }

  return { prepareNext, createNext, switchToSnapshot, switchToSteps };
}

export type SnapshotControls = ReturnType<typeof createSnapshotControls>;

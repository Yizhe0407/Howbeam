import type { HowbeamSnapshotHistoryMessage, RecordingControlResult } from '../../runtime/messages';
import { UNDO_WINDOW_MS } from '../../shared/undo-window';
import type { PendingUndoRecord } from '../background/pending-undo-store';
import { isSuperseded, type RunActor } from './actor';
import type { RunPorts } from './ports';
import type { Recording } from './state';
import { captureRestored, captureUndone, liveRecording, withRecording } from './transitions';

/**
 * The one undo a run offers for its last capture: the removed step is kept
 * (in memory, and in its own store so it outlives a worker restart) until the
 * window closes. Any new capture or control closes it.
 */
export function createUndo(deps: { actor: RunActor; ports: RunPorts }) {
  const { actor, ports } = deps;
  let pending: PendingUndoRecord | null = null;

  function discard(): void {
    pending = null;
    void ports.undo.clear().catch((error) => {
      console.warn('[howbeam] failed to clear the persisted undo record', error);
    });
  }

  /** The frozen snapshot draws its own marks, so it hears about every undo and restore. */
  function notifySnapshot(recording: Recording, change: HowbeamSnapshotHistoryMessage['change']): void {
    if (recording.mode !== 'snapshot') return;
    const message: HowbeamSnapshotHistoryMessage = { type: 'HOWBEAM_SNAPSHOT_HISTORY', runId: recording.runId, change };
    void ports.tabs.send(recording.tabId, message).catch((error) => {
      console.warn('[howbeam] snapshot did not hear an annotation undo/restore', error);
    });
  }

  const undoable = (recording: Recording | null): recording is Recording =>
    recording !== null && (recording.phase === 'recording' || recording.phase === 'paused');

  async function undo(runId: string): Promise<RecordingControlResult> {
    await actor.ready();
    return actor.run(async (ctx) => {
      const recording = liveRecording(ctx.state(), runId);
      if (!undoable(recording) || recording.itemCount === 0) return { ok: false, error: 'background.nothingToUndo' };
      const outline = (await ports.steps.outlines(recording.sessionId))
        .findLast((step) => step.runId === runId && step.bounds !== null);
      const step = outline && await ports.steps.get(outline.id);
      if (!step) return { ok: false, error: 'background.nothingToUndo' };

      const record: PendingUndoRecord = {
        token: ports.newId(),
        runId,
        step,
        expectedItemCount: recording.itemCount - 1,
        expiresAt: ports.now() + UNDO_WINDOW_MS,
      };
      // The copy is saved before the step goes: the worker may stop inside the window.
      try {
        await ports.undo.save(record);
      } catch (error) {
        console.warn('[howbeam] failed to persist the undo window', error);
      }
      await ports.steps.delete(step.id);
      try {
        await ctx.commit((state) => withRecording(state, captureUndone(recording)));
      } catch (error) {
        if (!isSuperseded(error)) throw error;
        await ports.steps.add([step], recording.insertAfterStepId);
        discard();
        return { ok: false, error: 'background.undoStateChanged' };
      }
      pending = record;
      notifySnapshot(recording, 'undo');
      return { ok: true, undoToken: record.token, removedItemNumber: recording.itemCount };
    });
  }

  async function restore(runId: string, undoToken: string | undefined): Promise<RecordingControlResult> {
    await actor.ready();
    return actor.run(async (ctx) => {
      const recording = liveRecording(ctx.state(), runId);
      const record = pending;
      if (
        !record ||
        record.token !== undoToken ||
        record.runId !== runId ||
        record.expiresAt < ports.now() ||
        !undoable(recording) ||
        recording.itemCount !== record.expectedItemCount
      ) {
        discard();
        return { ok: false, error: 'background.cannotRestore' };
      }
      await ports.steps.add([record.step], recording.insertAfterStepId);
      try {
        await ctx.commit((state) => withRecording(state, captureRestored(recording)));
      } catch (error) {
        if (!isSuperseded(error)) throw error;
        await ports.steps.delete(record.step.id);
        return { ok: false, error: 'background.restoreStateChanged' };
      }
      discard();
      notifySnapshot(recording, 'restore');
      return { ok: true };
    });
  }

  /** Rebuilds the window a restarted worker lost, while the run still matches it. */
  async function recover(): Promise<void> {
    await actor.ready();
    const record = await ports.undo.read();
    if (!record) return;
    const recording = liveRecording(actor.state(), record.runId);
    if (undoable(recording) && recording.itemCount === record.expectedItemCount && record.expiresAt > ports.now()) {
      pending ??= record;
      return;
    }
    await ports.undo.clear();
  }

  return { undo, restore, discard, recover };
}

export type Undo = ReturnType<typeof createUndo>;

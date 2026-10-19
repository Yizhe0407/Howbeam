import { getRecordingState } from '../../storage/storage';
import {
  clearPendingUndoRecord,
  readPendingUndoRecord,
  savePendingUndoRecord,
  type PendingUndoRecord,
} from './pending-undo-store';

/**
 * The single undo a recording run offers for its last capture: the in-memory
 * record and its persisted copy, which outlives an MV3 worker restart.
 */
export function createUndoWindow() {
  let pending: PendingUndoRecord | null = null;

  /** Persists the copy before the step is deleted. Best-effort: a failure
   * degrades to an undo that lives in memory only. */
  async function persist(record: PendingUndoRecord): Promise<void> {
    try {
      await savePendingUndoRecord(record);
    } catch (persistError) {
      console.warn('[howbeam] failed to persist the undo window', persistError);
    }
  }

  function open(record: PendingUndoRecord): void {
    pending = record;
  }

  function current(): PendingUndoRecord | null {
    return pending;
  }

  /** Ends the window synchronously, then deletes the persisted copy. */
  function discard(): void {
    pending = null;
    void clearPendingUndoRecord().catch((error) => {
      console.warn('[howbeam] failed to clear the persisted undo record', error);
    });
  }

  /** Rebuilds the window a restarted worker lost, only while the persisted
   * run still matches it. */
  async function recover(): Promise<void> {
    const record = await readPendingUndoRecord();
    if (!record) return;
    const state = await getRecordingState();
    const windowStillOpen =
      state.isRecording &&
      state.operation === 'recording' &&
      state.runId === record.runId &&
      state.itemCount === record.expectedItemCount &&
      (state.phase === 'recording' || state.phase === 'paused') &&
      record.expiresAt > Date.now();
    if (!windowStillOpen) {
      await clearPendingUndoRecord();
      return;
    }
    pending ??= record;
  }

  return { persist, open, current, discard, recover };
}

export type UndoWindow = ReturnType<typeof createUndoWindow>;

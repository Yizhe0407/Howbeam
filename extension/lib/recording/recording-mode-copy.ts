import type { RecordingMode } from '@/lib/storage/recording-state';
import { t, type Messages } from '@/lib/shared/i18n';

/**
 * The single vocabulary for the two recording modes: the popup, injected
 * toolbar, and editor stage header all read the mode's name and its item
 * phrases from here, so they cannot drift apart. The copy itself lives in the
 * i18n catalogs (`mode.steps` / `mode.snapshot`); this module only maps a
 * RecordingMode onto it. Lives in lib/recording (not lib/shared) because it
 * depends on the RecordingMode type.
 */
export type RecordingModeCopy = Messages['mode']['steps'];

/** RecordingState carries a typed `mode`, but persisted state can predate a
 * member rename, so keep the historic "anything that is not steps renders as
 * snapshot" fold-down explicit and in one place. */
function normalizeRecordingMode(mode: RecordingMode): RecordingMode {
  return mode === 'steps' ? 'steps' : 'snapshot';
}

/** Read at render time, so the copy always follows the active locale. The
 * Record-typed catalog keeps the mapping total: a RecordingMode member without
 * copy is a compile error instead of a runtime crash on a failed lookup. */
export function recordingModeCopy(mode: RecordingMode): RecordingModeCopy {
  const copy: Record<RecordingMode, RecordingModeCopy> = t().mode;
  return copy[normalizeRecordingMode(mode)];
}

/** e.g. `3 個步驟` / `3 steps` — the popup's live summary and the editor stage
 * header count the same items, so they format them the same way. */
export function recordingItemCountLabel(mode: RecordingMode, count: number): string {
  return recordingModeCopy(mode).itemCount(count);
}

/** A live run's count. Once it spans snapshots or modes, the current mode's unit no longer covers everything, so it falls back to a neutral one. */
export function runItemCountLabel(state: { mode: RecordingMode; itemCount: number; runItemCount: number }): string {
  return state.runItemCount === state.itemCount
    ? recordingItemCountLabel(state.mode, state.runItemCount)
    : t().common.itemCount(state.runItemCount);
}

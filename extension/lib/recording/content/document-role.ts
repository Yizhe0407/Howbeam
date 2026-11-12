import type { RecordingState, StepRecaptureContext } from '../../storage/recording-state';
import type { UnrecordablePageReason } from './recordable-page';

/** What this document's recorder does, decided once per start from the run state and the frame. */
export type DocumentRole =
  /** No run touches this document. */
  | { kind: 'none' }
  /** The recapture's own picker, in the source page's top frame. */
  | { kind: 'recapture'; context: StepRecaptureContext }
  /** A child frame answering the top frame's "what is under this point" probes. */
  | { kind: 'probe'; runId: string; freeze: boolean }
  /** A step run's child frame: captures its own clicks and relays them to the top frame. */
  | { kind: 'step-child'; runId: string; paused: boolean }
  /** The run's main recorder in the top frame (steps, snapshot, or a page that cannot be recorded). */
  | { kind: 'top'; runId: string; unrecordable: UnrecordablePageReason | null; freezeSnapshot: boolean };

export interface DocumentFrame {
  isTop: boolean;
  /** The top document's own reason it cannot be recorded (top frame only). */
  unrecordable: UnrecordablePageReason | null;
  /** A child frame under a top page that cannot be recorded. */
  underUnrecordablePage: boolean;
}

export function documentRole(state: RecordingState, frame: DocumentFrame): DocumentRole {
  if (state.operation === 'recapture' && state.recapture) {
    return frame.isTop
      ? { kind: 'recapture', context: state.recapture }
      : { kind: 'probe', runId: state.recapture.runId, freeze: false };
  }
  if (state.operation !== 'recording' || !state.isRecording || !state.runId) return { kind: 'none' };
  const runId = state.runId;

  if (state.mode === 'snapshot') {
    // Between snapshots nothing is frozen: the user is choosing the next page.
    const freezing = state.phase !== 'preparing-next';
    if (!frame.isTop) return freezing ? { kind: 'probe', runId, freeze: true } : { kind: 'none' };
    return {
      kind: 'top',
      runId,
      unrecordable: frame.unrecordable,
      freezeSnapshot: freezing && frame.unrecordable === null,
    };
  }

  if (!frame.isTop) {
    // No top recorder would answer a relayed click under such a page.
    return frame.underUnrecordablePage
      ? { kind: 'none' }
      : { kind: 'step-child', runId, paused: state.phase === 'paused' };
  }
  return { kind: 'top', runId, unrecordable: frame.unrecordable, freezeSnapshot: false };
}

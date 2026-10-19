import { actionIconPaths } from '../../shared/brand-icons';
import type { RecordingState } from '../../storage/recording-state';
import { getRecordingState, onRecordingStateChange } from '../../storage/storage';
import { toolbarAction } from '../../runtime/toolbar-action';

/** The toolbar shows the recording dot exactly while a capture run is live. */
function showsRecordingIcon(state: Pick<RecordingState, 'isRecording'>): boolean {
  return state.isRecording;
}

async function applyActionIcon(recording: boolean): Promise<void> {
  try {
    await toolbarAction().setIcon({ path: actionIconPaths(recording) });
  } catch (error) {
    // Cosmetic only: a failed swap must never disturb the recording itself.
    console.warn('[howbeam] failed to update the toolbar icon', error);
  }
}

/**
 * Keeps the toolbar icon derived from the persisted recording state. The
 * state is the single source of truth, so every path that starts, stops or
 * recovers a run updates the icon without knowing about it — including a
 * worker that wakes mid-run, which re-reads the state here.
 */
export function syncActionIconWithRecordingState(): () => void {
  let last: boolean | null = null;
  const apply = (state: RecordingState) => {
    const recording = showsRecordingIcon(state);
    if (recording === last) return;
    last = recording;
    void applyActionIcon(recording);
  };
  const unsubscribe = onRecordingStateChange(apply);
  getRecordingState().then(apply).catch((error: unknown) => {
    console.warn('[howbeam] failed to sync the toolbar icon with the recording state', error);
  });
  return unsubscribe;
}

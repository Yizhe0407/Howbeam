import type { RecoverableRecordingError } from '../storage/recording-state';

/** A run that ended with its tab gone, or whose editor failed to open: the popup offers to open what was recorded. */
export function needsEditorRecovery(error: RecoverableRecordingError | null): boolean {
  return error?.code === 'RECORDED_TAB_CLOSED' || error?.code === 'EDITOR_OPEN_FAILED';
}

import type { RecoverableRecordingError, RecordingState } from '../storage/recording-state';

export function recordedTabClosedError(): RecoverableRecordingError {
  return { code: 'RECORDED_TAB_CLOSED', copy: 'runtime.recordingTabClosed' };
}

export function editorOpenFailedError(): RecoverableRecordingError {
  return { code: 'EDITOR_OPEN_FAILED', copy: 'runtime.editorOpenAfterRecordingFailed' };
}

export function needsEditorRecovery(error: RecoverableRecordingError | null): boolean {
  return error?.code === 'RECORDED_TAB_CLOSED' || error?.code === 'EDITOR_OPEN_FAILED';
}

export function markEditorOpenFailed(state: RecordingState): RecordingState {
  if (state.isRecording) return state;
  return {
    ...state,
    phase: 'error',
    error: 'runtime.editorOpenAfterRecordingFailed',
    recoverableError: editorOpenFailedError(),
  };
}

export function clearEditorRecovery(state: RecordingState): RecordingState {
  if (state.isRecording || !needsEditorRecovery(state.recoverableError)) return state;
  return { ...state, phase: 'idle', error: null, recoverableError: null };
}

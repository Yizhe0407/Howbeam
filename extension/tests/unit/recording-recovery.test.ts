import { describe, expect, it } from 'vitest';
import { makeRecordingState } from '../setup/recording-state';
import {
  clearEditorRecovery,
  editorOpenFailedError,
  markEditorOpenFailed,
  needsEditorRecovery,
  recordedTabClosedError,
} from '@/lib/recording/recording-recovery';

const idleState = makeRecordingState({ sessionId: 'session-1' });

describe('recording recovery state', () => {
  it('recognizes only recovery states that should lead to the editor', () => {
    expect(needsEditorRecovery(recordedTabClosedError())).toBe(true);
    expect(needsEditorRecovery(editorOpenFailedError())).toBe(true);
    expect(needsEditorRecovery({ code: 'CAPTURE_FAILED', copy: 'background.captureFailed' })).toBe(false);
    expect(needsEditorRecovery(null)).toBe(false);
  });

  it('marks an idle completed recording when automatic editor navigation fails', () => {
    expect(markEditorOpenFailed(idleState)).toMatchObject({
      isRecording: false,
      phase: 'error',
      recoverableError: editorOpenFailedError(),
    });
    expect(markEditorOpenFailed({ ...idleState, isRecording: true, phase: 'recording' })).toMatchObject({
      isRecording: true,
      phase: 'recording',
      recoverableError: null,
    });
  });

  it('clears editor recovery only after a successful retry', () => {
    expect(clearEditorRecovery({
      ...idleState,
      phase: 'error',
      recoverableError: recordedTabClosedError(),
    })).toMatchObject({ phase: 'idle', error: null, recoverableError: null });
    const unrelated = { ...idleState, recoverableError: { code: 'CAPTURE_FAILED', copy: 'background.captureFailed' as const } };
    expect(clearEditorRecovery(unrelated)).toBe(unrelated);
  });
});

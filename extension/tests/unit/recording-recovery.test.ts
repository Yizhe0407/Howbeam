import { describe, expect, it } from 'vitest';
import { needsEditorRecovery } from '@/lib/recording/recording-recovery';

describe('recording recovery state', () => {
  it('recognizes only recovery states that should lead to the editor', () => {
    expect(needsEditorRecovery({ code: 'RECORDED_TAB_CLOSED', copy: 'runtime.recordingTabClosed' })).toBe(true);
    expect(needsEditorRecovery({ code: 'EDITOR_OPEN_FAILED', copy: 'runtime.editorOpenAfterRecordingFailed' })).toBe(
      true,
    );
    expect(needsEditorRecovery({ code: 'CAPTURE_FAILED', copy: 'background.captureFailed' })).toBe(false);
    expect(needsEditorRecovery(null)).toBe(false);
  });
});

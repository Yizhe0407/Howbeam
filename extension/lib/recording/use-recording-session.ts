import { useEffect, useState } from 'react';
import { getRecordingState, onRecordingStateChange } from '../storage/storage';
import { createDefaultRecordingState } from '../storage/recording-state';
import { t } from '@/lib/shared/i18n';

/** Shared popup/editor recording state and any error reading it.
 * Omitting explicitSessionId follows the active recording (popup behavior).
 * Passing a string pins the session to that Project; passing null explicitly
 * means the editor URL has no Project and must not fall back to unrelated global state. */
export function useRecordingSession(explicitSessionId?: string | null) {
  const [recordingState, setRecordingState] = useState(createDefaultRecordingState);
  const [dataError, setDataError] = useState<string | null>(null);
  const sessionId = explicitSessionId === undefined
    ? recordingState.sessionId
    : explicitSessionId || null;

  useEffect(() => {
    let disposed = false;
    let changed = false;
    void getRecordingState()
      .then((state) => {
        // A storage change can arrive while the initial read is pending. Its
        // newer state wins even if the older read resolves last.
        if (!disposed && !changed) setRecordingState(state);
      })
      .catch((error) => {
        if (disposed) return;
        console.error('[howbeam] failed to read recording state', error);
        setDataError(t().runtime.recordingStateUnreadable);
      });

    const unsubscribe = onRecordingStateChange((state) => {
      changed = true;
      if (!disposed) setRecordingState(state);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return {
    ...recordingState,
    sessionId,
    recording: recordingState,
    dataError,
  };
}

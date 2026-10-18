import type { RecordingControlResult } from '../../runtime/messages';

export function controlFailure(error: string): RecordingControlResult {
  return { ok: false, error };
}

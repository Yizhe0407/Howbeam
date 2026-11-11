import type { RecordingControlResult } from '../../runtime/messages';
import type { CopyKey } from '../../shared/i18n/copy';

export function controlFailure(error: CopyKey): RecordingControlResult {
  return { ok: false, error };
}

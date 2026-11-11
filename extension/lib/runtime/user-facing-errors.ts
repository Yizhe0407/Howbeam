import type { CopyKey } from '@/lib/shared/i18n/copy';
import { describeBrowserError, isErrorPageError } from './browser-errors';

/**
 * An error that names the copy to show the user (e.g. "Step skipped: …").
 * Throw this instead of a plain Error when the failure is expected to surface
 * in state.error, so the user sees that copy, never the diagnostic "Error: …"
 * rendering describeBrowserError produces for logs.
 */
export class UserFacingError extends Error {
  constructor(readonly copy: CopyKey) {
    super(copy);
    this.name = 'UserFacingError';
  }
}

/** Raw extension-API failures the user can act on, mapped to localized copy.
 * Matched on the browser's English diagnostic text, which is not localized. */
const KNOWN_BROWSER_ERRORS: ReadonlyArray<{ pattern: RegExp; copy: CopyKey }> = [
  {
    pattern: /'<all_urls>' or 'activeTab' permission is required|cannot access contents of|missing host permission/i,
    copy: 'background.errorSiteAccessLost',
  },
  {
    pattern: /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/,
    copy: 'background.errorCaptureTooFast',
  },
  {
    pattern: /tabs cannot be edited right now|user may be dragging a tab/i,
    copy: 'background.errorBrowserBusy',
  },
];

/**
 * The copy to show the user for a failure: the copy a UserFacingError names,
 * a known browser API failure's own copy, and for anything else (an
 * unexpected internal or browser error) the caller's fallback. Raw
 * diagnostics belong in the console, not in the UI.
 */
export function userFacingErrorCopy(error: unknown, fallback: CopyKey): CopyKey {
  if (error instanceof UserFacingError) return error.copy;
  if (isErrorPageError(error)) return 'background.errorPageFailedToLoad';
  const diagnostic = describeBrowserError(error, '');
  if (diagnostic) {
    for (const known of KNOWN_BROWSER_ERRORS) {
      if (known.pattern.test(diagnostic)) return known.copy;
    }
  }
  return fallback;
}

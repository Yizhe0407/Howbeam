import { copyText } from '../shared/i18n/copy';
import { UserMessageError } from '../shared/user-message-error';
import { UserFacingError } from './user-facing-errors';

/**
 * Canonical UI catch-block: logs the failure, then returns what to show the
 * user. Only an error written for the user (UserMessageError, UserFacingError)
 * shows its own words; any other message is an internal diagnostic, often in
 * English, so the caller's localized fallback is shown instead.
 */
export function reportError(label: string, error: unknown, fallback: string): string {
  console.error(label, error);
  if (error instanceof UserMessageError) return error.message;
  if (error instanceof UserFacingError) return copyText(error.copy);
  return fallback;
}

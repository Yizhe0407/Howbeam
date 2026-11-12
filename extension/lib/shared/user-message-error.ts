/**
 * An error whose message is already the user's copy (rendered through t() where
 * it was thrown), so the UI may show it as is. Any other error's message is a
 * diagnostic for the console: the UI shows its own fallback copy instead.
 */
export class UserMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserMessageError';
  }
}

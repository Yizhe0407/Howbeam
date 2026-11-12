import { describe, expect, it } from 'vitest';
import { UserFacingError, userFacingErrorCopy } from '@/lib/runtime/user-facing-errors';

const FALLBACK = 'background.captureFailed';

describe('userFacingErrorCopy', () => {
  it('names the copy a UserFacingError carries', () => {
    expect(userFacingErrorCopy(new UserFacingError('background.stepSkippedPageChanged'), FALLBACK)).toBe(
      'background.stepSkippedPageChanged',
    );
  });

  it.each([
    ["Either the '<all_urls>' or 'activeTab' permission is required.", 'background.errorSiteAccessLost'],
    [
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      'background.errorSiteAccessLost',
    ],
    ['Missing host permission for the tab', 'background.errorSiteAccessLost'],
    ['This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.', 'background.errorCaptureTooFast'],
    ['Tabs cannot be edited right now (user may be dragging a tab).', 'background.errorBrowserBusy'],
    ['Frame with ID 0 is showing error page', 'background.errorPageFailedToLoad'],
  ])('names the copy for the browser error %j', (raw, expected) => {
    expect(userFacingErrorCopy(new Error(raw), FALLBACK)).toBe(expected);
  });

  it('never shows an unknown internal or browser diagnostic', () => {
    expect(userFacingErrorCopy(new Error('Snapshot capture context is incomplete.'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingErrorCopy(new DOMException('', 'AbortError'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingErrorCopy(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

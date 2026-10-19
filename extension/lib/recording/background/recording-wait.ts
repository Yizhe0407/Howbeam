import { browser } from 'wxt/browser';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import type { RecordingState, RecoverableRecordingError } from '../../storage/recording-state';
import { t } from '@/lib/shared/i18n';

/**
 * Why a live run is on hold in a page the recorder cannot run on. The run is
 * not ended: it waits, and picks up again once its tab (or a tab it follows
 * into) shows a recordable page.
 * - 'restricted-page': a browser/extension page or other non-web URL.
 * - 'site-access': Howbeam holds no host permission for the page, so the
 *   browser hides its URL and refuses injection.
 * - 'page-failed': the navigation failed and the tab shows the browser's
 *   error page.
 * - 'follow-failed': the run could not move into the tab the user switched
 *   to and stayed in the one it came from.
 */
export type RecordingWaitReason = 'restricted-page' | 'site-access' | 'page-failed' | 'follow-failed';

const WAIT_CODES: Record<RecordingWaitReason, string> = {
  'restricted-page': 'RECORDING_WAITING_RESTRICTED_PAGE',
  'site-access': 'RECORDING_WAITING_SITE_ACCESS',
  'page-failed': 'RECORDING_WAITING_PAGE_FAILED',
  'follow-failed': 'RECORDING_WAITING_FOLLOW_FAILED',
};

const WAIT_MESSAGES: Record<RecordingWaitReason, () => string> = {
  'restricted-page': () => t().background.waitingRestrictedPage,
  'site-access': () => t().background.waitingSiteAccess,
  'page-failed': () => t().background.errorPageFailedToLoad,
  'follow-failed': () => t().background.waitingFollowFailed,
};

/** Built on demand so the message is in the locale active when it is raised. */
export function recordingWaitError(reason: RecordingWaitReason): RecoverableRecordingError {
  return { code: WAIT_CODES[reason], message: WAIT_MESSAGES[reason]() };
}

export function isRecordingWaitError(error: RecoverableRecordingError | null): boolean {
  return error != null && (Object.values(WAIT_CODES) as string[]).includes(error.code);
}

export function isWaitingForSiteAccess(state: Pick<RecordingState, 'recoverableError'>): boolean {
  return state.recoverableError?.code === WAIT_CODES['site-access'];
}

/** Puts a live run on hold, keeping its phase (a paused run stays paused). */
export function markRecordingWait(state: RecordingState, reason: RecordingWaitReason): RecordingState {
  const error = recordingWaitError(reason);
  return { ...state, error: error.message, recoverableError: error };
}

/** Lifts a hold once the run is back on a recordable page; any other error is kept. */
export function clearRecordingWait(state: RecordingState): RecordingState {
  return isRecordingWaitError(state.recoverableError)
    ? { ...state, error: null, recoverableError: null }
    : state;
}

/**
 * Why a tab URL cannot host the recorder, or null when it can. Without the
 * `tabs` permission the browser reports no URL for a page Howbeam has no host
 * access to; with the <all_urls> grant a missing URL can only be a non-web
 * page (browser pages fall outside <all_urls>), so it is restricted, not a
 * permission problem.
 */
export async function unrecordableReason(url: string | undefined): Promise<RecordingWaitReason | null> {
  if (isRecordableTabUrl(url)) return null;
  if (url === undefined && !(await browser.permissions.contains({ origins: ['<all_urls>'] }))) {
    return 'site-access';
  }
  return 'restricted-page';
}

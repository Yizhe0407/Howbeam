import { browser } from 'wxt/browser';

/** The user declined the all-sites ask at a steps start: later starts do not ask on their own. */
export const CROSS_TAB_DECLINE_STORAGE_KEY = 'howbeam:cross-tab-declined';

/**
 * Whether the user has already declined the <all_urls> ask at a steps-recording
 * start. A remembered decline suppresses the automatic prompt on later starts;
 * the popup still offers a passive opt-in affordance.
 */
export async function hasDeclinedCrossTabRecording(): Promise<boolean> {
  const stored = await browser.storage.local.get(CROSS_TAB_DECLINE_STORAGE_KEY);
  return stored[CROSS_TAB_DECLINE_STORAGE_KEY] === true;
}

export async function markCrossTabRecordingDeclined(): Promise<void> {
  await browser.storage.local.set({ [CROSS_TAB_DECLINE_STORAGE_KEY]: true });
}

export async function clearCrossTabRecordingDecline(): Promise<void> {
  await browser.storage.local.remove(CROSS_TAB_DECLINE_STORAGE_KEY);
}

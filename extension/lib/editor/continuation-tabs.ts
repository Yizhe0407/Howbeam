import { browser } from 'wxt/browser';
import { isRecordableTab } from '../shared/restricted-urls';
import type { ContinuationTabOption } from './editor-app-model';
import { t } from '@/lib/shared/i18n';
import { UserMessageError } from '@/lib/shared/user-message-error';

/**
 * Fails closed on any prepared source-permission payload that does not name a
 * plain http(s) origin whose permission pattern covers exactly that origin.
 */
export function validatePreparedPermissionSource(
  sourceOrigin: string,
  permissionPattern: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceOrigin);
  } catch {
    throw new UserMessageError(t().editor.permission.invalidGrant);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin !== sourceOrigin ||
    permissionPattern !== `${parsed.origin}/*`
  ) {
    throw new UserMessageError(t().editor.permission.unsafeGrant);
  }
}

/** Most recently used first — shared by every surface that offers "return to
 * a recordable tab" so their orderings cannot drift apart. */
export function byMostRecentlyAccessed(
  first: { lastAccessed?: number },
  second: { lastAccessed?: number },
): number {
  return (second.lastAccessed ?? 0) - (first.lastAccessed ?? 0);
}

/** Every recordable open tab, most recently used first, so 「改在其他頁面接續」
 * can let the user pick explicitly instead of guessing a target for them. */
export async function listRecordableTabs(): Promise<ContinuationTabOption[]> {
  const tabs = await browser.tabs.query({});
  return tabs
    .filter(isRecordableTab)
    .sort(byMostRecentlyAccessed)
    .map((tab) => ({
      id: tab.id!,
      windowId: tab.windowId!,
      title: tab.title ?? '',
      url: tab.url!,
      ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
    }));
}

/** The tab preselected in the picker: the most recent tab showing something
 * OTHER than the Project's last-step URL. Auto-picking by recency alone kept
 * landing on the page the user had just finished recording. */
export function defaultContinuationTab(
  tabs: ContinuationTabOption[],
  lastStepUrl: string | null,
): ContinuationTabOption | null {
  return tabs.find((tab) => lastStepUrl === null || tab.url !== lastStepUrl) ?? tabs[0] ?? null;
}

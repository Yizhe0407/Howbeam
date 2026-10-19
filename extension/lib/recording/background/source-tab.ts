import { browser, type Browser } from 'wxt/browser';
import { isTrustedEditorSenderForSession } from '../../capture/recapture-guards';
import { getSteps } from '../../storage/step-repository';
import { isRestrictedUrl } from '../../shared/restricted-urls';
import { waitForTabComplete } from '../../runtime/tab-loading';
import { isErrorPageError } from '../../runtime/browser-errors';
import type { SourcePermissionPreflightSuccess, StartRecordingMessage, StartRecordingResult } from '../../runtime/messages';
import { t } from '@/lib/shared/i18n';

export type SourceTabAcquisition = { tab: Browser.tabs.Tab; reused: boolean };

/** Binds an editor sender to the session it may act on. Lives here because the
 * source-tab flows are exactly the operations an editor page nominates. */
export function isEditorSenderForSession(sender: Browser.runtime.MessageSender, sessionId: string): boolean {
  return isTrustedEditorSenderForSession(sender, browser.runtime.getURL('/editor.html'), sessionId);
}

function recapturePermissionPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

export function sourcePermissionPreflightSuccess(sourceUrl: string): SourcePermissionPreflightSuccess | null {
  const permissionPattern = recapturePermissionPattern(sourceUrl);
  if (!permissionPattern || isRestrictedUrl(sourceUrl)) return null;
  return {
    ok: true,
    sourceUrl,
    sourceOrigin: new URL(sourceUrl).origin,
    permissionPattern,
  };
}

/** The permission preflight recapture and continuation share: the source must
 * be a permissible http(s) URL outside the restricted list whose host
 * permission is already granted — start flows never prompt (the editor's
 * preflight owns the prompt). */
export async function checkSourcePermission(
  sourceUrl: string,
): Promise<'restricted' | 'permission-required' | 'granted'> {
  const preflight = sourcePermissionPreflightSuccess(sourceUrl);
  if (!preflight) return 'restricted';
  return (await browser.permissions.contains({ origins: [preflight.permissionPattern] }))
    ? 'granted'
    : 'permission-required';
}

async function findOrCreateSourceTab(
  sourceUrl: string,
  preferredTabId?: number,
): Promise<SourceTabAcquisition> {
  if (preferredTabId != null) {
    try {
      const preferred = await browser.tabs.get(preferredTabId);
      if (preferred.id != null && preferred.url === sourceUrl) {
        return { tab: await waitForTabComplete(preferred.id), reused: true };
      }
    } catch {
      // The nominated tab disappeared; fall through to another exact match.
    }
  }
  const tabs = await browser.tabs.query({});
  const exact = tabs.find((tab) => tab.id != null && tab.url === sourceUrl);
  if (exact?.id != null) return { tab: await waitForTabComplete(exact.id), reused: true };
  const created = await browser.tabs.create({ url: sourceUrl, active: false });
  if (created.id == null) throw new Error('Browser did not create a source tab.');
  try {
    return { tab: await waitForTabComplete(created.id), reused: false };
  } catch (error) {
    // Nothing owns this tab yet (no persisted state references it), so a load
    // timeout or removal race must close it here or every attempt leaks a tab.
    await browser.tabs.remove(created.id).catch((cleanupError) => {
      console.warn('[howbeam] failed to close an unloaded source tab', cleanupError);
    });
    throw error;
  }
}

/**
 * Closes a tab findOrCreateSourceTab created while no persisted state owns it
 * yet. Every failure path between creation and the state write that records
 * sourceTabCreated must call this, or each failed attempt leaks a stray tab —
 * prefer withUncommittedSourceTab, which makes the obligation structural.
 */
async function discardUncommittedSourceTab(source: SourceTabAcquisition): Promise<void> {
  if (source.reused || source.tab.id == null) return;
  await browser.tabs.remove(source.tab.id).catch((error) => {
    console.warn('[howbeam] failed to close an unused source tab', error);
  });
}

/**
 * Whether a loaded tab is showing the browser's own error page (offline, DNS
 * failure, refused connection…). Chrome keeps the failed URL in tab.url, so the
 * only reliable signal without the webNavigation permission is the scripting
 * API refusing the frame because it "is showing error page". Any other probe
 * failure is not evidence of a failed load and is left for injection to report.
 */
async function isShowingErrorPage(tab: Browser.tabs.Tab): Promise<boolean> {
  if (tab.url?.startsWith('chrome-error://')) return true;
  if (tab.id == null) return false;
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => true });
    return false;
  } catch (error) {
    return isErrorPageError(error);
  }
}

/**
 * Opens (or reuses) the exact-URL source tab and verifies it still shows that
 * URL after loading. On 'redirected' or 'unreachable' (the page failed to load
 * and the tab shows the browser's error page) any tab this call created has
 * already been closed; 'open-failed' has already been logged under `logLabel`.
 */
export async function openVerifiedSourceTab(
  sourceUrl: string,
  preferredTabId: number | undefined,
  logLabel: string,
): Promise<
  | { ok: true; source: SourceTabAcquisition }
  | { ok: false; reason: 'open-failed' | 'redirected' | 'unreachable' }
> {
  let source: SourceTabAcquisition;
  try {
    source = await findOrCreateSourceTab(sourceUrl, preferredTabId);
  } catch (error) {
    console.error(`[howbeam] ${logLabel}`, error);
    return { ok: false, reason: 'open-failed' };
  }
  if (await isShowingErrorPage(source.tab)) {
    await discardUncommittedSourceTab(source);
    return { ok: false, reason: 'unreachable' };
  }
  if (source.tab.id == null || source.tab.url !== sourceUrl) {
    await discardUncommittedSourceTab(source);
    return { ok: false, reason: 'redirected' };
  }
  return { ok: true, source };
}

/**
 * Scope helper for the window between acquiring a source tab and the state
 * write that records its ownership: `fn` receives `commit` and must call it
 * once persisted state owns the tab — every other exit (early failure return
 * or a throw) closes a tab this acquisition created. This turns the per-site
 * cleanup convention into a structural guarantee.
 */
export async function withUncommittedSourceTab<T>(
  source: SourceTabAcquisition,
  fn: (commit: () => void) => Promise<T>,
): Promise<T> {
  let committed = false;
  try {
    return await fn(() => {
      committed = true;
    });
  } finally {
    if (!committed) await discardUncommittedSourceTab(source);
  }
}

/** Where a continuation run resumes and where its steps go: the persisted URL
 * of the row the new steps follow (the Project's last row unless an entry is
 * named). Editors never supply a URL — a caller-provided one would let an
 * editor page nominate an arbitrary origin for the permission prompt. */
export async function resolveProjectContinuationAnchor(
  sessionId: string,
  afterEntryId?: string,
): Promise<{ sourceUrl: string; afterStepId: string | null } | null> {
  const steps = await getSteps(sessionId);
  if (afterEntryId === undefined) {
    const last = steps[steps.length - 1];
    return last ? { sourceUrl: last.url, afterStepId: null } : null;
  }
  // An entry is one row, or a snapshot group (anchor id = group id) whose last row ends it.
  const rows = steps.filter((step) => step.id === afterEntryId || step.groupId === afterEntryId);
  const last = rows[rows.length - 1];
  return last ? { sourceUrl: last.url, afterStepId: last.id } : null;
}

/**
 * Continuation resolves its own target tab because the editor page cannot be
 * recorded and holds no activeTab grant over the source site. Every precondition
 * recapture enforces applies here too: trusted editor, persisted source URL, an
 * explicit host permission, and an exact-URL tab.
 */
export async function resolveContinuationTab(
  message: StartRecordingMessage,
  sender: Browser.runtime.MessageSender,
): Promise<{ ok: true; tab: Browser.tabs.Tab } | Extract<StartRecordingResult, { ok: false }>> {
  if (!isEditorSenderForSession(sender, message.sessionId)) {
    return { ok: false, error: t().background.editorOnlyContinuation };
  }
  const anchor = await resolveProjectContinuationAnchor(message.sessionId, message.insertAfterEntryId);
  const sourceUrl = anchor?.sourceUrl;
  if (!sourceUrl) {
    return { ok: false, error: t().background.continuationSourceMissing };
  }
  const permission = await checkSourcePermission(sourceUrl);
  if (permission === 'restricted') {
    return { ok: false, error: t().background.restrictedContinuationSource };
  }
  if (permission === 'permission-required') {
    return { ok: false, error: t().background.continuationAccessRequired };
  }
  const opened = await openVerifiedSourceTab(
    sourceUrl,
    message.continuation?.preferredTabId,
    'failed to open continuation source tab',
  );
  if (!opened.ok) {
    if (opened.reason === 'unreachable') {
      return { ok: false, code: 'SOURCE_PAGE_UNREACHABLE', error: t().background.continuationSourceUnreachable };
    }
    return {
      ok: false,
      error: opened.reason === 'open-failed' ? t().background.sourceTabOpenFailed : t().background.continuationSourceRedirected,
    };
  }
  return { ok: true, tab: opened.source.tab };
}

import { browser } from 'wxt/browser';
import { isTrustedEditorSender, type RecaptureMessageSender } from '../../capture/recapture-guards';
import { isRecord, isSafeId } from '../../shared/validation';
import type { OpenLibraryResult } from '../../runtime/messages';
import { EXTENSION_PAGE_KINDS, EXTENSION_PAGE_PATHS, type ExtensionPageKind } from '../../runtime/extension-pages';

/**
 * Single-tab discovery for the extension's own pages: browser.tabs.query({ url })
 * can't find them without the `tabs` permission, which this minimal-permission
 * manifest avoids — so pages self-register instead (REGISTER_EXTENSION_PAGE)
 * and the background remembers where they are. The record lives in
 * browser.storage.session because tab ids are only ever valid within one
 * browsing session.
 *
 * Pages navigate their own tab between one another, so a tab changes kind
 * over its life. Every page registers, and a registration claims the tab
 * for exactly one kind: whatever a tab shows now is the only thing it is
 * remembered as.
 */
export { type ExtensionPageKind };

export interface ExtensionPageTab {
  tabId: number;
  /** null when the browser reported none; focusing then skips the window. */
  windowId: number | null;
}

// One key per kind, so a page registering itself never has to read-modify-write
// a record another page is registering at the same moment.
function pageTabKey(kind: ExtensionPageKind): string {
  return `howbeam:extensionPageTab:${kind}`;
}

function normalizeExtensionPageTab(value: unknown): ExtensionPageTab | null {
  if (!isRecord(value) || !isSafeId(value.tabId)) return null;
  return { tabId: value.tabId, windowId: isSafeId(value.windowId) ? value.windowId : null };
}

export function extensionPageUrl(kind: ExtensionPageKind): string {
  return browser.runtime.getURL(EXTENSION_PAGE_PATHS[kind]);
}

export async function findExtensionPage(kind: ExtensionPageKind): Promise<ExtensionPageTab | null> {
  const key = pageTabKey(kind);
  const stored = await browser.storage.session.get(key);
  return normalizeExtensionPageTab(stored[key]);
}

export async function forgetExtensionPage(kind: ExtensionPageKind): Promise<void> {
  await browser.storage.session.remove(pageTabKey(kind));
}

/** Drops a closed tab from every record; wired to tabs.onRemoved. */
export async function forgetClosedExtensionPage(tabId: number): Promise<void> {
  const keys = EXTENSION_PAGE_KINDS.map(pageTabKey);
  const stored = await browser.storage.session.get(keys);
  const stale = keys.filter((key) => normalizeExtensionPageTab(stored[key])?.tabId === tabId);
  if (stale.length > 0) await browser.storage.session.remove(stale);
}

/**
 * REGISTER_EXTENSION_PAGE handler. Trusts the sender's authenticated URL, not a
 * kind in the payload — isTrustedEditorSender requires both sender.url and
 * sender.tab.url to match the exact page, so an embedded frame can't register
 * as the page hosting it. Pages re-register on focus, so the most recently
 * used one wins when several are open.
 */
export async function registerExtensionPage(sender: RecaptureMessageSender): Promise<boolean> {
  const kind = extensionPageKindOf(sender);
  const tabId = sender.tab?.id;
  if (!kind || tabId == null) return false;
  // The tab stopped being whatever it showed before; drop those records first
  // so no other kind keeps pointing at a tab that now shows this page.
  const otherKeys = EXTENSION_PAGE_KINDS.filter((other) => other !== kind).map(pageTabKey);
  const stored = await browser.storage.session.get(otherKeys);
  const superseded = otherKeys.filter((key) => normalizeExtensionPageTab(stored[key])?.tabId === tabId);
  if (superseded.length > 0) await browser.storage.session.remove(superseded);
  await browser.storage.session.set({
    [pageTabKey(kind)]: { tabId, windowId: sender.tab?.windowId ?? null } satisfies ExtensionPageTab,
  });
  return true;
}

/**
 * Where a new editor goes when none is open: a fresh tab, or the requesting
 * extension page's own tab (page-to-page navigation stays in one tab).
 */
export type EditorPlacement = { kind: 'new-tab' } | { kind: 'replace'; tabId: number };

/**
 * Where OPEN_EDITOR should put a new editor. Only a non-editor extension page
 * asking to be replaced gets its own tab; everything else (the popup, the
 * recording toolbar, recovery) opens a tab of its own.
 */
export function editorPlacementFor(message: { inPlace?: boolean }, sender: RecaptureMessageSender): EditorPlacement {
  const kind = extensionPageKindOf(sender);
  const tabId = sender.tab?.id;
  if (!message.inPlace || !kind || kind === 'editor' || tabId == null) return { kind: 'new-tab' };
  return { kind: 'replace', tabId };
}

/** Which extension page sent a message, from the authenticated sender URL. */
function extensionPageKindOf(sender: RecaptureMessageSender): ExtensionPageKind | null {
  return EXTENSION_PAGE_KINDS.find((candidate) => isTrustedEditorSender(sender, extensionPageUrl(candidate))) ?? null;
}

export function createExtensionPage(url: string): Promise<unknown> {
  return browser.tabs.create({ url, active: true });
}

/**
 * Brings the remembered tab forward, re-pointing it at `url` first when
 * `navigate` is set. The background owns every cross-tab move; a page only
 * ever navigates its own tab, and only away from itself.
 */
export async function showExtensionPage(
  kind: ExtensionPageKind,
  tab: ExtensionPageTab,
  options: { url: string; navigate: boolean },
): Promise<void> {
  try {
    await browser.tabs.update(
      tab.tabId,
      options.navigate ? { url: options.url, active: true } : { active: true },
    );
  } catch (error) {
    // A record can outlive its tab when tabs.onRemoved is missed while the MV3
    // worker sleeps; only a rejected tabs.update proves that — a window-focus
    // failure below just means the window closed and must not spawn a duplicate page.
    console.warn(`[howbeam] the remembered ${kind} tab is gone; opening a new one`, error);
    await forgetExtensionPage(kind);
    await createExtensionPage(options.url);
    return;
  }
  if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
}

/**
 * Reuse-or-create for a page that holds no state worth handing over: an
 * existing tab is simply brought forward, never navigated.
 */
async function openExtensionPage(kind: ExtensionPageKind, url: string): Promise<void> {
  const tab = await findExtensionPage(kind);
  if (!tab) {
    await createExtensionPage(url);
    return;
  }
  await showExtensionPage(kind, tab, { url, navigate: false });
}

/** OPEN_LIBRARY handler. The library page shows the whole collection rather
 * than one Project, so reuse needs no handshake — plain focus is correct. */
export async function openLibraryPage(): Promise<OpenLibraryResult> {
  await openExtensionPage('library', extensionPageUrl('library'));
  return { ok: true };
}

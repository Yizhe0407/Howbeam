/** Minimal sender shape kept independent of the browser API so trust decisions
 * can be unit-tested without loading the MV3 background entrypoint. */
export interface RecaptureMessageSender {
  frameId?: number;
  url?: string;
  tab?: {
    id?: number;
    windowId?: number;
    url?: string;
  };
}

export interface RecaptureSourceContext {
  sourceTabId: number;
  sourceWindowId: number;
  sourceUrl: string;
}

function isSameExtensionPage(actualUrl: string | undefined, expectedUrl: string): boolean {
  if (!actualUrl) return false;
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    return (
      actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

/** Only the top-level editor document may issue editor-control messages.
 * Checking both sender.url (the actual frame) and tab.url (the top-level page)
 * prevents a child frame from inheriting trust from an editor tab. */
export function isTrustedEditorSender(sender: RecaptureMessageSender, editorUrl: string): boolean {
  return (
    sender.frameId === 0 &&
    sender.tab?.id != null &&
    isSameExtensionPage(sender.url, editorUrl) &&
    isSameExtensionPage(sender.tab.url, editorUrl)
  );
}

function hasSessionQuery(url: string | undefined, expectedSessionId: string): boolean {
  if (!url || !expectedSessionId) return false;
  try {
    return new URL(url).searchParams.get('sessionId') === expectedSessionId;
  } catch {
    return false;
  }
}

/** Requires both the actual editor frame and its top-level tab to carry the
 * expected Project identity. Use this after (or together with) origin/path trust
 * checks for recapture controls whose payload/context names a session. */
export function hasMatchingEditorSessionQuery(sender: RecaptureMessageSender, expectedSessionId: string): boolean {
  return hasSessionQuery(sender.url, expectedSessionId) && hasSessionQuery(sender.tab?.url, expectedSessionId);
}

export function isTrustedEditorSenderForSession(
  sender: RecaptureMessageSender,
  editorUrl: string,
  expectedSessionId: string,
): boolean {
  return isTrustedEditorSender(sender, editorUrl) && hasMatchingEditorSessionQuery(sender, expectedSessionId);
}

/** Recapture target messages are accepted only from the persisted, exact
 * top-level source document. Message payload URLs remain an additional check. */
export function isTrustedRecaptureSourceSender(
  sender: RecaptureMessageSender,
  context: RecaptureSourceContext,
): boolean {
  return (
    sender.frameId === 0 &&
    sender.tab?.id === context.sourceTabId &&
    sender.tab.windowId === context.sourceWindowId &&
    sender.url === context.sourceUrl &&
    sender.tab.url === context.sourceUrl
  );
}

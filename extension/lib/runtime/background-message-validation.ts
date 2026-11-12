export interface RuntimeMessageSenderLike {
  frameId?: number;
  url?: string;
  tab?: { id?: number; url?: string };
}

function sameExtensionOrigin(candidate: string | undefined, extensionUrl: string): boolean {
  if (!candidate) return false;
  try {
    const candidateUrl = new URL(candidate);
    const expectedUrl = new URL(extensionUrl);
    // URL.origin is the string "null" for chrome-extension:/moz-extension:
    // URLs, so compare the actual extension scheme and host instead.
    return candidateUrl.protocol === expectedUrl.protocol && candidateUrl.host === expectedUrl.host;
  } catch {
    return false;
  }
}

/** Rejects content scripts and child frames from extension-page-only lifecycle controls. */
export function isTrustedExtensionPageSender(sender: RuntimeMessageSenderLike, extensionUrl: string): boolean {
  if (!sameExtensionOrigin(sender.url, extensionUrl)) return false;
  if (!sender.tab) return true; // popup and other extension views are not associated with a tab
  return sender.frameId === 0 && sender.tab.id != null && sameExtensionOrigin(sender.tab.url, extensionUrl);
}

/**
 * In-page toolbars run in the dynamically injected top-frame recorder, not an
 * extension page. Bind their controls to the authoritative recorded tab; the
 * control handler separately verifies the unguessable run id and current phase.
 */
export function isTrustedRecorderControlSender(
  sender: RuntimeMessageSenderLike,
  recordedTabId: number | null,
): boolean {
  return recordedTabId !== null && sender.frameId === 0 && sender.tab?.id === recordedTabId;
}

/** Keeps MV3 alive only for the top frame that owns the active capture job,
 * plus the tab a recording is moving out of while that move is in flight. */
export function isTrustedKeepAliveSender(
  sender: RuntimeMessageSenderLike,
  state: {
    operation: 'recording' | 'recapture' | null;
    isRecording: boolean;
    tabId: number | null;
    recapture: { sourceTabId: number } | null;
  },
  followOriginTabId: number | null = null,
): boolean {
  // Any frame of the recorded tab: child frames run recorders too (relays, probes, frozen frames).
  if (sender.tab?.id == null) return false;
  if (state.operation === 'recording') {
    return state.isRecording && (state.tabId === sender.tab.id || followOriginTabId === sender.tab.id);
  }
  return state.operation === 'recapture' && state.recapture?.sourceTabId === sender.tab.id;
}

import { useEffect, useRef } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { isRecord } from '../shared/validation';
import type { EditorHandoffMessage, EditorHandoffResult } from '../runtime/messages';

export interface EditorHandoffOptions {
  /** The Project this page is showing, or null while it has none. */
  viewedSessionId: string | null;
  flushDescriptions: () => Promise<void>;
  selectEntry: (entryId: string) => Promise<void>;
}

function isEditorHandoffMessage(value: unknown): value is EditorHandoffMessage {
  return (
    isRecord(value) &&
    value.type === 'EDITOR_HANDOFF' &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    (value.entryId === undefined || (typeof value.entryId === 'string' && value.entryId.length > 0))
  );
}

/**
 * Answers whether this page can take over the Project the background was asked
 * to open. The page decides because it is the only component that knows which
 * Project it renders and whether a description is still unsaved; the background
 * keeps sole ownership of actually moving the tab.
 */
async function answerHandoff(
  message: EditorHandoffMessage,
  { viewedSessionId, flushDescriptions, selectEntry }: EditorHandoffOptions,
): Promise<EditorHandoffResult> {
  if (message.sessionId === viewedSessionId) {
    // Nothing will navigate this tab, so a blocked or failed save is not fatal
    // here: flushDescriptions has already put it in the page's own banner, and
    // selectEntry declines to switch while a draft awaits confirmation. Report
    // ready so the background just brings the tab forward.
    try {
      await flushDescriptions();
      if (message.entryId) await selectEntry(message.entryId);
    } catch {
      // Already surfaced by the two calls above.
    }
    return { ok: true, ready: true };
  }
  try {
    // Leaving this Project would discard whatever is still unsaved, so consent to
    // being navigated is conditional on the flush succeeding.
    await flushDescriptions();
  } catch {
    return { ok: false, error: 'editor.descriptionSaveRetry' };
  }
  return { ok: true, ready: false };
}

/** Installs the editor page's half of the single-editor-tab handoff. */
export function useEditorHandoff(options: EditorHandoffOptions): void {
  const latest = useRef(options);
  // Writing a ref during render breaks under concurrent rendering, where a
  // render can be discarded. Committing it in an effect keeps the current
  // callbacks available to the listener, which can only run after the commit.
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const listener = (
      message: unknown,
      sender: Browser.runtime.MessageSender,
      sendResponse: (response: EditorHandoffResult) => void,
    ) => {
      // Returning undefined leaves every other message untouched, so this
      // listener never closes a channel it does not own. Only the background
      // hands off; anything relayed from a tab carries a sender.tab.
      if (sender.tab || !isEditorHandoffMessage(message)) return undefined;
      void answerHandoff(message, latest.current).then(sendResponse);
      // Chrome's promise reply for runtime.onMessage shipped in 144 and was
      // reverted (crbug.com/40753031), so the page answers through the same
      // callback contract the background router uses.
      return true;
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);
}

import { browser } from 'wxt/browser';
import { sendToBackground } from './background-client';
import type { CancelStepRecaptureResult, FocusStepRecaptureSourceResult } from './messages';
import { copyText } from '@/lib/shared/i18n/copy';
import { UserMessageError } from '@/lib/shared/user-message-error';

/** Opens the options page, focusing it if it is already open. */
export async function openSettings(): Promise<void> {
  await browser.runtime.openOptionsPage();
}

/**
 * Asks the background to bring up the library. Only the background can find an
 * already-open library tab — an extension page cannot read tab URLs, and
 * neither can the background without the `tabs` permission, so discovery lives
 * with the registry in lib/recording/background/extension-page-tabs.ts.
 */
export async function openLibrary(): Promise<void> {
  const result = await sendToBackground({ type: 'OPEN_LIBRARY' });
  if (!result.ok) throw new UserMessageError(copyText(result.error));
}

/** Confirms a delivered recapture result so the background clears the durable
 * handoff. Fire-and-check: delivery failures are the caller's to log. */
export function ackStepRecaptureResult(runId: string, sessionId: string): Promise<unknown> {
  return browser.runtime.sendMessage({ type: 'ACK_STEP_RECAPTURE_RESULT', runId, sessionId });
}

/** Asks the background to focus the tab a recapture run is working in. */
export async function focusStepRecaptureSource(runId: string): Promise<FocusStepRecaptureSourceResult> {
  return await sendToBackground({ type: 'FOCUS_STEP_RECAPTURE_SOURCE', runId });
}

/** Asks the background to cancel a recapture run without touching content. */
export async function cancelStepRecapture(runId: string): Promise<CancelStepRecaptureResult> {
  return await sendToBackground({ type: 'CANCEL_STEP_RECAPTURE', runId });
}

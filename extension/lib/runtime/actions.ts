import { browser } from 'wxt/browser';
import type {
  CancelStepRecaptureResult,
  FocusStepRecaptureSourceResult,
  OpenLibraryResult,
} from './messages';
import {
  isCancelStepRecaptureResult,
  isFocusStepRecaptureSourceResult,
  isOpenLibraryResult,
  requireRuntimeMessageResult,
} from './runtime-message-result';

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
  const result = requireRuntimeMessageResult<OpenLibraryResult>(
    await browser.runtime.sendMessage({ type: 'OPEN_LIBRARY' }),
    isOpenLibraryResult,
  );
  if (!result.ok) throw new Error(result.error);
}

/** Confirms a delivered recapture result so the background clears the durable
 * handoff. Fire-and-check: delivery failures are the caller's to log. */
export function ackStepRecaptureResult(runId: string, sessionId: string): Promise<unknown> {
  return browser.runtime.sendMessage({ type: 'ACK_STEP_RECAPTURE_RESULT', runId, sessionId });
}

/** Asks the background to focus the tab a recapture run is working in. */
export async function focusStepRecaptureSource(runId: string): Promise<FocusStepRecaptureSourceResult> {
  return requireRuntimeMessageResult<FocusStepRecaptureSourceResult>(
    await browser.runtime.sendMessage({ type: 'FOCUS_STEP_RECAPTURE_SOURCE', runId }),
    isFocusStepRecaptureSourceResult,
  );
}

/** Asks the background to cancel a recapture run without touching content. */
export async function cancelStepRecapture(runId: string): Promise<CancelStepRecaptureResult> {
  return requireRuntimeMessageResult<CancelStepRecaptureResult>(
    await browser.runtime.sendMessage({ type: 'CANCEL_STEP_RECAPTURE', runId }),
    isCancelStepRecaptureResult,
  );
}

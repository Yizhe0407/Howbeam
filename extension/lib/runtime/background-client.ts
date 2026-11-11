import { browser } from 'wxt/browser';
import { contractFor } from './message-contract';
import type { BackgroundMessage, BackgroundResponse } from './messages';
import { requireRuntimeMessageResult } from './runtime-message-result';

/**
 * Sends a message to the background and returns its reply, checked against
 * the message's contract. A missing or malformed reply (the background was
 * restarting, or answered something else) throws `unavailableMessage`, or the
 * generic "background unavailable" copy.
 */
export async function sendToBackground<M extends BackgroundMessage>(
  message: M,
  unavailableMessage?: string,
): Promise<BackgroundResponse<M['type']>> {
  const reply: unknown = await browser.runtime.sendMessage(message);
  return requireRuntimeMessageResult(reply, contractFor(message.type).isResponse, unavailableMessage);
}

/** Tells every other extension page and the service worker that project data
 * was written, so work that follows the data (folder backup) reacts to the
 * change itself instead of polling for it. Best effort by design: a missed
 * message only delays follow-up work until the next page opens. */
const CHANNEL_NAME = 'howbeam-projects-changed';

function channelsSupported(): boolean {
  return typeof BroadcastChannel === 'function';
}

export function notifyProjectsChanged(): void {
  if (!channelsSupported()) return;
  try {
    // A fresh sender each time: a channel object never receives its own
    // messages, but other objects in the same page do.
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage('changed');
    channel.close();
  } catch {
    // Notifying must never fail a write that already committed.
  }
}

/** Calls `listener` for every project write made anywhere in the extension. Returns an unsubscribe function. */
export function subscribeProjectsChanged(listener: () => void): () => void {
  if (!channelsSupported()) return () => undefined;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = listener;
  return () => channel.close();
}

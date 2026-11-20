/** Tells every other extension page and the service worker that stored data
 * was written, so work that follows the data (folder backup, the Library)
 * reacts to the change itself instead of polling for it. Best effort by design:
 * a missed message only delays follow-up work until the next page opens.
 *
 * Projects and Series have separate channels: a Series edit changes no Project,
 * so it must not wake what follows Projects (the editor reload, folder backup). */
const PROJECTS_CHANNEL = 'howbeam-projects-changed';
const SERIES_CHANNEL = 'howbeam-series-changed';

function channelsSupported(): boolean {
  return typeof BroadcastChannel === 'function';
}

function notify(name: string): void {
  if (!channelsSupported()) return;
  try {
    // A fresh sender each time: a channel object never receives its own
    // messages, but other objects in the same page do.
    const channel = new BroadcastChannel(name);
    channel.postMessage('changed');
    channel.close();
  } catch {
    // Notifying must never fail a write that already committed.
  }
}

function subscribe(name: string, listener: () => void): () => void {
  if (!channelsSupported()) return () => undefined;
  const channel = new BroadcastChannel(name);
  channel.onmessage = listener;
  return () => channel.close();
}

export function notifyProjectsChanged(): void {
  notify(PROJECTS_CHANNEL);
}

/** Calls `listener` for every project write made anywhere in the extension. Returns an unsubscribe function. */
export function subscribeProjectsChanged(listener: () => void): () => void {
  return subscribe(PROJECTS_CHANNEL, listener);
}

export function notifySeriesChanged(): void {
  notify(SERIES_CHANNEL);
}

/** Calls `listener` for every Series write made anywhere in the extension. Returns an unsubscribe function. */
export function subscribeSeriesChanged(listener: () => void): () => void {
  return subscribe(SERIES_CHANNEL, listener);
}

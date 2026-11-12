import { browser } from 'wxt/browser';
import { throwIfAborted } from '../shared/abort';
import { t } from '@/lib/shared/i18n';
import { DownloadFailedError } from './export-errors';
import { UserMessageError } from '@/lib/shared/user-message-error';

type DownloadChangeListener = Parameters<typeof browser.downloads.onChanged.addListener>[0];

// Generous upper bound for a save-as dialog plus the transfer itself. It only
// exists so a missed terminal event cannot leak the listener and the blob.
const DOWNLOAD_SETTLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Holds a download's object URL until the transfer reaches a terminal state.
 * `downloads.download()` resolves as soon as the item is queued, so revoking
 * there can abort a file that is still being written to disk. Every
 * downloads-API caller must route its URL through here.
 */
function revokeWhenDownloadSettles(downloadId: number, url: string): void {
  const changes = browser.downloads.onChanged;
  // Runtimes without the event give no way to observe the transfer; the
  // previous best-effort behaviour is still better than never revoking.
  if (!changes) {
    URL.revokeObjectURL(url);
    return;
  }

  const settle = () => {
    clearTimeout(timer);
    changes.removeListener(listener);
    URL.revokeObjectURL(url);
  };
  const listener: DownloadChangeListener = (delta) => {
    if (delta.id !== downloadId) return;
    const state = delta.state?.current;
    if (state === 'complete' || state === 'interrupted') settle();
  };

  changes.addListener(listener);
  // Only ever reached asynchronously, so `timer` is always initialised by then.
  const timer = setTimeout(settle, DOWNLOAD_SETTLE_TIMEOUT_MS);
}

export interface BrowserDownloadOptions {
  signal?: AbortSignal;
  saveAs?: boolean;
}

/**
 * Preferred download path for extension pages, which hold the `downloads`
 * permission. Queueing through the downloads API means a failure to start
 * rejects instead of silently vanishing, and the transfer keeps running even
 * if the calling page closes immediately afterwards — the anchor-based
 * fallback loses the file when its document goes away before the browser
 * captures the blob. Resolves once the browser has accepted the download; the
 * object URL is held until the transfer settles.
 */
export async function downloadBlobViaBrowser(
  blob: Blob,
  filename: string,
  { signal, saveAs = true }: BrowserDownloadOptions = {},
): Promise<void> {
  throwIfAborted(signal);
  const url = URL.createObjectURL(blob);
  try {
    throwIfAborted(signal);
    let downloadId: number | undefined;
    try {
      downloadId = await browser.downloads.download({ url, filename, saveAs });
    } catch (rejection) {
      throw new DownloadFailedError(rejection);
    }
    if (typeof downloadId !== 'number')
      throw new DownloadFailedError(new UserMessageError(t().export.downloadNotStarted));
    revokeWhenDownloadSettles(downloadId, url);
  } catch (downloadError) {
    // Nothing was queued, so no consumer is left holding the URL.
    URL.revokeObjectURL(url);
    throw downloadError;
  }
}

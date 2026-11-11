import type { BackgroundRequest } from '../../runtime/messages';

export type SnapshotContext = NonNullable<BackgroundRequest<'HOWBEAM_READY'>['snapshotContext']>;

/** What a recorder reported when it became ready: snapshot recorders also send their capture context. */
export interface RecorderReady {
  snapshotContext?: SnapshotContext;
}

/** How long a startup waits for the injected recorder's READY handshake. */
export const RECORDER_READY_TIMEOUT_MS = 5_000;

/**
 * The one startup waiting for its recorder: the run and tab it injected
 * into. A READY from anything else (an older injection, another tab) does
 * not open it. Opening a new wait cancels the previous one.
 */
export function createRecorderGate(timeoutMs = RECORDER_READY_TIMEOUT_MS) {
  let pending: {
    runId: string;
    tabId: number;
    finish(ready: RecorderReady | null): void;
  } | null = null;

  function cancel(): void {
    pending?.finish(null);
  }

  /** Resolves with what the recorder reported, or null when it never did (timeout or cancel). */
  function open(runId: string, tabId: number): Promise<RecorderReady | null> {
    cancel();
    return new Promise((resolve) => {
      const entry = {
        runId,
        tabId,
        finish(ready: RecorderReady | null) {
          clearTimeout(timer);
          if (pending === entry) pending = null;
          resolve(ready);
        },
      };
      const timer = setTimeout(() => entry.finish(null), timeoutMs);
      pending = entry;
    });
  }

  function matches(runId: string, tabId: number): boolean {
    return pending?.runId === runId && pending.tabId === tabId;
  }

  /** Opens the wait for this run and tab, if one is pending. */
  function signal(runId: string, tabId: number, ready: RecorderReady): boolean {
    if (!pending || !matches(runId, tabId)) return false;
    pending.finish(ready);
    return true;
  }

  return { open, matches, signal, cancel, waiting: () => pending !== null };
}

export type RecorderGate = ReturnType<typeof createRecorderGate>;

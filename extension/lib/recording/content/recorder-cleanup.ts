/**
 * Teardown for everything the recorder installed in this document. One copy
 * of the content script runs per document (later injections reuse it), so
 * this registry lives in that copy, in the extension's isolated world: a page
 * script can neither see it nor trigger it. (A DOM event served the same
 * purpose before, but any page script that spelled its name could fire it
 * and tear the recorder down.)
 */
const cleanups = new Set<() => void>();

export function addRecorderCleanup(cleanup: () => void): void {
  cleanups.add(cleanup);
}

export function removeRecorderCleanup(cleanup: () => void): void {
  cleanups.delete(cleanup);
}

/** Runs every registered teardown once; each is removed before it runs. */
export function runRecorderCleanup(): void {
  for (const cleanup of [...cleanups]) {
    cleanups.delete(cleanup);
    try {
      cleanup();
    } catch (error) {
      console.error('[howbeam] recorder cleanup failed', error);
    }
  }
}

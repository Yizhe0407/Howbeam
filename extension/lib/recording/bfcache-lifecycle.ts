/** 防止從 bfcache 恢復的文件啟動已不屬於其流程的錄製器。 */

export interface BfcacheLifecycleTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface BfcacheLifecycleOptions {
  target: BfcacheLifecycleTarget;
  /** Hand the keep-alive port back before the document is frozen. */
  suspend(): void;
  /** Re-establish the keep-alive port after a restore. */
  resume(): void;
  /** Re-reads the authoritative recording state; true when this recorder's
   * run is still the live one after the document was restored. */
  isRunCurrent(): Promise<boolean>;
  /** Tears the restored recorder down (idempotent) when its run is over. */
  teardown(): void;
}

/** 凍結前關閉 keep-alive，從 bfcache 恢復後重新驗證所有權。 */
export function installBfcacheLifecycle(options: BfcacheLifecycleOptions): () => void {
  const onPageHide = () => {
    options.suspend();
  };
  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    void options
      .isRunCurrent()
      .then((current) => {
        if (current) options.resume();
        else options.teardown();
      })
      .catch(() => {
        // State was unreadable, which says nothing about the run: resume and let
        // the background's keep-alive rejection remain the authoritative backstop.
        options.resume();
      });
  };
  options.target.addEventListener('pagehide', onPageHide);
  options.target.addEventListener('pageshow', onPageShow);
  return () => {
    options.target.removeEventListener('pagehide', onPageHide);
    options.target.removeEventListener('pageshow', onPageShow);
  };
}

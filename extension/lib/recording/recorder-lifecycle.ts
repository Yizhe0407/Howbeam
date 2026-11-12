import { browser } from 'wxt/browser';
import { startKeepAlive } from '../runtime/keep-alive';
import { installBfcacheLifecycle } from './bfcache-lifecycle';
import { CONTENT_KEEPALIVE_INTERVAL_MS, CONTENT_KEEPALIVE_PORT_NAME } from './content-script-constants';

export interface RecorderLifecycleOptions {
  /** Re-reads the authoritative recording state; true when this recorder's
   * run is still the live one after the document was restored. */
  isRunCurrent(): Promise<boolean>;
  /** Idempotent teardown of the whole injected recorder. */
  cleanup(): void;
}

export interface RecorderLifecycle {
  /** Uninstalls the bfcache hooks and stops the keep-alive port. Safe to call
   * from within the cleanup passed in the options. */
  stop(): void;
}

/**
 * 讓注入的錄製器共用 keep-alive 與 bfcache 所有權檢查。
 * 遭拒或過時的錄製器會卸載，而非無限重連。
 */
export function installRecorderLifecycle(options: RecorderLifecycleOptions): RecorderLifecycle {
  const keepAlive = startKeepAlive(browser.runtime, {
    name: CONTENT_KEEPALIVE_PORT_NAME,
    intervalMs: CONTENT_KEEPALIVE_INTERVAL_MS,
    // The background rejected this recorder (or is unreachable for good):
    // tear down the injected UI instead of reconnecting forever.
    onRejected: () => options.cleanup(),
  });
  const uninstallBfcacheLifecycle = installBfcacheLifecycle({
    target: window,
    suspend: () => keepAlive.suspend(),
    resume: () => keepAlive.resume(),
    isRunCurrent: options.isRunCurrent,
    teardown: () => options.cleanup(),
  });
  return {
    stop() {
      uninstallBfcacheLifecycle();
      keepAlive.stop();
    },
  };
}

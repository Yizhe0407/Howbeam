import { useCallback, useEffect, useRef, useState } from 'react';
import { useDeferredBusy } from '../shared/use-deferred-busy';
import { subscribeProjectsChanged } from '../storage/change-notifier';
import { isFolderBackupSupported, pickBackupDirectory, requestBackupPermission } from './directory-handle';
import {
  clearBackupConfig,
  getBackupConfig,
  getBackupLastRun,
  saveBackupConfig,
  type BackupLastRun,
} from './backup-store';
import { getBackupAvailability, runFolderBackup, type BackupAvailability } from './backup-service';

/** Wait for edits to settle (typing a description writes on every pause) before backing up. */
const BACKUP_DEBOUNCE_MS = 3_000;
/** Edits that never pause (a recording adds a step every few hundred ms) must not postpone the backup forever. */
const BACKUP_MAX_WAIT_MS = 30_000;

/** Debounce with a ceiling: each call restarts the quiet period, but the callback
 * runs no later than `maxWaitMs` after the first call it is still waiting on. */
export function createBackupScheduler(
  callback: () => void,
  debounceMs = BACKUP_DEBOUNCE_MS,
  maxWaitMs = BACKUP_MAX_WAIT_MS,
): { schedule: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    const now = Date.now();
    if (timer === undefined) firstAt = now;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      callback();
    }, Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now)));
  };
  return { schedule, cancel };
}

/** Mount this on any long-lived page. It backs up when the page opens, a few
 * seconds after any project write anywhere in the extension, and when the tab
 * is hidden, so closing the editor right after an edit still leaves the folder
 * up to date. A no-op until the user turns backup on. */
export function useAutoFolderBackup(): void {
  useEffect(() => {
    const run = () => void runFolderBackup().catch((error) => console.warn('[howbeam] folder backup failed', error));
    const { schedule, cancel } = createBackupScheduler(run);
    run();
    const unsubscribe = subscribeProjectsChanged(schedule);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        cancel();
        run();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancel();
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}

export interface FolderBackupState {
  supported: boolean;
  loading: boolean;
  folderName: string | null;
  availability: BackupAvailability;
  lastRun: BackupLastRun | null;
  busy: boolean;
  /** `busy` once the work proves slow: what to render as in progress. */
  busyShown: boolean;
  error: boolean;
  /** Picks a folder, starts backing up straight away. */
  choose: () => Promise<void>;
  /** Re-grants access to the already chosen folder (needed after a browser restart). */
  reauthorize: () => Promise<void>;
  backUpNow: () => Promise<void>;
  turnOff: () => Promise<void>;
}

export function useFolderBackup(): FolderBackupState {
  const supported = isFolderBackupSupported();
  const [loading, setLoading] = useState(true);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [availability, setAvailability] = useState<BackupAvailability>('off');
  const [lastRun, setLastRun] = useState<BackupLastRun | null>(null);
  const [busy, setBusy] = useState(false);
  const busyShown = useDeferredBusy(busy);
  const inFlight = useRef(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    const [config, state, run] = await Promise.all([getBackupConfig(), getBackupAvailability(), getBackupLastRun()]);
    setFolderName(config?.folderName ?? null);
    setAvailability(state);
    setLastRun(run);
  }, []);

  useEffect(() => {
    let active = true;
    void refresh()
      .catch(() => setError(true))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  const guarded = useCallback(async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      console.error('[howbeam] folder backup action failed', actionError);
      setError(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [refresh]);

  const choose = useCallback(() => guarded(async () => {
    const directory = await pickBackupDirectory();
    if (!directory) return;
    await saveBackupConfig({ directory, folderName: directory.name });
    await runFolderBackup();
  }), [guarded]);

  const reauthorize = useCallback(() => guarded(async () => {
    const config = await getBackupConfig();
    if (!config) return;
    if ((await requestBackupPermission(config.directory)) === 'granted') await runFolderBackup();
  }), [guarded]);

  const backUpNow = useCallback(() => guarded(async () => {
    await runFolderBackup();
  }), [guarded]);

  const turnOff = useCallback(() => guarded(clearBackupConfig), [guarded]);

  return { supported, loading, folderName, availability, lastRun, busy, busyShown, error, choose, reauthorize, backUpNow, turnOff };
}

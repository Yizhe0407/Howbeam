import { runWithDatabase } from '../storage/database';
import type { BackupDirectory } from './directory-handle';

/** Where the chosen folder and the bookkeeping of what has been written live:
 * device-local state in the main database, beside the projects it backs up. */
export interface BackupManifestEntry {
  /** The project revisions the file on disk reflects; older entries lack one and never match. */
  contentRevision: number;
  stepEditRevision: number;
  metadataRevision: number;
  filename: string;
  backedUpAt: number;
}

export interface BackupLastRun {
  at: number;
  written: number;
  failed: number;
  error: string | null;
  /** Absent in runs saved before failures were named. */
  failedTitles?: string[];
}

export interface BackupConfig {
  directory: BackupDirectory;
  folderName: string;
}

const CONFIG_KEY = 'backup:config';
const LAST_RUN_KEY = 'backup:lastRun';

export async function getBackupConfig(): Promise<BackupConfig | null> {
  const value = (await runWithDatabase((db) => db.get('deviceState', CONFIG_KEY))) as Partial<BackupConfig> | undefined;
  return value && 'directory' in value ? (value as BackupConfig) : null;
}

/** Choosing a folder starts a fresh manifest, so every project is written to the new place. */
export async function saveBackupConfig(config: BackupConfig): Promise<void> {
  await runWithDatabase(async (db) => {
    const tx = db.transaction(['deviceState', 'backupManifest'], 'readwrite');
    await Promise.all([
      tx.objectStore('deviceState').put(config, CONFIG_KEY),
      tx.objectStore('deviceState').delete(LAST_RUN_KEY),
      tx.objectStore('backupManifest').clear(),
      tx.done,
    ]);
  });
}

/** Stops backing up. Files already in the folder are left alone. */
export async function clearBackupConfig(): Promise<void> {
  await runWithDatabase(async (db) => {
    const tx = db.transaction(['deviceState', 'backupManifest'], 'readwrite');
    await Promise.all([
      tx.objectStore('deviceState').delete(CONFIG_KEY),
      tx.objectStore('deviceState').delete(LAST_RUN_KEY),
      tx.objectStore('backupManifest').clear(),
      tx.done,
    ]);
  });
}

export async function getBackupManifest(): Promise<Map<string, BackupManifestEntry>> {
  return runWithDatabase(async (db) => {
    const manifest = new Map<string, BackupManifestEntry>();
    for (
      let cursor = await db.transaction('backupManifest').store.openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      manifest.set(cursor.key, cursor.value as BackupManifestEntry);
    }
    return manifest;
  });
}

export async function putBackupManifestEntry(projectId: string, entry: BackupManifestEntry): Promise<void> {
  await runWithDatabase((db) => db.put('backupManifest', entry, projectId));
}

export async function getBackupLastRun(): Promise<BackupLastRun | null> {
  const value = (await runWithDatabase((db) => db.get('deviceState', LAST_RUN_KEY))) as
    | Partial<BackupLastRun>
    | undefined;
  return value && 'written' in value ? (value as BackupLastRun) : null;
}

export async function saveBackupLastRun(run: BackupLastRun): Promise<void> {
  await runWithDatabase((db) => db.put('deviceState', run, LAST_RUN_KEY));
}

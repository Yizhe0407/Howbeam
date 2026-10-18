import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { BackupDirectory } from './directory-handle';

/** Where the chosen folder and the bookkeeping of what has been written live.
 * A separate database from the project data on purpose: the folder handle is
 * device-local state, and keeping it out of the main schema means turning
 * backup on never needs a project-database migration. */
export interface BackupManifestEntry {
  /** The project revisions the file on disk reflects; older entries lack one and never match. */
  contentRevision: number;
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

interface BackupDB extends DBSchema {
  kv: {
    key: string;
    value: BackupConfig | BackupLastRun;
  };
  manifest: {
    key: string;
    value: BackupManifestEntry;
  };
}

const CONFIG_KEY = 'config';
const LAST_RUN_KEY = 'lastRun';

let databasePromise: Promise<IDBPDatabase<BackupDB>> | null = null;

function database(): Promise<IDBPDatabase<BackupDB>> {
  databasePromise ??= openDB<BackupDB>('stepmark-backup', 1, {
    upgrade(db) {
      db.createObjectStore('kv');
      db.createObjectStore('manifest');
    },
  });
  return databasePromise;
}

export async function closeBackupDatabase(): Promise<void> {
  if (!databasePromise) return;
  const db = await databasePromise;
  db.close();
  databasePromise = null;
}

export async function getBackupConfig(): Promise<BackupConfig | null> {
  const value = await (await database()).get('kv', CONFIG_KEY);
  return value && 'directory' in value ? value : null;
}

/** Choosing a folder starts a fresh manifest, so every project is written to the new place. */
export async function saveBackupConfig(config: BackupConfig): Promise<void> {
  const db = await database();
  const tx = db.transaction(['kv', 'manifest'], 'readwrite');
  await Promise.all([
    tx.objectStore('kv').put(config, CONFIG_KEY),
    tx.objectStore('kv').delete(LAST_RUN_KEY),
    tx.objectStore('manifest').clear(),
    tx.done,
  ]);
}

/** Stops backing up. Files already in the folder are left alone. */
export async function clearBackupConfig(): Promise<void> {
  const db = await database();
  const tx = db.transaction(['kv', 'manifest'], 'readwrite');
  await Promise.all([tx.objectStore('kv').clear(), tx.objectStore('manifest').clear(), tx.done]);
}

export async function getBackupManifest(): Promise<Map<string, BackupManifestEntry>> {
  const db = await database();
  const [keys, values] = await Promise.all([db.getAllKeys('manifest'), db.getAll('manifest')]);
  return new Map(keys.map((key, index) => [key, values[index]]));
}

export async function putBackupManifestEntry(projectId: string, entry: BackupManifestEntry): Promise<void> {
  await (await database()).put('manifest', entry, projectId);
}

export async function getBackupLastRun(): Promise<BackupLastRun | null> {
  const value = await (await database()).get('kv', LAST_RUN_KEY);
  return value && 'written' in value ? value : null;
}

export async function saveBackupLastRun(run: BackupLastRun): Promise<void> {
  await (await database()).put('kv', run, LAST_RUN_KEY);
}

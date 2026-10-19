/** The slice of the File System Access API the backup uses. `queryPermission`,
 * `requestPermission` and `showDirectoryPicker` are not in the TypeScript DOM
 * lib, so they are typed here once instead of cast at every call site. */
export type BackupPermission = 'granted' | 'prompt' | 'denied';

export interface BackupDirectory extends FileSystemDirectoryHandle {
  queryPermission(descriptor: { mode: 'readwrite' }): Promise<BackupPermission>;
  requestPermission(descriptor: { mode: 'readwrite' }): Promise<BackupPermission>;
}

/** Chromium only: Firefox has no directory picker, so backup falls back to manual export there. */
export function isFolderBackupSupported(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Opens the folder picker. Must be called from a user gesture. Returns null if the user cancels. */
export async function pickBackupDirectory(): Promise<BackupDirectory | null> {
  const picker = (globalThis as unknown as {
    showDirectoryPicker: (options: { mode: 'readwrite'; id: string }) => Promise<BackupDirectory>;
  }).showDirectoryPicker;
  try {
    return await picker({ mode: 'readwrite', id: 'howbeam-backup' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

export async function queryBackupPermission(directory: BackupDirectory): Promise<BackupPermission> {
  try {
    return await directory.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/** Re-asks for write access after a browser restart. Must be called from a user gesture. */
export async function requestBackupPermission(directory: BackupDirectory): Promise<BackupPermission> {
  try {
    return await directory.requestPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

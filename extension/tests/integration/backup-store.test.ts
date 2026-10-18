import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  clearBackupConfig,
  closeBackupDatabase,
  getBackupConfig,
  getBackupLastRun,
  getBackupManifest,
  putBackupManifestEntry,
  saveBackupConfig,
  saveBackupLastRun,
  type BackupConfig,
} from '@/lib/backup/backup-store';

// A real FileSystemDirectoryHandle is structured-cloneable; the fake only needs a name.
const config = { directory: { kind: 'directory', name: 'Backups' }, folderName: 'Backups' } as unknown as BackupConfig;

afterAll(closeBackupDatabase);

describe('backup store', () => {
  it('keeps the chosen folder and the per-project manifest', async () => {
    expect(await getBackupConfig()).toBeNull();
    await saveBackupConfig(config);
    await putBackupManifestEntry('p1', { contentRevision: 5, stepEditRevision: 0, metadataRevision: 0, filename: 'a.stepmark', backedUpAt: 6 });
    await saveBackupLastRun({ at: 7, written: 1, failed: 0, error: null });

    expect((await getBackupConfig())?.folderName).toBe('Backups');
    expect((await getBackupManifest()).get('p1')?.filename).toBe('a.stepmark');
    expect((await getBackupLastRun())?.written).toBe(1);
  });

  it('starts a fresh manifest when a different folder is chosen', async () => {
    await saveBackupConfig({ ...config, folderName: 'Elsewhere' });
    expect((await getBackupManifest()).size).toBe(0);
    expect(await getBackupLastRun()).toBeNull();
  });

  it('forgets everything when backup is turned off', async () => {
    await putBackupManifestEntry('p2', { contentRevision: 1, stepEditRevision: 0, metadataRevision: 0, filename: 'b.stepmark', backedUpAt: 2 });
    await clearBackupConfig();
    expect(await getBackupConfig()).toBeNull();
    expect((await getBackupManifest()).size).toBe(0);
  });
});

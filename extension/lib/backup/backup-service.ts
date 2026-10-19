import { exportProjectArchive } from '../export/project-archive-serialize';
import { getProjectSummaries } from '../storage/project-repository';
import { getSteps } from '../storage/step-repository';
import type { ProjectSummary } from '../storage/models';
import { queryBackupPermission } from './directory-handle';
import { runBackup, type BackupResult } from './backup-runner';
import {
  getBackupConfig,
  getBackupManifest,
  putBackupManifestEntry,
  saveBackupLastRun,
} from './backup-store';

const LOCK_NAME = 'howbeam-folder-backup';

/** The run waiting for the lock another run holds; one is enough for any number of changes. */
let pendingRun: Promise<BackupResult> | null = null;

async function buildArchive(project: ProjectSummary): Promise<Blob> {
  return exportProjectArchive(await getSteps(project.id), {
    metadata: {
      title: project.title,
      description: project.description,
      sections: project.sections,
      tags: project.tags,
    },
  });
}

/** Whether a backup could run right now without asking the user for anything. */
export type BackupAvailability = 'off' | 'needs-permission' | 'ready';

export async function getBackupAvailability(): Promise<BackupAvailability> {
  const config = await getBackupConfig();
  if (!config) return 'off';
  return (await queryBackupPermission(config.directory)) === 'granted' ? 'ready' : 'needs-permission';
}

/**
 * Backs up changed projects to the chosen folder if (and only if) it is
 * already writable. Safe to call from every open page: a Web Lock keeps
 * overlapping calls (library and editor both open) from being two writers
 * racing on the same files. A call that finds the lock held does not drop its
 * request, because the holder may already have read the projects: it waits for
 * the lock and runs once afterwards (further calls until then share that one
 * pending run). Returns null when backup is off or not permitted.
 */
export async function runFolderBackup(): Promise<BackupResult | null> {
  const config = await getBackupConfig();
  if (!config || (await queryBackupPermission(config.directory)) !== 'granted') return null;

  const run = async (): Promise<BackupResult> => {
    const result = await runBackup({
      directory: config.directory,
      listProjects: getProjectSummaries,
      buildArchive,
      getManifest: getBackupManifest,
      putManifestEntry: putBackupManifestEntry,
    });
    await saveBackupLastRun({
      at: Date.now(),
      written: result.written,
      failed: result.failed,
      error: result.error,
      failedTitles: result.failedTitles,
    });
    return result;
  };

  if (typeof navigator === 'undefined' || !navigator.locks) return run();
  const held = await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? run() : null));
  if (held) return held;
  pendingRun ??= (async () =>
    navigator.locks.request(LOCK_NAME, () => {
      // From here on the run reads fresh data, so a later change needs a new pending run.
      pendingRun = null;
      return run();
    }))();
  return pendingRun;
}

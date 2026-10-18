import { projectFilenameStem } from '../export/project-export-contract';
import type { ProjectSummary } from '../storage/models';
import type { BackupManifestEntry } from './backup-store';

/** One backup file per project, named so a person can recognise it and so two
 * projects with the same title never collide. The id part is what keeps the
 * name stable across runs; a rename of the project renames the file. */
export function backupFilename(project: Pick<ProjectSummary, 'id' | 'title'>): string {
  return `${projectFilenameStem({ title: project.title })}-${project.id.slice(0, 8)}.stepmark`;
}

/** Plain-ASCII name used when the folder's file system rejects the readable
 * one (some systems cannot store non-Latin names). Still unique per project. */
export function fallbackBackupFilename(project: Pick<ProjectSummary, 'id'>): string {
  return `stepmark-${project.id.slice(0, 8)}.stepmark`;
}

function isFilenameRejection(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'TypeMismatchError') || error instanceof TypeError;
}

export interface BackupResult {
  written: number;
  skipped: number;
  failed: number;
  error: string | null;
  /** Titles of the projects that failed, so the UI can say which. */
  failedTitles: string[];
}

export interface BackupRunDeps {
  directory: FileSystemDirectoryHandle;
  listProjects: () => Promise<ProjectSummary[]>;
  buildArchive: (project: ProjectSummary) => Promise<Blob>;
  getManifest: () => Promise<Map<string, BackupManifestEntry>>;
  putManifestEntry: (projectId: string, entry: BackupManifestEntry) => Promise<void>;
  now?: () => number;
}

async function fileExists(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    throw error;
  }
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, blob: Blob): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
  // The browser commits the temporary swap file on close, so a failed write never leaves a half-written backup.
  await writable.close();
}

/**
 * Writes every project that changed since its last successful backup. Backups
 * are additive: a project deleted from Stepmark keeps its file, because a
 * backup that vanishes together with the original is not a backup. One failing
 * project never blocks the others, and is retried on the next run.
 */
export async function runBackup(deps: BackupRunDeps): Promise<BackupResult> {
  const { directory } = deps;
  const now = deps.now ?? Date.now;
  const [projects, manifest] = await Promise.all([deps.listProjects(), deps.getManifest()]);
  const result: BackupResult = { written: 0, skipped: 0, failed: 0, error: null, failedTitles: [] };

  for (const project of projects) {
    const preferred = backupFilename(project);
    const fallback = fallbackBackupFilename(project);
    const previous = manifest.get(project.id);
    let filename = preferred;
    try {
      // A file the user removed by hand counts as "not backed up", not as up to date.
      // Revisions, not updatedAt: the clock can move back or two edits share a millisecond.
      if (previous && previous.contentRevision === project.contentRevision
        && previous.metadataRevision === project.metadataRevision
        && (previous.filename === preferred || previous.filename === fallback)
        && await fileExists(directory, previous.filename)) {
        result.skipped += 1;
        continue;
      }
      const archive = await deps.buildArchive(project);
      try {
        await writeFile(directory, preferred, archive);
      } catch (error) {
        if (!isFilenameRejection(error)) throw error;
        filename = fallback;
        await writeFile(directory, fallback, archive);
      }
      if (previous && previous.filename !== filename) {
        await directory.removeEntry(previous.filename).catch(() => undefined);
      }
      await deps.putManifestEntry(project.id, {
        contentRevision: project.contentRevision,
        metadataRevision: project.metadataRevision,
        filename,
        backedUpAt: now(),
      });
      result.written += 1;
    } catch (error) {
      result.failed += 1;
      result.failedTitles.push(project.title);
      result.error = error instanceof Error ? error.message : String(error);
      console.warn('[stepmark] backup of a project failed', project.id, filename, error);
    }
  }
  return result;
}

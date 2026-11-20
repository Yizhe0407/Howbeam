import { projectFilenameStem } from '../export/project-export-contract';
import { projectDisplayTitle, type ProjectSummary } from '../storage/models';
import { seriesDisplayTitle, type ProjectSeries } from '../storage/series-model';
import type { BackupManifestEntry, SeriesBackupManifestEntry } from './backup-store';

const SERIES_EXTENSION = 'howbeam-series';

/** One backup file per project, named so a person can recognise it and so two
 * projects with the same title never collide. The id part is what keeps the
 * name stable across runs; a rename of the project renames the file. */
export function backupFilename(project: Pick<ProjectSummary, 'id' | 'title'>): string {
  return `${projectFilenameStem({ title: projectDisplayTitle(project.title) })}-${project.id.slice(0, 8)}.howbeam`;
}

/** Plain-ASCII name used when the folder's file system rejects the readable
 * one (some systems cannot store non-Latin names). Still unique per project. */
export function fallbackBackupFilename(project: Pick<ProjectSummary, 'id'>): string {
  return `howbeam-${project.id.slice(0, 8)}.howbeam`;
}

/** Like backupFilename, for the Series file that holds every member Project in full. */
export function seriesBackupFilename(series: Pick<ProjectSeries, 'id' | 'title'>): string {
  return `${projectFilenameStem({ title: seriesDisplayTitle(series.title) })}-${series.id.slice(0, 8)}.${SERIES_EXTENSION}`;
}

export function fallbackSeriesBackupFilename(series: Pick<ProjectSeries, 'id'>): string {
  return `howbeam-series-${series.id.slice(0, 8)}.${SERIES_EXTENSION}`;
}

/**
 * What a Series file reflects: its title, its order and each member's
 * revisions. Any change to one of them makes the file out of date.
 */
export function seriesBackupFingerprint(series: ProjectSeries, projectsById: ReadonlyMap<string, ProjectSummary>): string {
  return JSON.stringify([
    series.title,
    series.projectIds.flatMap((id) => {
      const project = projectsById.get(id);
      return project ? [[id, project.contentRevision, project.stepEditRevision, project.metadataRevision]] : [];
    }),
  ]);
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
  listSeries: () => Promise<ProjectSeries[]>;
  buildSeriesArchive: (series: ProjectSeries) => Promise<Blob>;
  getSeriesManifest: () => Promise<Map<string, SeriesBackupManifestEntry>>;
  putSeriesManifestEntry: (seriesId: string, entry: SeriesBackupManifestEntry) => Promise<void>;
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

/** Writes under the readable name, or the plain one when the folder rejects it, and drops a file the item had under another name. Returns the name used. */
async function writeBackupFile(
  directory: FileSystemDirectoryHandle,
  names: { preferred: string; fallback: string; previous?: string },
  blob: Blob,
): Promise<string> {
  let filename = names.preferred;
  try {
    await writeFile(directory, names.preferred, blob);
  } catch (error) {
    if (!isFilenameRejection(error)) throw error;
    filename = names.fallback;
    await writeFile(directory, names.fallback, blob);
  }
  if (names.previous && names.previous !== filename) {
    await directory.removeEntry(names.previous).catch(() => undefined);
  }
  return filename;
}

/**
 * Writes every project that changed since its last successful backup. Backups
 * are additive: a project deleted from Howbeam keeps its file, because a
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
        && previous.stepEditRevision === project.stepEditRevision
        && previous.metadataRevision === project.metadataRevision
        && (previous.filename === preferred || previous.filename === fallback)
        && await fileExists(directory, previous.filename)) {
        result.skipped += 1;
        continue;
      }
      const archive = await deps.buildArchive(project);
      filename = await writeBackupFile(directory, { preferred, fallback, previous: previous?.filename }, archive);
      await deps.putManifestEntry(project.id, {
        contentRevision: project.contentRevision,
        stepEditRevision: project.stepEditRevision,
        metadataRevision: project.metadataRevision,
        filename,
        backedUpAt: now(),
      });
      result.written += 1;
    } catch (error) {
      result.failed += 1;
      result.failedTitles.push(projectDisplayTitle(project.title));
      result.error = error instanceof Error ? error.message : String(error);
      console.warn('[howbeam] backup of a project failed', project.id, filename, error);
    }
  }

  // Each Series also gets a file holding every member in full, so one file restores it whole.
  // Projects are written first: a Series file is only as fresh as the revisions it records.
  const [seriesList, seriesManifest] = await Promise.all([deps.listSeries(), deps.getSeriesManifest()]);
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  for (const series of seriesList) {
    if (!series.projectIds.some((id) => projectsById.has(id))) continue;
    const preferred = seriesBackupFilename(series);
    const fallback = fallbackSeriesBackupFilename(series);
    const previous = seriesManifest.get(series.id);
    const fingerprint = seriesBackupFingerprint(series, projectsById);
    try {
      if (previous && previous.fingerprint === fingerprint
        && (previous.filename === preferred || previous.filename === fallback)
        && await fileExists(directory, previous.filename)) {
        result.skipped += 1;
        continue;
      }
      const archive = await deps.buildSeriesArchive(series);
      const filename = await writeBackupFile(directory, { preferred, fallback, previous: previous?.filename }, archive);
      await deps.putSeriesManifestEntry(series.id, { fingerprint, filename, backedUpAt: now() });
      result.written += 1;
    } catch (error) {
      result.failed += 1;
      result.failedTitles.push(seriesDisplayTitle(series.title));
      result.error = error instanceof Error ? error.message : String(error);
      console.warn('[howbeam] backup of a series failed', series.id, error);
    }
  }
  return result;
}

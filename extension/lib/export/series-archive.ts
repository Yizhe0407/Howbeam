import { unzipSync } from 'fflate';
import { throwIfAborted } from '../shared/abort';
import { type Step } from '../storage/models';
import { getProject } from '../storage/project-repository';
import { getSteps } from '../storage/step-repository';
import { SERIES_LIMITS, sanitizeSeriesTitle, type ProjectSeries } from '../storage/series-model';
import {
  PROJECT_ARCHIVE_LIMITS,
  type ImportedProjectArchive,
  type ProjectArchiveMetadataInput,
  type ProjectArchiveSource,
} from './project-archive-contract';
import { importProjectArchive, parseArchiveManifest, readArchiveBytes, readArchiveEntries } from './project-archive-import';
import { exportProjectArchive } from './project-archive-serialize';
import { assertExactKeys, expectArray, expectString, fail } from './project-archive-validation';
import { buildZipBlob, paddedZipOrdinal } from './streaming-zip';

export const SERIES_ARCHIVE_FORMAT = 'howbeam-series';
/** Version 1 is a ZIP: `series.json` (title and the order of the Projects)
 * plus each Project as an unchanged `.howbeam` project archive under `projects/`. */
export const SERIES_ARCHIVE_VERSION = 1;
export const SERIES_ARCHIVE_MIME_TYPE = 'application/vnd.howbeam.series+zip';
export const SERIES_ARCHIVE_EXTENSION = 'howbeam-series';
const SERIES_MANIFEST_PATH = 'series.json';
const SERIES_MANIFEST_KEYS = ['format', 'version', 'title', 'projects'] as const;
const PROJECT_PATH = /^projects\/\d{3}\.howbeam$/;

export const SERIES_ARCHIVE_LIMITS = Object.freeze({
  maxProjects: SERIES_LIMITS.maxProjects,
  /** Four full-size Projects; a larger Series still exports, Project by Project. */
  maxArchiveBytes: PROJECT_ARCHIVE_LIMITS.maxArchiveBytes * 4,
});

export interface SeriesArchiveProject {
  steps: readonly Step[];
  metadata: ProjectArchiveMetadataInput;
}

export interface ImportedSeriesArchive {
  title: string;
  /** In Series order; section start ids already refer to each Project's remapped step ids. */
  projects: ImportedProjectArchive[];
}

function projectPath(index: number): string {
  return `projects/${paddedZipOrdinal(index + 1, 100)}.howbeam`;
}

/** A self-contained Series file: its title, its order, and every Project in full. */
export async function exportSeriesArchive(
  title: string,
  projects: readonly SeriesArchiveProject[],
  options: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const { signal } = options;
  if (projects.length > SERIES_ARCHIVE_LIMITS.maxProjects) fail('LIMIT_EXCEEDED', 'The series has too many projects.');
  const files: Array<[string, Uint8Array]> = [];
  for (const [index, project] of projects.entries()) {
    const archive = await exportProjectArchive(project.steps, { signal, metadata: project.metadata });
    files.push([projectPath(index), new Uint8Array(await archive.arrayBuffer())]);
    throwIfAborted(signal);
  }
  const manifest = {
    format: SERIES_ARCHIVE_FORMAT,
    version: SERIES_ARCHIVE_VERSION,
    title: sanitizeSeriesTitle(title),
    projects: files.map(([path]) => path),
  };
  const zip = await buildZipBlob((addFile) => {
    addFile(SERIES_MANIFEST_PATH, new TextEncoder().encode(JSON.stringify(manifest)));
    for (const [path, bytes] of files) addFile(path, bytes);
  });
  throwIfAborted(signal);
  if (zip.size > SERIES_ARCHIVE_LIMITS.maxArchiveBytes) fail('ARCHIVE_TOO_LARGE', 'The encoded series archive is too large.');
  return new Blob([zip], { type: SERIES_ARCHIVE_MIME_TYPE });
}

/** The stored Series as a file, its Projects read from storage in Series order. */
export async function exportStoredSeriesArchive(series: ProjectSeries, options: { signal?: AbortSignal } = {}): Promise<Blob> {
  const projects: SeriesArchiveProject[] = [];
  for (const projectId of series.projectIds) {
    throwIfAborted(options.signal);
    const project = await getProject(projectId);
    if (!project) continue;
    projects.push({
      steps: await getSteps(projectId),
      metadata: { title: project.title, description: project.description, sections: project.sections },
    });
  }
  return exportSeriesArchive(series.title, projects, options);
}

/** Whether `bytes` is a Series file rather than a Project file. Anything unreadable is left to the Project importer to reject. */
export function isSeriesArchive(bytes: Uint8Array): boolean {
  try {
    return SERIES_MANIFEST_PATH in unzipSync(bytes, { filter: (file) => file.name === SERIES_MANIFEST_PATH });
  } catch {
    return false;
  }
}

/** Strictly parses a Series file; every Project in it is checked by the Project importer. */
export async function importSeriesArchive(
  source: ProjectArchiveSource,
  options: { signal?: AbortSignal } = {},
): Promise<ImportedSeriesArchive> {
  const { signal } = options;
  const entries = readArchiveEntries(await readArchiveBytes(source, SERIES_ARCHIVE_LIMITS.maxArchiveBytes, signal));
  const manifest = parseArchiveManifest(entries.get(SERIES_MANIFEST_PATH), SERIES_MANIFEST_PATH);

  if (manifest.format !== SERIES_ARCHIVE_FORMAT) fail('INVALID_ARCHIVE', 'Unrecognized series archive format.');
  if (!Number.isSafeInteger(manifest.version)) fail('INVALID_ARCHIVE', 'series.version must be an integer.');
  if (manifest.version !== SERIES_ARCHIVE_VERSION) {
    fail('UNSUPPORTED_VERSION', `Series archive version ${String(manifest.version)} is not supported.`);
  }
  assertExactKeys(manifest, SERIES_MANIFEST_KEYS, 'series');
  const title = expectString(manifest.title, 'series.title', SERIES_LIMITS.maxTitleLength);
  const paths = expectArray(manifest.projects, 'series.projects');
  if (paths.length > SERIES_ARCHIVE_LIMITS.maxProjects) fail('LIMIT_EXCEEDED', 'The series has too many projects.');

  const listed = new Set<string>();
  for (const [index, path] of paths.entries()) {
    const value = expectString(path, `series.projects[${index}]`, 64, false);
    if (!PROJECT_PATH.test(value)) fail('INVALID_ARCHIVE', `series.projects[${index}] is not a project path.`);
    if (listed.has(value)) fail('DUPLICATE_ID', `series.projects lists ${JSON.stringify(value)} twice.`);
    if (!entries.has(value)) fail('INVALID_ARCHIVE', `series.projects[${index}] has no file in the archive.`);
    listed.add(value);
  }
  if (entries.size !== listed.size + 1) fail('INVALID_ARCHIVE', 'The archive contains files the series manifest does not list.');

  const projects: ImportedProjectArchive[] = [];
  for (const path of listed) {
    throwIfAborted(signal);
    projects.push(await importProjectArchive(entries.get(path)!, { signal }));
  }
  return { title: sanitizeSeriesTitle(title), projects };
}

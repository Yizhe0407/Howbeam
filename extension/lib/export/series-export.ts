import { throwIfAborted } from '../shared/abort';
import { projectDisplayTitle, type Project, type StepEntry } from '../storage/models';
import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';
import { getProjectStructureSnapshot } from '../storage/project-structure';
import { SeriesProjectExportError, SeriesTooLargeError } from './export-errors';
import { type PdfExportSettings } from './pdf-export-settings';
import {
  PROJECT_EXPORT_LIMITS,
  projectExportFilename,
  projectFilenameStem,
  projectPublication,
  type ProjectExportMetadata,
  type Publication,
} from './project-export-contract';
import { generatePublicationHtml } from './project-export-html';
import { generatePublicationMarkdownArchive, writePublicationMarkdown } from './project-export-markdown';
import { generatePublicationPdf } from './project-export-pdf';
import { buildZipBlob, paddedZipOrdinal } from './streaming-zip';

export type SeriesExportFormat = 'pdf' | 'html' | 'markdown';
/** One document for the whole Series, or one file per Project in a ZIP. */
export type SeriesExportMode = 'merged' | 'separate';

export interface SeriesExportOptions {
  signal?: AbortSignal;
  pdfSettings?: Partial<PdfExportSettings>;
}

export interface SeriesExportFile {
  blob: Blob;
  filename: string;
}

interface SeriesProject {
  /** 0-based place in the Series, empty Projects included. */
  index: number;
  title: string;
  project: Project;
  entries: readonly StepEntry[];
}

/** Each Project of the Series that has steps, read from the same snapshot the editor exports. */
async function* readSeriesProjects(projectIds: readonly string[], signal?: AbortSignal): AsyncGenerator<SeriesProject> {
  for (const [index, projectId] of projectIds.entries()) {
    throwIfAborted(signal);
    const { project, entries } = await getProjectStructureSnapshot(projectId);
    if (entries.length > 0) yield { index, title: projectDisplayTitle(project.title), project, entries };
  }
}

function projectMetadata({ title, project }: SeriesProject): ProjectExportMetadata {
  return { title, description: project.description, filename: title, sections: project.sections };
}

/** Exports the whole Series in the chosen mode; resolves null when no Project has steps. */
export async function generateSeriesExport(
  series: { title: string },
  projectIds: readonly string[],
  format: SeriesExportFormat,
  mode: SeriesExportMode,
  options: SeriesExportOptions = {},
): Promise<SeriesExportFile | null> {
  if (mode === 'merged') return generateSeriesDocument(series, projectIds, format, options);
  const blob = await generateSeriesZip(projectIds, format, options);
  return blob && { blob, filename: `${projectFilenameStem(series)}.zip` };
}

/**
 * One ZIP with each Project of a Series exported on its own, in Series order:
 * `01-hr.pdf`, `02-apex.pdf`… (Markdown: one folder per Project). Projects are
 * rendered one at a time. A Project with no steps is left out and the others
 * keep the number of their place; resolves null when none had any.
 */
export async function generateSeriesZip(
  projectIds: readonly string[],
  format: SeriesExportFormat,
  options: SeriesExportOptions = {},
): Promise<Blob | null> {
  const { signal, pdfSettings } = options;
  let exported = 0;
  const blob = await buildZipBlob(async (addFile) => {
    for await (const item of readSeriesProjects(projectIds, signal)) {
      const metadata = projectMetadata(item);
      const publication = projectPublication(item.entries, metadata);
      const ordinal = paddedZipOrdinal(item.index + 1, projectIds.length);
      try {
        if (format === 'markdown') {
          await writePublicationMarkdown(addFile, publication, { signal, folder: `${ordinal}-${projectFilenameStem(metadata)}` });
        } else {
          const file = format === 'pdf'
            ? await generatePublicationPdf(publication, { signal, settings: pdfSettings })
            : await generatePublicationHtml(publication, { signal });
          addFile(`${ordinal}-${projectExportFilename(metadata, format)}`, new Uint8Array(await file.arrayBuffer()));
        }
      } catch (error) {
        throwIfAborted(signal);
        throw new SeriesProjectExportError(item.title, error);
      }
      exported += 1;
    }
  });
  throwIfAborted(signal);
  return exported === 0 ? null : blob;
}

/**
 * One document for the whole Series: its title on the cover, then each Project
 * that has steps as a part with its own heading, sections and steps beneath.
 * The merged document may be no larger than one Project may be, so whatever a
 * Project can export, a Series can too; a larger one is refused before any
 * rendering starts.
 */
export async function generateSeriesDocument(
  series: { title: string },
  projectIds: readonly string[],
  format: SeriesExportFormat,
  options: SeriesExportOptions = {},
): Promise<SeriesExportFile | null> {
  const { signal, pdfSettings } = options;
  const projects: SeriesProject[] = [];
  for await (const item of readSeriesProjects(projectIds, signal)) projects.push(item);
  if (projects.length === 0) return null;

  const entryCount = projects.reduce((sum, item) => sum + item.entries.length, 0);
  const storedBytes = projects.reduce((sum, item) => sum + item.project.storageBytes, 0);
  if (entryCount > PROJECT_EXPORT_LIMITS.maxEntries || storedBytes > PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes) {
    throw new SeriesTooLargeError();
  }

  const publication: Publication = {
    title: series.title,
    filename: series.title,
    parts: projects.map((item) => ({
      title: item.title,
      description: item.project.description,
      entries: item.entries,
      sections: item.project.sections,
    })),
  };
  switch (format) {
    case 'pdf':
      return { blob: await generatePublicationPdf(publication, { signal, settings: pdfSettings }), filename: projectExportFilename(publication, 'pdf') };
    case 'html':
      return { blob: await generatePublicationHtml(publication, { signal }), filename: projectExportFilename(publication, 'html') };
    case 'markdown':
      return { blob: (await generatePublicationMarkdownArchive(publication, { signal })).blob, filename: projectExportFilename(publication, 'markdown-archive') };
  }
}

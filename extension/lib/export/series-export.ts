import { throwIfAborted } from '../shared/abort';
import { projectDisplayTitle } from '../storage/models';
import { getProjectStructureSnapshot } from '../storage/project-structure';
import { SeriesProjectExportError } from './export-errors';
import { type PdfExportSettings } from './pdf-export-settings';
import { projectExportFilename, projectFilenameStem, type ProjectExportMetadata } from './project-export-contract';
import { generateProjectHtml } from './project-export-html';
import { writeProjectMarkdown } from './project-export-markdown';
import { generateProjectPdf } from './project-export-pdf';
import { buildZipBlob, paddedZipOrdinal } from './streaming-zip';

export type SeriesExportFormat = 'pdf' | 'html' | 'markdown';

export interface SeriesExportOptions {
  signal?: AbortSignal;
  pdfSettings?: Partial<PdfExportSettings>;
}

/** The ZIP's own name, from the Series title. */
export function seriesExportFilename(seriesTitle: string): string {
  return `${projectFilenameStem({ title: seriesTitle })}.zip`;
}

/**
 * One ZIP with each Project of a Series exported on its own, in Series order:
 * `01-hr.pdf`, `02-apex.pdf`… (Markdown: one folder per Project). Projects are
 * read and rendered one at a time, from the same snapshot the editor exports.
 * A Project with no steps is left out; resolves null when none had any.
 */
export async function generateSeriesZip(
  projectIds: readonly string[],
  format: SeriesExportFormat,
  options: SeriesExportOptions = {},
): Promise<Blob | null> {
  const { signal, pdfSettings } = options;
  let exported = 0;
  const blob = await buildZipBlob(async (addFile) => {
    for (const [index, projectId] of projectIds.entries()) {
      throwIfAborted(signal);
      const { project, entries } = await getProjectStructureSnapshot(projectId);
      if (entries.length === 0) continue;
      const title = projectDisplayTitle(project.title);
      const metadata: ProjectExportMetadata = {
        title,
        description: project.description,
        filename: title,
        sections: project.sections,
      };
      const ordinal = paddedZipOrdinal(index + 1, projectIds.length);
      try {
        if (format === 'markdown') {
          await writeProjectMarkdown(addFile, entries, metadata, { signal, folder: `${ordinal}-${projectFilenameStem(metadata)}` });
        } else {
          const file = format === 'pdf'
            ? await generateProjectPdf(entries, metadata, { signal, settings: pdfSettings })
            : await generateProjectHtml(entries, metadata, { signal });
          addFile(`${ordinal}-${projectExportFilename(metadata, format)}`, new Uint8Array(await file.arrayBuffer()));
        }
      } catch (error) {
        throwIfAborted(signal);
        throw new SeriesProjectExportError(title, error);
      }
      exported += 1;
    }
  });
  throwIfAborted(signal);
  return exported === 0 ? null : blob;
}

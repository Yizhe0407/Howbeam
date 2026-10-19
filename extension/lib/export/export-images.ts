import { downloadBlobViaBrowser } from './download-utils';
import { RedactionReviewRequiredError } from './export-errors';
import { throwIfAborted } from '../shared/abort';
import { buildStepEntries, type Step } from '../storage/models';
import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';
import { renderEntryImages, type EntryImageBudget } from './project-export-render';
import { buildZipBlob, paddedZipOrdinal } from './streaming-zip';

/** Derived from the persisted-step limits so every stored project stays
 * exportable; the total allows twice the persisted screenshot payload because
 * annotated re-encodes can exceed their raw sources. */
export const IMAGE_ZIP_EXPORT_LIMITS = Object.freeze({
  maxEntries: PERSISTED_STEP_LIMITS.maxStepsPerProject,
  maxImageBytes: PERSISTED_STEP_LIMITS.maxScreenshotBytes,
  maxTotalImageBytes: PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes * 2,
});

export { RedactionReviewRequiredError };

export class ImageZipExportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageZipExportLimitError';
  }
}

const IMAGE_ZIP_ENTRY_BUDGET: EntryImageBudget = {
  ...IMAGE_ZIP_EXPORT_LIMITS,
  createLimitError: (violation) => {
    switch (violation.kind) {
      case 'entry-count':
        return new ImageZipExportLimitError('Project contains too many images to export safely.');
      case 'image-bytes':
        return new ImageZipExportLimitError(`Image ${violation.ordinal} exceeds the per-image ZIP export limit.`);
      case 'total-bytes':
        return new ImageZipExportLimitError('Images exceed the total ZIP export limit.');
    }
  },
};

export function localDateStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface ExportImagesResult {
  filename: string;
  itemCount: number;
}

/**
 * Composites each entry's annotations and privacy redactions onto its screenshot and packs them
 * into a single ZIP (01.jpg, 02.jpg, …), then triggers a download. Gives the
 * user the raw annotated images to assemble a doc however they like. Each
 * single-image group collapses to one file (all its click boxes on the one
 * shared screenshot); each ordinary step produces its own file.
 */
export async function exportImagesAsZip(
  steps: Step[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ExportImagesResult | null> {
  throwIfAborted(signal);
  if (steps.length === 0) return null;

  const entries = buildStepEntries(steps);
  if (entries.length === 0) return null;
  let done = 0;

  // renderEntryImages pipelines with a lookahead of one but still holds at
  // most one decoded canvas at a time, and it composites through the shared
  // rasterization path, which refuses redaction-review-required entries
  // fail-closed. The ZIP stream references each annotated JPEG's bytes
  // without copying them again (addFile takes ownership).
  const blob = await buildZipBlob(async (addFile) => {
    for await (const rendered of renderEntryImages(entries, signal, IMAGE_ZIP_ENTRY_BUDGET)) {
      addFile(`${paddedZipOrdinal(rendered.content.ordinal, entries.length)}.jpg`, rendered.imageBytes);
      onProgress?.(++done, entries.length);
    }
    throwIfAborted(signal);
  });
  throwIfAborted(signal);

  const filename = `howbeam-images-${localDateStamp()}.zip`;
  await downloadBlobViaBrowser(blob, filename, { signal });
  return { filename, itemCount: entries.length };
}

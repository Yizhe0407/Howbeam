import { downloadBlobViaBrowser } from './download-utils';
import { RedactionReviewRequiredError } from './export-errors';
import { throwIfAborted } from '../shared/abort';
import type { StepEntry } from '../storage/models';
import { renderEntryImages } from './project-export-render';
import { buildZipBlob, paddedZipOrdinal } from './streaming-zip';

export { RedactionReviewRequiredError };

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
  entries: readonly StepEntry[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ExportImagesResult | null> {
  throwIfAborted(signal);
  if (entries.length === 0) return null;
  let done = 0;

  // renderEntryImages pipelines with a lookahead of one but still holds at
  // most one decoded canvas at a time, and it composites through the shared
  // rasterization path, which refuses redaction-review-required entries
  // fail-closed. The ZIP stream references each annotated JPEG's bytes
  // without copying them again (addFile takes ownership).
  const blob = await buildZipBlob(async (addFile) => {
    for await (const rendered of renderEntryImages(entries, signal)) {
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

import { isAbortError, throwIfAborted } from '../shared/abort';
import { compositeStepEntry } from './entry-render';
import { RedactionReviewRequiredError, StepImageError } from './export-errors';
import { getEntryPrivacyState, type Step, type StepEntry } from '../storage/models';
import {
  PROJECT_EXPORT_LIMITS,
  ProjectExportLimitError,
  IMAGE_MIME_TYPE,
  textValue,
} from './project-export-contract';
import { t } from '@/lib/shared/i18n';

export type RenderedEntryContent = {
  entryId: string;
  ordinal: number;
  description: string;
  annotations: readonly Step[];
};

/**
 * The heading every publication prints above an entry's screenshot. A Mark
 * entry has no description of its own (only its annotations do, and the editor
 * offers no field for one), so it gets no heading text rather than the
 * missing-description placeholder; only an entry with nothing at all to say
 * shows the placeholder.
 */
export function entryHeading(entry: RenderedEntryContent): string {
  const description = textValue(entry.description);
  if (description || entry.annotations.length > 0) return description;
  return t().export.missingDescription;
}

/** Whether any marker has a label. Markers start unlabelled, and a list of
 * nothing but placeholders says less than the numbered image already does. */
export function hasAnnotationText(annotations: readonly { description: string }[]): boolean {
  return annotations.some((annotation) => annotation.description.trim() !== '');
}

export type RenderedEntryImage = {
  content: RenderedEntryContent;
  imageBytes: Uint8Array;
};

export type RenderedMarkdownEntry = RenderedEntryContent & {
  imageReference: string;
};

function sortedAnnotations(entry: StepEntry): readonly Step[] {
  if (entry.kind === 'single') return [];
  return [...entry.annotations].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function entryOwner(entry: StepEntry): Step {
  return entry.kind === 'single' ? entry.step : entry.anchor;
}

function assertImageBudget(imageBytes: number, totalImageBytes: number, ordinal: number): void {
  if (!Number.isSafeInteger(imageBytes) || imageBytes < 0 || imageBytes > PROJECT_EXPORT_LIMITS.maxImageBytes) {
    throw new ProjectExportLimitError(`Step ${ordinal} exceeds the per-image export limit.`);
  }
  if (totalImageBytes + imageBytes > PROJECT_EXPORT_LIMITS.maxTotalImageBytes) {
    throw new ProjectExportLimitError('Project images exceed the total export limit.');
  }
}

export async function* renderEntryImages(
  entries: readonly StepEntry[],
  signal?: AbortSignal,
): AsyncGenerator<RenderedEntryImage> {
  if (entries.length > PROJECT_EXPORT_LIMITS.maxEntries) {
    throw new ProjectExportLimitError('Project contains too many entries to export safely.');
  }

  // Refuse up front, for every format alike, naming every step that needs a
  // mask review. Rendering such an entry would only yield a fully black image.
  const reviewOrdinals = entries.flatMap((entry, index) => (getEntryPrivacyState(entry).reviewRequired ? [index + 1] : []));
  if (reviewOrdinals.length > 0) throw new RedactionReviewRequiredError(reviewOrdinals);

  // A corrupt screenshot must say which step it is, not just fail the export.
  const queue = entries.entries();
  const startNext = () => {
    const next = queue.next();
    if (next.done) return undefined;
    const [index, entry] = next.value;
    const ordinal = index + 1;
    const image = compositeStepEntry(entry, IMAGE_MIME_TYPE).catch((error: unknown) => {
      throw isAbortError(error) ? error : new StepImageError(ordinal, error);
    });
    return { entry, ordinal, image };
  };

  let declaredImageBytes = 0;
  let actualImageBytes = 0;

  // Pipelined with a lookahead of exactly one: entry N+1's composite (decode →
  // draw → encode, largely off the JS thread) runs while entry N's bytes are
  // budget-checked, copied, and consumed (zip CRC/append or base64 encode).
  // The next composite only starts after the previous one has resolved, so at
  // most ONE decoded canvas exists at any moment — the memory ceiling the old
  // strictly sequential loop enforced is preserved; the only extra retention
  // is one encoded image blob, already bounded by the per-image budget.
  throwIfAborted(signal);
  let pending = startNext();
  try {
    while (pending) {
      const { entry, ordinal } = pending;
      const image = await pending.image;
      pending = undefined;
      throwIfAborted(signal);
      pending = startNext();

      // Blob.size is available without allocating another full copy, so reject
      // oversized output before arrayBuffer() and base64's ~4/3 expansion.
      assertImageBudget(image.size, declaredImageBytes, ordinal);
      declaredImageBytes += image.size;
      const bytes = new Uint8Array(await image.arrayBuffer());
      throwIfAborted(signal);
      // Recheck the owned buffer as defense-in-depth for non-native Blob-like
      // implementations used by tests or future adapters.
      assertImageBudget(bytes.byteLength, actualImageBytes, ordinal);
      actualImageBytes += bytes.byteLength;

      const owner = entryOwner(entry);
      yield {
        content: {
          entryId: owner.id,
          ordinal,
          description: textValue(owner.description),
          annotations: sortedAnnotations(entry),
        },
        imageBytes: bytes,
      };
    }
  } finally {
    // A budget/abort throw or an abandoned generator can leave the lookahead
    // composite in flight; observe it so a late rejection (e.g. a compositing
    // failure racing a cancellation) is never reported as unhandled.
    pending?.image.catch(() => {});
  }
}

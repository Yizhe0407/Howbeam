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

type EntryImageBudgetViolation =
  | { kind: 'entry-count' }
  | { kind: 'image-bytes'; ordinal: number }
  | { kind: 'total-bytes'; ordinal: number };

/**
 * Limits plus an error factory so every consumer of the shared sequential
 * rendering loop (project publications, image ZIP export) enforces the same
 * budget checks while surfacing its own error class and wording.
 */
export interface EntryImageBudget {
  maxEntries: number;
  maxImageBytes: number;
  maxTotalImageBytes: number;
  createLimitError: (violation: EntryImageBudgetViolation) => Error;
}

const PROJECT_ENTRY_IMAGE_BUDGET: EntryImageBudget = {
  maxEntries: PROJECT_EXPORT_LIMITS.maxEntries,
  maxImageBytes: PROJECT_EXPORT_LIMITS.maxImageBytes,
  maxTotalImageBytes: PROJECT_EXPORT_LIMITS.maxTotalImageBytes,
  createLimitError: (violation) => {
    switch (violation.kind) {
      case 'entry-count':
        return new ProjectExportLimitError('Project contains too many entries to export safely.');
      case 'image-bytes':
        return new ProjectExportLimitError(`Step ${violation.ordinal} exceeds the per-image project export limit.`);
      case 'total-bytes':
        return new ProjectExportLimitError('Project images exceed the total export limit.');
    }
  },
};

function assertEntryImageBudget(
  budget: EntryImageBudget,
  imageBytes: number,
  totalImageBytes: number,
  ordinal: number,
): void {
  if (!Number.isSafeInteger(imageBytes) || imageBytes < 0 || imageBytes > budget.maxImageBytes) {
    throw budget.createLimitError({ kind: 'image-bytes', ordinal });
  }
  if (totalImageBytes + imageBytes > budget.maxTotalImageBytes) {
    throw budget.createLimitError({ kind: 'total-bytes', ordinal });
  }
}

export async function* renderEntryImages(
  entries: readonly StepEntry[],
  signal?: AbortSignal,
  budget: EntryImageBudget = PROJECT_ENTRY_IMAGE_BUDGET,
): AsyncGenerator<RenderedEntryImage> {
  if (entries.length > budget.maxEntries) {
    throw budget.createLimitError({ kind: 'entry-count' });
  }

  // Refuse up front, for every format alike, naming every step that needs a
  // mask review. Rendering such an entry would only yield a fully black image.
  const reviewOrdinals = entries.flatMap((entry, index) => (getEntryPrivacyState(entry).reviewRequired ? [index + 1] : []));
  if (reviewOrdinals.length > 0) throw new RedactionReviewRequiredError(reviewOrdinals);

  // A corrupt screenshot must say which step it is, not just fail the export.
  const composite = (index: number): Promise<Blob> =>
    compositeStepEntry(entries[index], IMAGE_MIME_TYPE).catch((error: unknown) => {
      throw isAbortError(error) ? error : new StepImageError(index + 1, error);
    });

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
  let index = 0;
  let pending = entries.length > 0 ? composite(0) : undefined;
  try {
    while (pending) {
      const image = await pending;
      pending = undefined;
      throwIfAborted(signal);
      const entry = entries[index];
      const ordinal = index + 1;
      index += 1;
      if (index < entries.length) pending = composite(index);

      // Blob.size is available without allocating another full copy, so reject
      // oversized output before arrayBuffer() and base64's ~4/3 expansion.
      assertEntryImageBudget(budget, image.size, declaredImageBytes, ordinal);
      declaredImageBytes += image.size;
      const bytes = new Uint8Array(await image.arrayBuffer());
      throwIfAborted(signal);
      // Recheck the owned buffer as defense-in-depth for non-native Blob-like
      // implementations used by tests or future adapters.
      assertEntryImageBudget(budget, bytes.byteLength, actualImageBytes, ordinal);
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
    pending?.catch(() => {});
  }
}

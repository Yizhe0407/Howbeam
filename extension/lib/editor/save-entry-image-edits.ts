import { getStep, updateStepsAtomically } from '../storage/step-repository';
import { getProjectStructureSnapshot, sameBounds, saveSnapshotImageAtomically } from '../storage/project-structure';
import {
  entryId,
  getEntryImageOwner,
  isValidRedaction,
  STEP_STORAGE_LIMITS,
  type Step,
  type StepEntry,
} from '../storage/models';
import { IMAGE_EDIT_LIMITS, isValidImageEdit } from '../storage/image-edit-model';
import type { SplitItems } from './image-edit-items';

export interface ImageEditSaveBase {
  /** The `imageEditRevision` of the stored edits this save replaces. */
  imageEditRevision: number;
  /** A snapshot's annotations, in order, as the draft last saw them stored. */
  annotationIds: readonly string[];
  /** Annotations this editor deleted, kept so an undo can put them back. */
  removed: ReadonlyMap<string, Step>;
  /** Clears the privacy review flag: the person explicitly confirmed the masks. */
  confirmReview?: boolean;
}

/** The editor tried to store something storage would not keep as given. Storage
 * drops malformed edits it reads, but what the editor writes must never be
 * dropped quietly: the person would lose work (or a mask) without knowing. */
export class ImageEditsNotStorableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageEditsNotStorableError';
  }
}

function assertStorable({ redactions, imageEdits }: SplitItems): void {
  if (redactions.length > STEP_STORAGE_LIMITS.maxRedactionsPerStep) {
    throw new ImageEditsNotStorableError('Too many privacy masks.');
  }
  if (imageEdits.length > IMAGE_EDIT_LIMITS.maxItems) {
    throw new ImageEditsNotStorableError('Too many image edits.');
  }
  const ids = new Set<string>();
  for (const redaction of redactions) {
    if (!isValidRedaction(redaction) || ids.has(redaction.id))
      throw new ImageEditsNotStorableError('Invalid privacy mask.');
    ids.add(redaction.id);
  }
  ids.clear();
  for (const edit of imageEdits) {
    if (!isValidImageEdit(edit) || ids.has(edit.id)) throw new ImageEditsNotStorableError(`Invalid ${edit.kind} edit.`);
    ids.add(edit.id);
  }
}

/** The box fields an ordinary step stores for what the editor left: moved, removed, or as detected. */
function boxChanges(
  step: Step,
  box: SplitItems['highlights'][number] | undefined,
): Pick<Step, 'manualBounds' | 'highlightRemoved'> {
  if (!box) return step.bounds ? { manualBounds: undefined, highlightRemoved: true } : {};
  return { manualBounds: sameBounds(box.bounds, step.bounds) ? undefined : box.bounds, highlightRemoved: undefined };
}

/** Saves an entry's masks, drawn edits, crop and recorded boxes in one write: on
 * the step that owns the image (the step itself, or a snapshot's shared anchor),
 * and for a snapshot also on its annotations. Returns the new image edit
 * revision for the next save to build on.
 *
 * Two compare-and-set guards keep it from overwriting anything it has not seen:
 * the capture revision (the image was retaken since the editor loaded it) and the
 * image edit revision (another tab saved edits since). Either refuses the write,
 * rather than placing marks over a different picture or deleting someone's masks. */
export async function saveEntryImageEdits(
  entry: StepEntry,
  items: SplitItems,
  base: ImageEditSaveBase,
): Promise<number> {
  assertStorable(items);
  const owner = getEntryImageOwner(entry);
  const changes = {
    redactions: items.redactions,
    imageEdits: items.imageEdits,
    crop: items.crop,
    ...(base.confirmReview ? { redactionReviewRequired: false } : {}),
  };
  if (entry.kind === 'group') {
    await saveSnapshotImageAtomically(
      owner.sessionId,
      owner.id,
      changes,
      items.highlights,
      {
        captureRevision: owner.captureRevision ?? 0,
        imageEditRevision: base.imageEditRevision,
        annotationIds: base.annotationIds,
      },
      base.removed,
    );
  } else {
    await updateStepsAtomically(owner.sessionId, [
      {
        id: owner.id,
        changes: { ...changes, ...boxChanges(entry.step, items.highlights[0]) },
        expectedCaptureRevision: owner.captureRevision ?? 0,
        expectedImageEditRevision: base.imageEditRevision,
      },
    ]);
  }
  // Every write of these fields moves the revision forward by exactly one.
  return base.imageEditRevision + 1;
}

/** Whether storage holds a different image or different edits than the given
 * revisions. Reads only the image's own row, so it is cheap to ask on every
 * project change notification. */
export async function isEntryImageStale(entry: StepEntry, imageEditRevision: number): Promise<boolean> {
  const owner = getEntryImageOwner(entry);
  const stored = await getStep(owner.id);
  if (!stored) return true;
  return (
    (stored.imageEditRevision ?? 0) !== imageEditRevision ||
    (stored.captureRevision ?? 0) !== (owner.captureRevision ?? 0)
  );
}

/** The entry as storage holds it now, or null when it no longer exists. */
export async function loadLatestEntry(entry: StepEntry): Promise<StepEntry | null> {
  const snapshot = await getProjectStructureSnapshot(getEntryImageOwner(entry).sessionId);
  const id = entryId(entry);
  return snapshot.entries.find((candidate) => entryId(candidate) === id) ?? null;
}

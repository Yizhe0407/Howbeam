import {
  assertMutationItems,
  getEffectiveBounds,
  orderedSessionSteps,
  sanitizeStepForStorage,
  stepRole,
  type Bounds,
  type Step,
} from './models';
import type { StepRecaptureTarget } from './recording-state';
import { assertStorableScreenshots } from './screenshot-rules';
import {
  recordStepEdit,
  refreshProjectSummary,
  refreshProjectSummaryFromRows,
  requireWritableProject,
  runProjectStepsWrite,
  runWithDatabase,
  writeDenseOrder,
} from './database';

/** A captured row before it has a place in its Project: the write assigns `order`. */
export type NewStep = Omit<Step, 'order'>;

/** Persists rows captured by one recording run. They follow the run's own last
 * row, or `afterStepId` when the run has none yet (a continuation from the
 * middle of a Project); with neither, or when that row is gone, they are
 * appended. Their order is assigned here, from the rows this transaction
 * reads, and the Project's order stays dense. */
export async function addStepsAfter(steps: readonly NewStep[], afterStepId: string | null): Promise<void> {
  const [first] = steps;
  if (!first) return;
  assertMutationItems(steps, 'Added steps');
  await assertStorableScreenshots(steps.map((step) => step.screenshotBlob));
  const { sessionId, runId } = first;
  let latestTimestamp = first.timestamp;
  await runProjectStepsWrite(async (tx) => {
    const project = await requireWritableProject(tx, sessionId);
    const existing = orderedSessionSteps(await tx.objectStore('steps').index('by-session').getAll(sessionId));
    const lastOfRun = runId ? existing.findLast((step) => step.runId === runId) : undefined;
    const anchorId = lastOfRun?.id ?? afterStepId;
    const at = anchorId === null ? -1 : existing.findIndex((step) => step.id === anchorId);
    const insertAt = at === -1 ? existing.length : at + 1;
    const stored = steps.map((step, index) => sanitizeStepForStorage({ ...step, order: insertAt + index }));
    for (const step of stored) {
      if (step.sessionId !== sessionId) throw new Error(`Step ${step.id} belongs to another project.`);
      latestTimestamp = Math.max(latestTimestamp, step.timestamp);
      await tx.objectStore('steps').add(step);
    }
    const ordered = existing.map((step) => step.id);
    ordered.splice(insertAt, 0, ...stored.map((step) => step.id));
    await writeDenseOrder(tx, [...existing, ...stored], ordered);
    await refreshProjectSummaryFromRows(tx, project, [...existing, ...stored], latestTimestamp);
  });
}

export async function getSteps(sessionId: string): Promise<Step[]> {
  return runWithDatabase(async (db) => {
    const steps = await db.getAllFromIndex('steps', 'by-session', sessionId);
    return steps.sort((a, b) => a.order - b.order);
  });
}

export async function getStep(id: string): Promise<Step | undefined> {
  return runWithDatabase((db) => db.get('steps', id));
}

export interface CaptureReplacement {
  screenshotBlob: Blob;
  bounds: Bounds;
  devicePixelRatio: number;
  screenshotScale: number;
  url: string;
  timestamp: number;
}

// Canonical home is the persisted-state schema: the same target shape rides
// the recapture runtime messages end to end. Re-exporting keeps the db facade
// stable without a second declaration that could drift.
export type { StepRecaptureTarget } from './recording-state';

export class StepRecaptureError extends Error {
  constructor(
    public readonly code:
      | 'TARGET_NOT_FOUND'
      | 'TARGET_CHANGED'
      | 'UNSUPPORTED_SNAPSHOT_GROUP',
    message: string,
  ) {
    super(message);
    this.name = 'StepRecaptureError';
  }
}

/** The fields an image edit writes in place. */
export type StepImageEditChanges = Partial<Pick<Step, 'redactions' | 'imageEdits' | 'crop' | 'redactionReviewRequired'>>;

export interface StepUpdate {
  id: string;
  changes: StepImageEditChanges;
  /** Optional compare-and-set guard for privacy-sensitive edits. */
  expectedCaptureRevision?: number;
  /** Optional compare-and-set guard on `imageEditRevision`: the image editor's
   * masks, drawings and crop must be written over the copy it loaded. */
  expectedImageEditRevision?: number;
}

/** The screenshot was retaken before the edit was saved. */
export class StepUpdateConflictError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly expectedCaptureRevision: number,
    public readonly actualCaptureRevision: number,
  ) {
    super('This screenshot changed before the edit was saved.');
    this.name = 'StepUpdateConflictError';
  }
}

/** A targeted step row no longer exists. Callers that hold user-typed content
 * (description autosave) must keep their durable draft instead of treating the
 * write as committed. */
export class StepNotFoundError extends Error {
  constructor(public readonly stepId: string) {
    super('Step no longer exists.');
    this.name = 'StepNotFoundError';
  }
}

/** The persisted description diverged from the value the editor last observed.
 * Carries the winning value so the caller can rebase and ask for confirmation
 * instead of silently losing either tab's text. */
export class StepDescriptionConflictError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly expectedDescription: string,
    public readonly actualDescription: string,
  ) {
    super('Step description changed before the edit was saved.');
    this.name = 'StepDescriptionConflictError';
  }
}

/** Another write (usually another editor tab) changed the image's masks,
 * drawings or crop after this editor loaded them. Saving the stale copy would
 * silently delete that write, so it is refused. */
export class StepImageEditConflictError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly expectedImageEditRevision: number,
    public readonly actualImageEditRevision: number,
  ) {
    super('This image was edited elsewhere before the edit was saved.');
    this.name = 'StepImageEditConflictError';
  }
}

const IMAGE_EDIT_FIELDS = ['redactions', 'imageEdits', 'crop'] as const;
/** Every field an in-place edit may write. None of them is structural or
 * counted by the Project summary. */
const IN_PLACE_FIELDS = [...IMAGE_EDIT_FIELDS, 'redactionReviewRequired', 'description'] as const;
type InPlaceStepChanges = Partial<Pick<Step, (typeof IN_PLACE_FIELDS)[number]>>;

/** Copies only the in-place fields `changes` carries, whatever else it holds.
 * The image edit revision is owned by storage: any write that touches a
 * per-image edit field moves it forward. */
function applyStepChanges(existing: Step, changes: InPlaceStepChanges): Step {
  const written: InPlaceStepChanges = Object.fromEntries(
    IN_PLACE_FIELDS.filter((field) => Object.hasOwn(changes, field)).map((field) => [field, changes[field]]),
  );
  const touchesImageEdits = IMAGE_EDIT_FIELDS.some((field) => Object.hasOwn(written, field));
  return sanitizeStepForStorage({
    ...existing,
    ...written,
    ...(touchesImageEdits ? { imageEditRevision: (existing.imageEditRevision ?? 0) + 1 } : {}),
  });
}

/** Whether a recaptured image must have its masks re-checked: the old masks
 * were placed over the old pixels, so the new picture may show what they hid. */
function hadPrivacyMasks(step: Step): boolean {
  return step.redactionReviewRequired === true
    || (Array.isArray(step.redactions) ? step.redactions.length > 0 : step.redactions !== undefined);
}

/** Applies a visual edit as one IndexedDB transaction. Each row is re-read in
 * the transaction, so description autosaves and reorders cannot be lost by a
 * stale editor draft. Missing or cross-session rows abort the whole commit. */
export async function updateStepsAtomically(sessionId: string, updates: StepUpdate[]): Promise<void> {
  assertMutationItems(updates, 'Step updates');
  if (updates.length === 0) return;
  await runProjectStepsWrite(async (tx) => {
    const project = await requireWritableProject(tx, sessionId);
    for (const update of updates) {
      const existing = await tx.objectStore('steps').get(update.id);
      if (!existing || existing.sessionId !== sessionId) {
        throw new Error(`Step ${update.id} is no longer available.`);
      }
      if (
        update.expectedCaptureRevision !== undefined &&
        (existing.captureRevision ?? 0) !== update.expectedCaptureRevision
      ) {
        throw new StepUpdateConflictError(
          update.id,
          update.expectedCaptureRevision,
          existing.captureRevision ?? 0,
        );
      }
      if (
        update.expectedImageEditRevision !== undefined &&
        (existing.imageEditRevision ?? 0) !== update.expectedImageEditRevision
      ) {
        throw new StepImageEditConflictError(
          update.id,
          update.expectedImageEditRevision,
          existing.imageEditRevision ?? 0,
        );
      }
      await tx.objectStore('steps').put(applyStepChanges(existing, update.changes));
    }
    await recordStepEdit(tx, project);
  });
}


export async function replaceStepCaptureAtomically(
  sessionId: string,
  target: StepRecaptureTarget,
  capture: CaptureReplacement,
  recaptureRunId: string,
): Promise<{ entryId: string; captureRevision: number }> {
  await assertStorableScreenshots([capture.screenshotBlob]);
  return runProjectStepsWrite(async (tx) => {
    const project = await requireWritableProject(tx, sessionId);
    if (target.kind === 'single') {
      const step = await tx.objectStore('steps').get(target.stepId);
      if (!step || step.sessionId !== sessionId) {
        throw new StepRecaptureError('TARGET_NOT_FOUND', 'The step no longer exists.');
      }
      if (stepRole(step) !== 'ordinary') {
        throw new StepRecaptureError('TARGET_CHANGED', 'The step is no longer an ordinary step.');
      }
      const captureRevision = (step.captureRevision ?? 0) + 1;
      await tx.objectStore('steps').put(sanitizeStepForStorage({
        ...step,
        ...capture,
        manualBounds: null,
        redactions: [],
        imageEdits: [],
        crop: null,
        redactionReviewRequired: hadPrivacyMasks(step),
        captureRevision,
        imageEditRevision: (step.imageEditRevision ?? 0) + 1,
        lastCaptureRunId: recaptureRunId,
      }));
      await refreshProjectSummary(tx, project, capture.timestamp);
      return { entryId: step.id, captureRevision };
    }

    const anchor = await tx.objectStore('steps').get(target.anchorId);
    const annotation = await tx.objectStore('steps').get(target.annotationId);
    if (!anchor || !annotation || anchor.sessionId !== sessionId || annotation.sessionId !== sessionId) {
      throw new StepRecaptureError('TARGET_NOT_FOUND', 'The snapshot no longer exists.');
    }
    if (
      stepRole(anchor) !== 'anchor' ||
      annotation.groupId !== anchor.id ||
      stepRole(annotation) !== 'annotation' ||
      !anchor.screenshotBlob
    ) {
      throw new StepRecaptureError('TARGET_CHANGED', 'The snapshot structure changed before recapture.');
    }
    const sessionSteps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
    const annotations = sessionSteps.filter(
      (step) => step.groupId === anchor.id && stepRole(step) === 'annotation' && getEffectiveBounds(step),
    );
    const [only, ...others] = annotations;
    if (!only || others.length > 0 || only.id !== annotation.id) {
      throw new StepRecaptureError(
        'UNSUPPORTED_SNAPSHOT_GROUP',
        'A snapshot with multiple annotations must be rebuilt as a whole.',
      );
    }
    const captureRevision = (anchor.captureRevision ?? 0) + 1;
    const replacedAnchor = sanitizeStepForStorage({
      ...anchor,
      screenshotBlob: capture.screenshotBlob,
      devicePixelRatio: capture.devicePixelRatio,
      screenshotScale: capture.screenshotScale,
      url: capture.url,
      timestamp: capture.timestamp,
      redactions: [],
      imageEdits: [],
      crop: null,
      redactionReviewRequired: hadPrivacyMasks(anchor),
      captureRevision,
      imageEditRevision: (anchor.imageEditRevision ?? 0) + 1,
      lastCaptureRunId: recaptureRunId,
    });
    const replacedAnnotation = sanitizeStepForStorage({
      ...annotation,
      bounds: capture.bounds,
      manualBounds: null,
      devicePixelRatio: capture.devicePixelRatio,
      screenshotScale: capture.screenshotScale,
      url: capture.url,
      timestamp: capture.timestamp,
    });
    await tx.objectStore('steps').put(replacedAnchor);
    await tx.objectStore('steps').put(replacedAnnotation);
    const replaced = new Map([replacedAnchor, replacedAnnotation].map((step) => [step.id, step]));
    await refreshProjectSummaryFromRows(
      tx,
      project,
      sessionSteps.map((step) => replaced.get(step.id) ?? step),
      capture.timestamp,
    );
    return { entryId: anchor.id, captureRevision };
  });
}

/** Compare-and-set description save for the editor autosave path. It only
 * conflicts when the same row's description diverged from what this editor
 * last observed, so the CAS guards exactly that value. Conflicts surface as StepDescriptionConflictError
 * (with the winning value) instead of last-write-wins.
 *
 * Resolves with the description as stored (normalized by the stored-text
 * rule), which is the value the caller must compare against from now on. */
export async function saveStepDescription(
  id: string,
  description: string,
  expectedDescription: string,
): Promise<string> {
  return runProjectStepsWrite(async (tx) => {
    const existing = await tx.objectStore('steps').get(id);
    if (!existing) throw new StepNotFoundError(id);
    if (existing.description !== expectedDescription) {
      throw new StepDescriptionConflictError(id, expectedDescription, existing.description);
    }
    const project = await requireWritableProject(tx, existing.sessionId);
    const stored = applyStepChanges(existing, { description });
    await tx.objectStore('steps').put(stored);
    await recordStepEdit(tx, project);
    return stored.description;
  });
}

/** Deletes one row if present. A missing row is success: deletion is
 * idempotent and re-running it cannot lose user content. */
export async function deleteStep(id: string): Promise<void> {
  await runProjectStepsWrite(async (tx) => {
    const existing = await tx.objectStore('steps').get(id);
    if (!existing) return;
    const project = await requireWritableProject(tx, existing.sessionId);
    await tx.objectStore('steps').delete(id);
    const remaining = await tx.objectStore('steps').index('by-session').getAll(existing.sessionId);
    await writeDenseOrder(tx, remaining, []);
    await refreshProjectSummaryFromRows(tx, project, remaining);
  });
}

/** Deletes only one recording run and closes order gaps without disturbing
 * content from earlier runs that share the same editor session. */
export async function deleteStepsForRun(sessionId: string, runId: string): Promise<void> {
  await runProjectStepsWrite(async (tx) => {
    const project = await requireWritableProject(tx, sessionId);
    const sessionSteps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
    const removedIds = new Set(sessionSteps.filter((step) => step.runId === runId).map((step) => step.id));
    for (const id of removedIds) await tx.objectStore('steps').delete(id);
    const remaining = sessionSteps.filter((step) => !removedIds.has(step.id));
    await writeDenseOrder(tx, remaining, []);
    await refreshProjectSummaryFromRows(tx, project, remaining);
  });
}

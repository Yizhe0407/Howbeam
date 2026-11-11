import {
  assertMutationItems,
  getEffectiveBounds,
  sanitizeStepForStorage,
  stepRole,
  type Bounds,
  type ScreenshotStep,
  type Step,
  type StepEntry,
} from './models';
import type { StepRecaptureTarget } from './recording-state';
import { assertStorableScreenshots } from './screenshot-rules';
import {
  recordStepEdit,
  requireProject,
  runProjectRead,
  runProjectWrite,
  type ProjectTransaction,
  type ProjectWriteTransaction,
} from './database';
import {
  commitEntries,
  entrySteps,
  findEntryRecord,
  putEntryInPlace,
  readEntries,
  readEntry,
  readEntryRecords,
} from './entry-store';

/** A captured row before it has a place in its Project: the write assigns `order`. */
export type NewStep = Omit<Step, 'order'>;

function entryHolds(entry: StepEntry, stepId: string): boolean {
  return entry.kind === 'single'
    ? entry.step.id === stepId
    : entry.anchor.id === stepId || entry.annotations.some((annotation) => annotation.id === stepId);
}

function entryHasRun(entry: StepEntry, runId: string): boolean {
  return entrySteps([entry]).some((step) => step.runId === runId);
}

/** Persists rows captured by one recording run. They follow the run's own last
 * entry, or the entry holding `afterStepId` when the run has none yet (a
 * continuation from the middle of a Project); with neither, or when that entry
 * is gone, they are appended.
 *
 * An ordinary step becomes an entry. A snapshot's base image is kept aside as
 * a pending anchor until its first annotation arrives; that annotation turns
 * it into an entry, and later ones join it. */
export async function addStepsAfter(steps: readonly NewStep[], afterStepId: string | null): Promise<void> {
  const [first] = steps;
  if (!first) return;
  assertMutationItems(steps, 'Added steps');
  await assertStorableScreenshots(steps.map((step) => step.screenshotBlob));
  const { sessionId, runId } = first;
  let latestTimestamp = first.timestamp;
  await runProjectWrite(async (tx) => {
    const previous = await readEntries(tx, sessionId);
    const next = [...previous];
    const lastOfRun = runId ? next.findLastIndex((entry) => entryHasRun(entry, runId)) : -1;
    const after = lastOfRun !== -1
      ? lastOfRun
      : afterStepId === null ? -1 : next.findIndex((entry) => entryHolds(entry, afterStepId));
    let insertAt = after === -1 ? next.length : after + 1;
    let structureChanged = false;

    for (const raw of steps) {
      if (raw.sessionId !== sessionId) throw new Error(`Step ${raw.id} belongs to another project.`);
      const step = sanitizeStepForStorage({ ...raw, order: 0 });
      latestTimestamp = Math.max(latestTimestamp, step.timestamp);
      const role = stepRole(step);
      if (role === 'ordinary') {
        next.splice(insertAt, 0, { kind: 'single', step: step as ScreenshotStep });
        insertAt += 1;
        structureChanged = true;
        continue;
      }
      if (role === 'anchor') {
        if (!step.screenshotBlob) throw new Error('A snapshot base image needs its screenshot.');
        if (await findEntryRecord(tx, step.id) || await tx.objectStore('pendingAnchors').get(step.id)) {
          throw new Error(`Step ${step.id} already exists.`);
        }
        await tx.objectStore('pendingAnchors').add({ id: step.id, projectId: sessionId, step });
        continue;
      }
      const groupIndex = next.findIndex((entry) => entry.kind === 'group' && entry.anchor.id === step.groupId);
      const group = next[groupIndex];
      if (group?.kind === 'group') {
        next[groupIndex] = { ...group, annotations: [...group.annotations, step] };
      } else {
        const pending = await tx.objectStore('pendingAnchors').get(step.groupId!);
        if (pending?.projectId !== sessionId) throw new Error(`Snapshot ${step.groupId} is no longer available.`);
        await tx.objectStore('pendingAnchors').delete(pending.id);
        next.splice(insertAt, 0, { kind: 'group', anchor: pending.step as ScreenshotStep, annotations: [step] });
        insertAt += 1;
      }
      structureChanged = true;
    }
    // A snapshot's base image alone does not need its Project yet: a run creates
    // its Project when the first step or annotation is stored.
    if (structureChanged) {
      const project = await requireProject(tx, sessionId);
      await commitEntries(tx, project, previous, next, { timestamp: latestTimestamp });
    }
  });
}

/** Every step of the Project's timeline, in order, screenshots included. A
 * snapshot base image still waiting for its first annotation is not part of it. */
export async function getSteps(sessionId: string): Promise<Step[]> {
  return runProjectRead(async (tx) => entrySteps(await readEntries(tx, sessionId)));
}

async function readStep(tx: ProjectTransaction, id: string): Promise<Step | undefined> {
  const pending = await tx.objectStore('pendingAnchors').get(id);
  if (pending) return pending.step;
  const record = await findEntryRecord(tx, id);
  if (!record) return undefined;
  return entrySteps([await readEntry(tx, record)]).find((step) => step.id === id);
}

/** Every step of the Project's timeline, in order, without screenshots: for
 * questions about the timeline's shape (its last entry, a run's steps, a
 * step's URL) that need no image bytes. */
export async function getStepOutlines(sessionId: string): Promise<Step[]> {
  return runProjectRead(async (tx) => (await readEntryRecords(tx, sessionId))
    .flatMap((record) => [record.owner, ...record.annotations]));
}

/** One step by id, including a snapshot base image that is still pending. */
export async function getStep(id: string): Promise<Step | undefined> {
  return runProjectRead((tx) => readStep(tx, id));
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
export type StepImageEditChanges = Partial<Pick<Step, 'redactions' | 'imageEdits' | 'crop' | 'redactionReviewRequired' | 'manualBounds' | 'highlightRemoved'>>;

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

const IMAGE_EDIT_FIELDS = ['redactions', 'imageEdits', 'crop', 'manualBounds', 'highlightRemoved'] as const;
/** Every field an in-place edit may write. None of them is structural or
 * counted by the Project summary. */
const IN_PLACE_FIELDS = [...IMAGE_EDIT_FIELDS, 'redactionReviewRequired', 'description'] as const;
type InPlaceStepChanges = Partial<Pick<Step, (typeof IN_PLACE_FIELDS)[number]>>;

/** Copies only the in-place fields `changes` carries, whatever else it holds.
 * The image edit revision is owned by storage: any write that touches a
 * per-image edit field moves it forward. */
export function applyStepChanges(existing: Step, changes: InPlaceStepChanges): Step {
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

/** The step without the person's changes to its box, which belong to the old picture. */
function withoutBoxEdits({ manualBounds: _manualBounds, highlightRemoved: _highlightRemoved, ...step }: Step): Step {
  return step;
}

/** Whether a recaptured image must have its masks re-checked: the old masks
 * were placed over the old pixels, so the new picture may show what they hid. */
function hadPrivacyMasks(step: Step): boolean {
  return step.redactionReviewRequired === true
    || (Array.isArray(step.redactions) ? step.redactions.length > 0 : step.redactions !== undefined);
}

function replaceInEntry(entry: StepEntry, step: Step): StepEntry {
  if (entry.kind === 'single') return { kind: 'single', step: { ...step, screenshotBlob: entry.step.screenshotBlob } as ScreenshotStep };
  if (entry.anchor.id === step.id) {
    return { ...entry, anchor: { ...step, screenshotBlob: entry.anchor.screenshotBlob } as ScreenshotStep };
  }
  return { ...entry, annotations: entry.annotations.map((annotation) => (annotation.id === step.id ? step : annotation)) };
}

/** Reads a step and the entry holding it inside a write. */
async function loadMember(tx: ProjectWriteTransaction, id: string) {
  const record = await findEntryRecord(tx, id);
  if (!record) return undefined;
  const entry = await readEntry(tx, record);
  const step = entrySteps([entry]).find((candidate) => candidate.id === id)!;
  return { record, entry, step };
}

/** Applies a visual edit as one IndexedDB transaction. Each step is re-read in
 * the transaction, so description autosaves and reorders cannot be lost by a
 * stale editor draft. Missing or cross-session steps abort the whole commit. */
export async function updateStepsAtomically(sessionId: string, updates: StepUpdate[]): Promise<void> {
  assertMutationItems(updates, 'Step updates');
  if (updates.length === 0) return;
  await runProjectWrite(async (tx) => {
    const project = await requireProject(tx, sessionId);
    for (const update of updates) {
      const member = await loadMember(tx, update.id);
      if (!member || member.record.projectId !== sessionId) {
        throw new Error(`Step ${update.id} is no longer available.`);
      }
      const existing = member.step;
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
      await putEntryInPlace(tx, member.record, replaceInEntry(member.entry, applyStepChanges(existing, update.changes)));
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
  return runProjectWrite(async (tx) => {
    const project = await requireProject(tx, sessionId);
    const previous = await readEntries(tx, sessionId);
    if (target.kind === 'single') {
      const index = previous.findIndex((entry) => entryHolds(entry, target.stepId));
      const entry = previous[index];
      if (!entry) throw new StepRecaptureError('TARGET_NOT_FOUND', 'The step no longer exists.');
      if (entry.kind !== 'single') {
        throw new StepRecaptureError('TARGET_CHANGED', 'The step is no longer an ordinary step.');
      }
      const { step } = entry;
      const captureRevision = (step.captureRevision ?? 0) + 1;
      const replaced = sanitizeStepForStorage({
        ...withoutBoxEdits(step),
        ...capture,
        redactions: [],
        imageEdits: [],
        crop: null,
        redactionReviewRequired: hadPrivacyMasks(step),
        captureRevision,
        imageEditRevision: (step.imageEditRevision ?? 0) + 1,
        lastCaptureRunId: recaptureRunId,
      }) as ScreenshotStep;
      const next = previous.with(index, { kind: 'single', step: replaced });
      await commitEntries(tx, project, previous, next, { timestamp: capture.timestamp });
      return { entryId: step.id, captureRevision };
    }

    const index = previous.findIndex((entry) => entryHolds(entry, target.anchorId) || entryHolds(entry, target.annotationId));
    const entry = previous[index];
    if (!entry || !entryHolds(entry, target.annotationId)) {
      throw new StepRecaptureError('TARGET_NOT_FOUND', 'The snapshot no longer exists.');
    }
    if (entry.kind !== 'group' || entry.anchor.id !== target.anchorId) {
      throw new StepRecaptureError('TARGET_CHANGED', 'The snapshot structure changed before recapture.');
    }
    const { anchor } = entry;
    const [only, ...others] = entry.annotations.filter((step) => getEffectiveBounds(step));
    if (!only || others.length > 0 || only.id !== target.annotationId) {
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
    }) as ScreenshotStep;
    const replacedAnnotation = sanitizeStepForStorage({
      ...withoutBoxEdits(only),
      bounds: capture.bounds,
      devicePixelRatio: capture.devicePixelRatio,
      screenshotScale: capture.screenshotScale,
      url: capture.url,
      timestamp: capture.timestamp,
    });
    const next = previous.with(index, { kind: 'group', anchor: replacedAnchor, annotations: [replacedAnnotation] });
    await commitEntries(tx, project, previous, next, { timestamp: capture.timestamp });
    return { entryId: anchor.id, captureRevision };
  });
}

/** Saves a step's description. Only one editor tab edits a Project at a time
 * (editor-lock), so this is a plain write.
 *
 * Resolves with the description as stored (normalized by the stored-text
 * rule), which is the value the caller compares against from now on. */
export async function saveStepDescription(id: string, description: string): Promise<string> {
  return runProjectWrite(async (tx) => {
    const member = await loadMember(tx, id);
    if (!member) throw new StepNotFoundError(id);
    const project = await requireProject(tx, member.record.projectId);
    const stored = applyStepChanges(member.step, { description });
    await putEntryInPlace(tx, member.record, replaceInEntry(member.entry, stored));
    await recordStepEdit(tx, project);
    return stored.description;
  });
}

/** Removes one step if present. A missing step is success: deletion is
 * idempotent and re-running it cannot lose user content.
 *
 * Deleting an ordinary step or a snapshot's base image removes its entry.
 * Deleting a snapshot's last annotation puts its base image back to pending,
 * as it was before that annotation: the recording that owns it may add
 * another, and otherwise discards it when it ends. */
export async function deleteStep(id: string): Promise<void> {
  await runProjectWrite(async (tx) => {
    const pending = await tx.objectStore('pendingAnchors').get(id);
    if (pending) {
      await tx.objectStore('pendingAnchors').delete(id);
      return;
    }
    const record = await findEntryRecord(tx, id);
    if (!record) return;
    const project = await requireProject(tx, record.projectId);
    const previous = await readEntries(tx, record.projectId);
    const index = previous.findIndex((entry) => entryHolds(entry, id));
    const entry = previous[index]!;
    let next: StepEntry[];
    if (entry.kind === 'single' || entry.anchor.id === id) {
      next = previous.toSpliced(index, 1);
    } else {
      const annotations = entry.annotations.filter((annotation) => annotation.id !== id);
      if (annotations.length > 0) {
        next = previous.with(index, { ...entry, annotations });
      } else {
        next = previous.toSpliced(index, 1);
        await tx.objectStore('pendingAnchors').put({ id: entry.anchor.id, projectId: record.projectId, step: entry.anchor });
      }
    }
    await commitEntries(tx, project, previous, next);
  });
}

/** Deletes only one recording run's steps, without disturbing content from
 * earlier runs that share the same Project. */
export async function deleteStepsForRun(sessionId: string, runId: string): Promise<void> {
  await runProjectWrite(async (tx) => {
    const project = await requireProject(tx, sessionId);
    for (const pending of await tx.objectStore('pendingAnchors').index('by-project').getAll(sessionId)) {
      if (pending.step.runId === runId) await tx.objectStore('pendingAnchors').delete(pending.id);
    }
    const previous = await readEntries(tx, sessionId);
    const next = previous.flatMap((entry): StepEntry[] => {
      if (entry.kind === 'single') return entry.step.runId === runId ? [] : [entry];
      if (entry.anchor.runId === runId) return [];
      const annotations = entry.annotations.filter((annotation) => annotation.runId !== runId);
      if (annotations.length === entry.annotations.length) return [entry];
      return annotations.length > 0 ? [{ ...entry, annotations }] : [];
    });
    await commitEntries(tx, project, previous, next);
  });
}

/** Discards every snapshot base image still waiting for its first annotation,
 * except `keep` (the one a live recording is annotating). Only a recording
 * that ended without finishing (the browser closed mid-snapshot) leaves one. */
export async function discardPendingAnchors(keep: string | null): Promise<number> {
  return runProjectWrite(async (tx) => {
    const ids = (await tx.objectStore('pendingAnchors').getAllKeys()).filter((id) => id !== keep);
    for (const id of ids) await tx.objectStore('pendingAnchors').delete(id);
    return ids.length;
  }, { notify: false });
}

/** Discards a snapshot base image that never got an annotation. One that did
 * is an entry of its Project by now and is left alone. */
export async function discardPendingAnchor(id: string): Promise<boolean> {
  return runProjectWrite(async (tx) => {
    if (!await tx.objectStore('pendingAnchors').get(id)) return false;
    await tx.objectStore('pendingAnchors').delete(id);
    return true;
  }, { notify: false });
}

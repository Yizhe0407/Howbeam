import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  getStep,
  getSteps,
  replaceStepCaptureAtomically,
  StepImageEditConflictError,
  saveStepDescription,
  updateStepsAtomically,
} from '@/lib/storage/step-repository';
import { buildStepEntries, type Redaction, type Step, type StepEntry } from '@/lib/storage/models';
import { IMAGE_EDIT_LIMITS, type ImageEdit } from '@/lib/storage/image-edit-model';
import { closeDatabase } from '@/lib/storage/database';
import { seedSteps } from '../setup/step-fixtures';
import {
  ImageEditsNotStorableError,
  isEntryImageStale,
  loadLatestEntry,
  saveEntryImageEdits,
} from '@/lib/editor/save-entry-image-edits';

function jpegBlob(width = 2, height = 2): Blob {
  return new Blob([new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 255, height & 255, (width >>> 8) & 255, width & 255,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ])], { type: 'image/jpeg' });
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    order: 0,
    screenshotBlob: jpegBlob(),
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: Date.now(),
    ...overrides,
  };
}

async function addStep(step: Step): Promise<void> {
  await seedSteps([step]);
}

/** What an editor tab holds after loading the project. */
async function openEntry(sessionId: string): Promise<StepEntry> {
  return buildStepEntries(await getSteps(sessionId))[0];
}

const mask = (id: string): Redaction => ({ id, kind: 'solid', bounds: { x: 10, y: 10, width: 20, height: 20 } });
const box = (id: string): ImageEdit => ({ id, kind: 'rect', bounds: { x: 5, y: 5, width: 30, height: 30 }, width: 2, color: '#ff4747', fill: 'none' });

describe('image edit revision', () => {
  it('refuses a stale tab saving over masks another tab saved, so they are never silently deleted', async () => {
    const step = makeStep();
    await addStep(step);
    const tabA = await openEntry(step.sessionId);
    const tabB = await openEntry(step.sessionId);

    await saveEntryImageEdits(tabA, { redactions: [mask('a-mask')], imageEdits: [], crop: null }, { imageEditRevision: 0 });
    await expect(
      saveEntryImageEdits(tabB, { redactions: [], imageEdits: [box('b-box')], crop: null }, { imageEditRevision: 0 }),
    ).rejects.toBeInstanceOf(StepImageEditConflictError);

    const stored = await getStep(step.id);
    expect(stored?.redactions?.map((redaction) => redaction.id)).toEqual(['a-mask']);
    expect(stored?.imageEdits ?? []).toEqual([]);
    expect(stored?.imageEditRevision).toBe(1);

    // Tab B sees it is behind, reloads the latest, and can then save on top of it.
    expect(await isEntryImageStale(tabB, 0)).toBe(true);
    const latest = (await loadLatestEntry(tabB))!;
    expect(latest.kind === 'single' && latest.step.redactions?.map((redaction) => redaction.id)).toEqual(['a-mask']);
    const next = await saveEntryImageEdits(
      latest,
      { redactions: [mask('a-mask')], imageEdits: [box('b-box')], crop: null },
      { imageEditRevision: 1 },
    );
    expect(next).toBe(2);
    expect(await isEntryImageStale(latest, next)).toBe(false);
  });

  it('moves forward on every write of masks, drawings or crop, and on nothing else', async () => {
    const step = makeStep();
    await addStep(step);
    await saveStepDescription(step.id, 'text only', step.description);
    expect((await getStep(step.id))?.imageEditRevision).toBeUndefined();

    await updateStepsAtomically(step.sessionId, [{ id: step.id, changes: { crop: { x: 0, y: 0, width: 1, height: 1 } } }]);
    await updateStepsAtomically(step.sessionId, [{ id: step.id, changes: { imageEdits: [box('box')] } }]);
    await updateStepsAtomically(step.sessionId, [{ id: step.id, changes: { redactions: [] } }]);
    expect((await getStep(step.id))?.imageEditRevision).toBe(3);

    // Only in-place fields are written: a caller can neither move the revision
    // back to sneak past the guard nor change the row's structure.
    await updateStepsAtomically(step.sessionId, [{ id: step.id, changes: { imageEditRevision: 0, groupId: 'other', crop: null } as never }]);
    const stored = await getStep(step.id);
    expect(stored?.imageEditRevision).toBe(4);
    expect(stored?.groupId).toBe(step.groupId);
  });

  it('treats rows stored before the revision existed as revision 0', async () => {
    const step = makeStep({ redactions: [mask('legacy')] });
    await addStep(step);
    const entry = await openEntry(step.sessionId);
    expect(await saveEntryImageEdits(entry, { redactions: [], imageEdits: [], crop: null }, { imageEditRevision: 0 })).toBe(1);
  });

  it('refuses to store what the editor would otherwise lose without a word', async () => {
    const step = makeStep();
    await addStep(step);
    const entry = await openEntry(step.sessionId);
    const longText: ImageEdit = {
      id: 'long', kind: 'text', bounds: { x: 0, y: 0, width: 100, height: 30 },
      text: 'x'.repeat(IMAGE_EDIT_LIMITS.maxTextLength + 1), fontSize: 24, color: '#111111', look: 'plain',
    };
    await expect(
      saveEntryImageEdits(entry, { redactions: [], imageEdits: [longText], crop: null }, { imageEditRevision: 0 }),
    ).rejects.toBeInstanceOf(ImageEditsNotStorableError);
    const tooMany = Array.from({ length: IMAGE_EDIT_LIMITS.maxItems + 1 }, (_, index) => box(`box-${index}`));
    await expect(
      saveEntryImageEdits(entry, { redactions: [], imageEdits: tooMany, crop: null }, { imageEditRevision: 0 }),
    ).rejects.toBeInstanceOf(ImageEditsNotStorableError);
    expect((await getStep(step.id))?.imageEditRevision).toBeUndefined();
  });

  it('clears a pending mask review only when the save confirms it', async () => {
    const step = makeStep({ redactionReviewRequired: true });
    await addStep(step);
    const entry = await openEntry(step.sessionId);
    const items = { redactions: [mask('checked')], imageEdits: [], crop: null };

    const revision = await saveEntryImageEdits(entry, items, { imageEditRevision: 0 });
    expect((await getStep(step.id))?.redactionReviewRequired).toBe(true);
    await saveEntryImageEdits(entry, items, { imageEditRevision: revision, confirmReview: true });
    expect((await getStep(step.id))?.redactionReviewRequired).toBeUndefined();
  });
});

describe('recapture and mask review', () => {
  const capture = () => ({
    screenshotBlob: jpegBlob(4, 4),
    bounds: { x: 20, y: 30, width: 40, height: 50 },
    devicePixelRatio: 1,
    screenshotScale: 1,
    url: 'https://example.com/again',
    timestamp: 123,
  });

  it('asks for the masks to be checked again when a masked image is retaken', async () => {
    const step = makeStep({ redactions: [mask('old')], imageEditRevision: 4 });
    await addStep(step);
    const editor = await openEntry(step.sessionId);
    await replaceStepCaptureAtomically(step.sessionId, { kind: 'single', stepId: step.id }, capture(), 'run');

    const stored = (await getStep(step.id))!;
    expect(stored.redactions).toEqual([]);
    expect(stored.redactionReviewRequired).toBe(true);
    // An editor still open on the old image is behind.
    expect(stored.imageEditRevision).toBe(5);
    expect(await isEntryImageStale(editor, 4)).toBe(true);
  });

  it('needs no review when the retaken image had no masks', async () => {
    const step = makeStep({ imageEdits: [box('box')] });
    await addStep(step);
    await replaceStepCaptureAtomically(step.sessionId, { kind: 'single', stepId: step.id }, capture(), 'run');
    const stored = (await getStep(step.id))!;
    expect(stored.redactionReviewRequired).toBeUndefined();
    expect(stored.imageEdits).toEqual([]);
  });

  it('asks for review on a retaken snapshot whose shared image had masks', async () => {
    const sessionId = crypto.randomUUID();
    const anchorId = crypto.randomUUID();
    const anchor = makeStep({ id: anchorId, sessionId, groupId: anchorId, bounds: null, redactions: [mask('old')] });
    const annotation = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 1 });
    await addStep(anchor);
    await seedSteps([annotation]);
    await replaceStepCaptureAtomically(
      sessionId,
      { kind: 'snapshot-singleton', anchorId, annotationId: annotation.id },
      capture(),
      'run',
    );
    expect((await getStep(anchorId))?.redactionReviewRequired).toBe(true);
  });
});

afterAll(async () => {
  await closeDatabase();
});

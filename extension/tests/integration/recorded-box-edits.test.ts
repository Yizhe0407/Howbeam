import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import { getStep, getSteps, StepImageEditConflictError } from '@/lib/storage/step-repository';
import { buildStepEntries, getEffectiveBounds, type Bounds, type Step, type StepEntry } from '@/lib/storage/models';
import { closeDatabase } from '@/lib/storage/database';
import { deleteProjectAnnotationAtomically, getProjectStructureSnapshot } from '@/lib/storage/project-structure';
import { saveEntryImageEdits } from '@/lib/editor/save-entry-image-edits';
import type { Highlight } from '@/lib/editor/image-edit-items';
import { seedSteps } from '../setup/step-fixtures';
import { itemAt } from '../setup/item-at';

function jpegBlob(): Blob {
  return new Blob([new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 2, 0, 2,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ])], { type: 'image/jpeg' });
}

const detected: Bounds = { x: 10, y: 20, width: 30, height: 40 };
const moved: Bounds = { x: 50, y: 60, width: 70, height: 80 };

function makeStep(sessionId: string, overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(),
    sessionId,
    order: 0,
    screenshotBlob: jpegBlob(),
    bounds: detected,
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** A Mark entry as recording stores it: an anchor holding the image, then its annotations. */
async function seedSnapshot(count: number): Promise<{ sessionId: string; anchorId: string; annotations: Step[] }> {
  const sessionId = crypto.randomUUID();
  const anchorId = crypto.randomUUID();
  const anchor = makeStep(sessionId, { id: anchorId, groupId: anchorId, bounds: null });
  const annotations = Array.from({ length: count }, (_, index) => makeStep(sessionId, {
    groupId: anchorId,
    order: index + 1,
    screenshotBlob: undefined,
    description: `標註 ${index + 1}`,
    bounds: { x: index * 100, y: 0, width: 20, height: 20 },
  }));
  await seedSteps([anchor, ...annotations]);
  return { sessionId, anchorId, annotations };
}

async function openEntry(sessionId: string): Promise<StepEntry> {
  return itemAt(buildStepEntries(await getSteps(sessionId)), 0);
}

const items = (highlights: Highlight[]) => ({ redactions: [], imageEdits: [], crop: null, highlights });
const base = (imageEditRevision: number, annotationIds: string[] = [], removed = new Map<string, Step>()) =>
  ({ imageEditRevision, annotationIds, removed });

afterAll(() => closeDatabase());

describe('an ordinary step\'s recorded box', () => {
  it('stores a moved box beside the detected one, and nothing extra once it is back where it was detected', async () => {
    const step = makeStep(crypto.randomUUID());
    await seedSteps([step]);
    const entry = await openEntry(step.sessionId);

    await saveEntryImageEdits(entry, items([{ id: step.id, bounds: moved }]), base(0));
    let stored = (await getStep(step.id))!;
    expect(stored.bounds).toEqual(detected);
    expect(getEffectiveBounds(stored)).toEqual(moved);

    await saveEntryImageEdits(entry, items([{ id: step.id, bounds: detected }]), base(1));
    stored = (await getStep(step.id))!;
    expect(stored).not.toHaveProperty('manualBounds');
    expect(getEffectiveBounds(stored)).toEqual(detected);
  });

  it('removes the box without losing what was detected, and brings it back', async () => {
    const step = makeStep(crypto.randomUUID());
    await seedSteps([step]);
    const entry = await openEntry(step.sessionId);

    await saveEntryImageEdits(entry, items([]), base(0));
    let stored = (await getStep(step.id))!;
    expect(stored.highlightRemoved).toBe(true);
    expect(stored.bounds).toEqual(detected);
    expect(getEffectiveBounds(stored)).toBeNull();

    await saveEntryImageEdits(entry, items([{ id: step.id, bounds: detected }]), base(1));
    stored = (await getStep(step.id))!;
    expect(stored).not.toHaveProperty('highlightRemoved');
    expect(getEffectiveBounds(stored)).toEqual(detected);
  });
});

describe('a snapshot\'s annotation boxes', () => {
  it('moves one annotation\'s box and leaves the others as detected', async () => {
    const { sessionId, anchorId, annotations } = await seedSnapshot(2);
    const [first, second] = annotations as [Step, Step];
    const entry = await openEntry(sessionId);

    await saveEntryImageEdits(
      entry,
      items([{ id: first.id, bounds: moved }, { id: second.id, bounds: second.bounds! }]),
      base(0, [first.id, second.id]),
    );

    expect(getEffectiveBounds((await getStep(first.id))!)).toEqual(moved);
    expect(await getStep(second.id)).not.toHaveProperty('manualBounds');
    expect((await getStep(anchorId))?.imageEditRevision).toBe(1);
  });

  it('deletes an annotation whose box is removed, renumbers the rest, and puts it back on undo', async () => {
    const { sessionId, anchorId, annotations } = await seedSnapshot(3);
    const [first, second, third] = annotations as [Step, Step, Step];
    const entry = await openEntry(sessionId);
    const known = new Map(annotations.map((annotation) => [annotation.id, annotation]));
    const boxOf = (step: Step): Highlight => ({ id: step.id, bounds: step.bounds! });

    await saveEntryImageEdits(entry, items([boxOf(first), boxOf(third)]), base(0, [first.id, second.id, third.id], known));
    let group = itemAt((await getProjectStructureSnapshot(sessionId)).entries, 0);
    expect(group.kind === 'group' && group.annotations.map((annotation) => annotation.id)).toEqual([first.id, third.id]);
    expect(await getStep(second.id)).toBeUndefined();
    expect((await getSteps(sessionId)).map((step) => step.order)).toEqual([0, 1, 2]);

    await saveEntryImageEdits(entry, items([boxOf(first), boxOf(second), boxOf(third)]), base(1, [first.id, third.id], known));
    group = itemAt((await getProjectStructureSnapshot(sessionId)).entries, 0);
    expect(group.kind === 'group' && group.annotations.map((annotation) => annotation.id)).toEqual([first.id, second.id, third.id]);
    expect((await getStep(second.id))?.description).toBe('標註 2');
    expect(group.kind === 'group' && group.anchor.id).toBe(anchorId);
  });

  it('refuses to save over annotations another tab changed, instead of bringing back what it deleted', async () => {
    const { sessionId, anchorId, annotations } = await seedSnapshot(2);
    const [first, second] = annotations as [Step, Step];
    const entry = await openEntry(sessionId);
    const known = new Map(annotations.map((annotation) => [annotation.id, annotation]));
    const project = (await getProjectStructureSnapshot(sessionId)).project;
    await deleteProjectAnnotationAtomically(sessionId, anchorId, second.id, project.contentRevision);

    await expect(saveEntryImageEdits(
      entry,
      items([{ id: first.id, bounds: moved }, { id: second.id, bounds: second.bounds! }]),
      base(0, [first.id, second.id], known),
    )).rejects.toBeInstanceOf(StepImageEditConflictError);
    expect(await getStep(second.id)).toBeUndefined();
    expect(await getStep(first.id)).not.toHaveProperty('manualBounds');
  });

  it('never leaves a snapshot without an annotation', async () => {
    const { sessionId, annotations } = await seedSnapshot(1);
    const entry = await openEntry(sessionId);

    await expect(saveEntryImageEdits(entry, items([]), base(0, [itemAt(annotations, 0).id]))).rejects.toThrow();
    expect(await getStep(itemAt(annotations, 0).id)).toBeDefined();
  });
});

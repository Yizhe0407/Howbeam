import 'fake-indexeddb/auto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectContentConflictError, addProjectSectionAtomically, deleteProjectAnnotationAtomically, deleteProjectEntriesAtomically, deleteProjectSectionAtomically, getProjectStructureSnapshot, moveProjectEntriesAtomically, repairEmptySnapshotAnchors, renameProjectSectionAtomically, reorderProjectAnnotationsAtomically, reorderProjectEntriesAtomically, restoreProjectAnnotationAtomically, restoreProjectEntriesAtomically } from '@/lib/storage/project-structure';
import { ProjectStructureIntegrityError, type ProjectSection, type Step } from '@/lib/storage/models';
import { closeDatabase, runWithDatabase } from '@/lib/storage/database';
import { createProjectFromSteps, deleteProjectPermanently, duplicateProject, getProjectSummaries, updateProject } from '@/lib/storage/project-repository';
import { getSteps } from '@/lib/storage/step-repository';
import { pngBlob } from '../setup/raster-fixtures';
import { itemAt } from '../setup/item-at';

const createdProjectIds = new Set<string>();

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(), sessionId: 'source-project', order: 0,
    screenshotBlob: pngBlob(),
    bounds: { x: 1, y: 2, width: 30, height: 40 }, devicePixelRatio: 1,
    description: '', url: 'https://example.com/path', timestamp: Date.now(), ...overrides,
  };
}

function makeSingleSteps(count: number): Step[] {
  return Array.from({ length: count }, (_, order) => makeStep({ order }));
}

function makeMixedSteps(): Step[] {
  const sessionId = 'source-project';
  const first = makeStep({ sessionId, order: 0 });
  const anchorId = crypto.randomUUID();
  const anchor = makeStep({ id: anchorId, sessionId, groupId: anchorId, bounds: null, order: 1 });
  const a1 = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 2 });
  const a2 = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 3 });
  const last = makeStep({ sessionId, order: 4 });
  return [first, anchor, a1, a2, last];
}

async function createTrackedProject(steps: readonly Step[], options: { sections?: readonly ProjectSection[] } = {}) {
  const project = await createProjectFromSteps(steps, undefined, options);
  createdProjectIds.add(project.id);
  return { project, snapshot: await getProjectStructureSnapshot(project.id) };
}

afterEach(async () => {
  for (const id of [...createdProjectIds]) {
    await deleteProjectPermanently(id).catch(() => undefined);
    createdProjectIds.delete(id);
  }
});
afterAll(closeDatabase);

describe('Project entry-safe atomic structure', () => {
  it('rejects stale revisions and rolls the whole mutation back', async () => {
    const { project, snapshot } = await createTrackedProject(makeSingleSteps(3));
    const moved = await moveProjectEntriesAtomically(project.id, [itemAt(snapshot.entryIds, 2)], 'start', snapshot.project.contentRevision);
    await expect(deleteProjectEntriesAtomically(project.id, [itemAt(snapshot.entryIds, 0)], snapshot.project.contentRevision))
      .rejects.toBeInstanceOf(ProjectContentConflictError);
    const after = await getProjectStructureSnapshot(project.id);
    expect(after.entryIds).toEqual(moved.entryIds);
    expect(after.project.contentRevision).toBe(moved.project.contentRevision);
  });

  it('reads a Project whose snapshot is still waiting for its first annotation, but will not mutate it', async () => {
    const { project, snapshot } = await createTrackedProject(makeMixedSteps());
    const anchorId = crypto.randomUUID();
    await runWithDatabase(async (db) => {
      const tx = db.transaction(['steps'], 'readwrite');
      await tx.objectStore('steps').put(makeStep({
        id: anchorId, sessionId: project.id, groupId: anchorId, bounds: null, order: 5,
      }));
      await tx.done;
    });

    const during = await getProjectStructureSnapshot(project.id);
    expect(during.entryIds).toEqual(snapshot.entryIds);
    await expect(deleteProjectEntriesAtomically(project.id, [itemAt(snapshot.entryIds, 0)], during.project.contentRevision))
      .rejects.toBeInstanceOf(ProjectStructureIntegrityError);
  });

  it('removes only the snapshot anchors that never got an annotation', async () => {
    const { project, snapshot } = await createTrackedProject(makeMixedSteps());
    const orphanId = crypto.randomUUID();
    await runWithDatabase(async (db) => {
      const tx = db.transaction(['steps'], 'readwrite');
      await tx.objectStore('steps').put(makeStep({
        id: orphanId, sessionId: project.id, groupId: orphanId, bounds: null, order: 5,
      }));
      await tx.done;
    });

    expect(await repairEmptySnapshotAnchors(project.id)).toBe(1);
    expect(await repairEmptySnapshotAnchors(project.id)).toBe(0);
    expect((await getSteps(project.id)).some((step) => step.id === orphanId)).toBe(false);
    expect((await getProjectStructureSnapshot(project.id)).entryIds).toEqual(snapshot.entryIds);
  });

  it('treats snapshot groups as indivisible and rejects annotation ids', async () => {
    const { project, snapshot } = await createTrackedProject(makeMixedSteps());
    const group = snapshot.entries.find((entry) => entry.kind === 'group');
    const annotationId = group?.kind === 'group' ? itemAt(group.annotations, 0).id : '';
    await expect(deleteProjectEntriesAtomically(project.id, [annotationId], snapshot.project.contentRevision))
      .rejects.toBeInstanceOf(ProjectStructureIntegrityError);
    await expect(reorderProjectEntriesAtomically(
      project.id, [itemAt(snapshot.entryIds, 0), annotationId, itemAt(snapshot.entryIds, 2)], snapshot.project.sections, snapshot.project.contentRevision,
    )).rejects.toBeInstanceOf(ProjectStructureIntegrityError);
    expect((await getProjectStructureSnapshot(project.id)).entryIds).toEqual(snapshot.entryIds);
  });

  it('rebases a deleted section start only within its old chapter', async () => {
    const { project, snapshot } = await createTrackedProject(makeSingleSteps(5));
    const first = await addProjectSectionAtomically(project.id, itemAt(snapshot.entryIds, 1), ' 第一章 ', snapshot.project.contentRevision);
    const second = await addProjectSectionAtomically(project.id, itemAt(snapshot.entryIds, 3), '第二章', first.project.contentRevision);
    const deletedStart = await deleteProjectEntriesAtomically(project.id, [itemAt(snapshot.entryIds, 1)], second.project.contentRevision);
    expect(deletedStart.project.sections.map((s) => s.startEntryId)).toEqual([snapshot.entryIds[2], snapshot.entryIds[3]]);
    const deletedChapter = await deleteProjectEntriesAtomically(project.id, [itemAt(snapshot.entryIds, 2)], deletedStart.project.contentRevision);
    expect(deletedChapter.project.sections).toEqual([
      expect.objectContaining({ title: '第二章', startEntryId: snapshot.entryIds[3] }),
    ]);
  });

  it('moves entries densely while headings follow entry identity', async () => {
    const { project, snapshot } = await createTrackedProject(makeSingleSteps(4));
    const sectioned = await addProjectSectionAtomically(project.id, itemAt(snapshot.entryIds, 1), '設定', snapshot.project.contentRevision);
    const moved = await moveProjectEntriesAtomically(
      project.id, [itemAt(snapshot.entryIds, 1), itemAt(snapshot.entryIds, 2)], 'end', sectioned.project.contentRevision,
    );
    expect(moved.entryIds).toEqual([snapshot.entryIds[0], snapshot.entryIds[3], snapshot.entryIds[1], snapshot.entryIds[2]]);
    expect(itemAt(moved.project.sections, 0).startEntryId).toBe(snapshot.entryIds[1]);
    expect((await getSteps(project.id)).map((step) => step.order)).toEqual([0, 1, 2, 3]);
  });


  it('remaps section boundaries for import-style clone and duplicate Project', async () => {
    const source = makeMixedSteps();
    const sourceSection = { id: crypto.randomUUID(), title: '匯入章節', startEntryId: itemAt(source, 1).id };
    const { project, snapshot } = await createTrackedProject(source, { sections: [sourceSection] });
    expect(itemAt(snapshot.project.sections, 0).id).not.toBe(sourceSection.id);
    expect(itemAt(snapshot.project.sections, 0).startEntryId).toBe(snapshot.entryIds[1]);
    expect(itemAt(snapshot.project.sections, 0).startEntryId).not.toBe(sourceSection.startEntryId);
    const duplicate = await duplicateProject(project.id);
    createdProjectIds.add(duplicate.id);
    const copy = await getProjectStructureSnapshot(duplicate.id);
    expect(itemAt(copy.project.sections, 0).id).not.toBe(itemAt(snapshot.project.sections, 0).id);
    expect(itemAt(copy.project.sections, 0).startEntryId).toBe(copy.entryIds[1]);
    expect(itemAt(copy.project.sections, 0).startEntryId).not.toBe(snapshot.entryIds[1]);
  });

  it('restores deleted entries, order, and sections against the post-delete revision', async () => {
    const { project, snapshot } = await createTrackedProject(makeSingleSteps(3));
    const sectioned = await addProjectSectionAtomically(project.id, itemAt(snapshot.entryIds, 1), '可復原章節', snapshot.project.contentRevision);
    const before = await getProjectStructureSnapshot(project.id);
    const removed = itemAt(before.entries, 1);
    const rows = removed.kind === 'single' ? [removed.step] : [removed.anchor, ...removed.annotations];
    const deleted = await deleteProjectEntriesAtomically(project.id, [itemAt(before.entryIds, 1)], sectioned.project.contentRevision);
    const restored = await restoreProjectEntriesAtomically(
      project.id, rows, before.entryIds, before.project.sections, deleted.project.contentRevision,
    );
    expect(restored.entryIds).toEqual(before.entryIds);
    expect(restored.project.sections).toEqual(before.project.sections);
  });

  it('still restores a deletion after the Project was renamed', async () => {
    const { project, snapshot } = await createTrackedProject(makeSingleSteps(3));
    const removed = itemAt(snapshot.entries, 1);
    const rows = removed.kind === 'single' ? [removed.step] : [removed.anchor, ...removed.annotations];
    const deleted = await deleteProjectEntriesAtomically(project.id, [itemAt(snapshot.entryIds, 1)], snapshot.project.contentRevision);
    await updateProject(project.id, { title: '改過的名稱' });
    const restored = await restoreProjectEntriesAtomically(
      project.id, rows, snapshot.entryIds, snapshot.project.sections, deleted.project.contentRevision,
    );
    expect(restored.entryIds).toEqual(snapshot.entryIds);
  });

  it('sanitizes section titles and supports atomic rename/delete', async () => {
    const { project, snapshot } = await createTrackedProject(makeSingleSteps(1));
    const added = await addProjectSectionAtomically(project.id, itemAt(snapshot.entryIds, 0), ' 章\n節 ', snapshot.project.contentRevision);
    expect(itemAt(added.project.sections, 0).title).toBe('章節');
    const renamed = await renameProjectSectionAtomically(project.id, itemAt(added.project.sections, 0).id, ' 新名稱 ', added.project.contentRevision);
    expect(itemAt(renamed.project.sections, 0).title).toBe('新名稱');
    const removed = await deleteProjectSectionAtomically(project.id, itemAt(renamed.project.sections, 0).id, renamed.project.contentRevision);
    expect(removed.project.sections).toEqual([]);
  });


  it('keeps summaries on the project store without opening step rows or blobs', async () => {
    const { project } = await createTrackedProject(makeSingleSteps(1));
    const indexSpy = vi.spyOn(IDBObjectStore.prototype, 'index');
    try {
      const summaries = await getProjectSummaries();
      expect(summaries.find((summary) => summary.id === project.id)?.sections).toEqual([]);
      expect(indexSpy.mock.calls.some(([name]) => name === 'by-session')).toBe(false);
    } finally { indexSpy.mockRestore(); }
  });
});

describe('strict annotation and visual CAS mutations', () => {
  it('deletes one annotation from a fresh complete group and returns transaction-local undo data', async () => {
    const { project, snapshot } = await createTrackedProject(makeMixedSteps());
    const group = itemAt(snapshot.entries, 1);
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const previousRevision = snapshot.project.contentRevision;

    const result = await deleteProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      itemAt(group.annotations, 0).id,
      previousRevision,
    );

    expect(result.project.contentRevision).toBe(previousRevision + 1);
    expect(result.previousAnnotationIds).toEqual(group.annotations.map((annotation) => annotation.id));
    expect(result.previousEntryIds).toEqual(snapshot.entryIds);
    expect(result.previousSections).toEqual(snapshot.project.sections);
    expect(result.beforeSnapshot.entryIds).toEqual(snapshot.entryIds);
    expect(result.beforeSnapshot.entries[1]).toEqual(group);
    expect(result.deletedSteps.map((step) => step.id)).toEqual([itemAt(group.annotations, 0).id]);
    expect(result.removedEntry).toBe(false);

    const stored = await getSteps(project.id);
    expect(stored.map((step) => step.order)).toEqual([0, 1, 2, 3]);
    expect(stored.map((step) => step.id)).toEqual([
      snapshot.entryIds[0],
      group.anchor.id,
      itemAt(group.annotations, 1).id,
      snapshot.entryIds[2],
    ]);
    expect(result.project).toMatchObject({ stepCount: 3, entryCount: 3 });
  });

  it('deletes the complete snapshot entry for its last annotation and deterministically rebases sections', async () => {
    const steps = makeMixedSteps().filter((step) => step.order !== 3);
    steps.forEach((step, order) => { step.order = order; });
    const { project, snapshot } = await createTrackedProject(steps);
    const group = itemAt(snapshot.entries, 1);
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const sectioned = await addProjectSectionAtomically(
      project.id,
      group.anchor.id,
      '快照章節',
      snapshot.project.contentRevision,
    );

    const result = await deleteProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      itemAt(group.annotations, 0).id,
      sectioned.project.contentRevision,
    );

    expect(result.removedEntry).toBe(true);
    expect(result.deletedSteps.map((step) => step.id)).toEqual([group.anchor.id, itemAt(group.annotations, 0).id]);
    expect(result.entryIds).toEqual([snapshot.entryIds[0], snapshot.entryIds[2]]);
    expect(result.project.sections).toEqual([
      expect.objectContaining({ title: '快照章節', startEntryId: snapshot.entryIds[2] }),
    ]);
    expect(result.project).toMatchObject({ stepCount: 2, entryCount: 2 });
    expect((await getSteps(project.id)).map((step) => step.order)).toEqual([0, 1]);
  });

  it('rejects stale or cross-group annotation deletes without partial writes', async () => {
    const { project, snapshot } = await createTrackedProject(makeMixedSteps());
    const group = itemAt(snapshot.entries, 1);
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const moved = await reorderProjectEntriesAtomically(
      project.id,
      [...snapshot.entryIds].reverse(),
      snapshot.project.sections,
      snapshot.project.contentRevision,
    );

    await expect(deleteProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      itemAt(group.annotations, 0).id,
      snapshot.project.contentRevision,
    )).rejects.toBeInstanceOf(ProjectContentConflictError);
    await expect(deleteProjectAnnotationAtomically(
      project.id,
      itemAt(snapshot.entryIds, 0),
      itemAt(group.annotations, 0).id,
      moved.project.contentRevision,
    )).rejects.toBeInstanceOf(ProjectStructureIntegrityError);

    const after = await getProjectStructureSnapshot(project.id);
    expect(after.entryIds).toEqual(moved.entryIds);
    expect(after.project.contentRevision).toBe(moved.project.contentRevision);
    expect(after.entries.find((entry) => entry.kind === 'group')).toMatchObject({
      annotations: [expect.objectContaining({ id: itemAt(group.annotations, 0).id }), expect.objectContaining({ id: itemAt(group.annotations, 1).id })],
    });
  });

  it('restores a deleted annotation at the exact transaction-provided prior position with dense orders', async () => {
    const { project, snapshot } = await createTrackedProject(makeMixedSteps());
    const group = itemAt(snapshot.entries, 1);
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const deleted = await deleteProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      itemAt(group.annotations, 0).id,
      snapshot.project.contentRevision,
    );
    const restoredAnnotation = itemAt(deleted.deletedSteps, 0);

    const restored = await restoreProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      restoredAnnotation,
      deleted.previousAnnotationIds,
      deleted.project.contentRevision,
    );

    expect(restored.project.contentRevision).toBe(deleted.project.contentRevision + 1);
    expect(restored.project).toMatchObject({
      stepCount: snapshot.project.stepCount,
      entryCount: snapshot.project.entryCount,
      storageBytes: snapshot.project.storageBytes,
    });
    const after = await getProjectStructureSnapshot(project.id);
    const restoredGroup = itemAt(after.entries, 1);
    expect(restoredGroup.kind).toBe('group');
    if (restoredGroup.kind !== 'group') throw new Error('Expected restored snapshot group.');
    expect(restoredGroup.annotations.map((annotation) => annotation.id)).toEqual(
      group.annotations.map((annotation) => annotation.id),
    );
    expect((await getSteps(project.id)).map((step) => step.order)).toEqual([0, 1, 2, 3, 4]);
    expect((await getSteps(project.id)).map((step) => step.id)).toEqual(
      snapshot.entries.flatMap((entry) => (
        entry.kind === 'single'
          ? [entry.step.id]
          : [entry.anchor.id, ...entry.annotations.map((annotation) => annotation.id)]
      )),
    );
  });

  it('rejects stale annotation restore revisions without recreating the deleted row', async () => {
    const { project, snapshot } = await createTrackedProject(makeMixedSteps());
    const group = itemAt(snapshot.entries, 1);
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const deleted = await deleteProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      itemAt(group.annotations, 0).id,
      snapshot.project.contentRevision,
    );
    const moved = await reorderProjectEntriesAtomically(
      project.id,
      [...deleted.entryIds].reverse(),
      deleted.project.sections,
      deleted.project.contentRevision,
    );

    await expect(restoreProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      itemAt(deleted.deletedSteps, 0),
      deleted.previousAnnotationIds,
      deleted.project.contentRevision,
    )).rejects.toBeInstanceOf(ProjectContentConflictError);

    const after = await getProjectStructureSnapshot(project.id);
    expect(after.project.contentRevision).toBe(moved.project.contentRevision);
    expect(after.entryIds).toEqual(moved.entryIds);
    expect((await getSteps(project.id)).some((step) => step.id === itemAt(group.annotations, 0).id)).toBe(false);
  });

  it('rolls back annotation restore for wrong groups, duplicate ids, and non-exact prior topology', async () => {
    const { project, snapshot } = await createTrackedProject(makeMixedSteps());
    const group = itemAt(snapshot.entries, 1);
    expect(group.kind).toBe('group');
    if (group.kind !== 'group') throw new Error('Expected snapshot group.');
    const deleted = await deleteProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      itemAt(group.annotations, 0).id,
      snapshot.project.contentRevision,
    );
    const deletedAnnotation = itemAt(deleted.deletedSteps, 0);
    const survivingId = itemAt(group.annotations, 1).id;

    await expect(restoreProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      { ...deletedAnnotation, groupId: 'another-anchor' },
      deleted.previousAnnotationIds,
      deleted.project.contentRevision,
    )).rejects.toBeInstanceOf(ProjectStructureIntegrityError);
    await expect(restoreProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      { ...deletedAnnotation, id: survivingId },
      [survivingId, survivingId],
      deleted.project.contentRevision,
    )).rejects.toBeInstanceOf(ProjectStructureIntegrityError);
    await expect(restoreProjectAnnotationAtomically(
      project.id,
      group.anchor.id,
      deletedAnnotation,
      [survivingId, group.anchor.id],
      deleted.project.contentRevision,
    )).rejects.toBeInstanceOf(ProjectStructureIntegrityError);

    const after = await getProjectStructureSnapshot(project.id);
    expect(after.project.contentRevision).toBe(deleted.project.contentRevision);
    const currentGroup = after.entries.find((entry) => entry.kind === 'group');
    expect(currentGroup).toMatchObject({
      annotations: [expect.objectContaining({ id: survivingId })],
    });
    expect((await getSteps(project.id)).some((step) => step.id === deletedAnnotation.id)).toBe(false);
  });

  it('reorders only the requested annotation group, keeps it contiguous, and returns the fresh prior order', async () => {
    const sessionId = 'source-project';
    const firstAnchorId = crypto.randomUUID();
    const secondAnchorId = crypto.randomUUID();
    const firstAnchor = makeStep({ id: firstAnchorId, sessionId, groupId: firstAnchorId, bounds: null, order: 0 });
    const firstA = makeStep({ sessionId, groupId: firstAnchorId, screenshotBlob: undefined, order: 1 });
    const firstB = makeStep({ sessionId, groupId: firstAnchorId, screenshotBlob: undefined, order: 2 });
    const secondAnchor = makeStep({ id: secondAnchorId, sessionId, groupId: secondAnchorId, bounds: null, order: 3 });
    const secondA = makeStep({ sessionId, groupId: secondAnchorId, screenshotBlob: undefined, order: 4 });
    const { project, snapshot } = await createTrackedProject([firstAnchor, firstA, firstB, secondAnchor, secondA]);
    const firstGroup = itemAt(snapshot.entries, 0);
    const secondGroup = itemAt(snapshot.entries, 1);
    expect(firstGroup.kind).toBe('group');
    expect(secondGroup.kind).toBe('group');
    if (firstGroup.kind !== 'group' || secondGroup.kind !== 'group') throw new Error('Expected groups.');

    await expect(reorderProjectAnnotationsAtomically(
      project.id,
      firstGroup.anchor.id,
      [itemAt(firstGroup.annotations, 1).id, itemAt(secondGroup.annotations, 0).id],
      snapshot.project.contentRevision,
    )).rejects.toBeInstanceOf(ProjectStructureIntegrityError);
    await expect(reorderProjectAnnotationsAtomically(
      project.id,
      firstGroup.anchor.id,
      [firstGroup.anchor.id, itemAt(firstGroup.annotations, 0).id],
      snapshot.project.contentRevision,
    )).rejects.toBeInstanceOf(ProjectStructureIntegrityError);

    const result = await reorderProjectAnnotationsAtomically(
      project.id,
      firstGroup.anchor.id,
      [...firstGroup.annotations].reverse().map((annotation) => annotation.id),
      snapshot.project.contentRevision,
    );
    expect(result.previousAnnotationIds).toEqual(firstGroup.annotations.map((annotation) => annotation.id));
    expect(result.project.contentRevision).toBe(snapshot.project.contentRevision + 1);
    const stored = await getSteps(project.id);
    expect(stored.map((step) => step.id)).toEqual([
      firstGroup.anchor.id,
      itemAt(firstGroup.annotations, 1).id,
      itemAt(firstGroup.annotations, 0).id,
      secondGroup.anchor.id,
      itemAt(secondGroup.annotations, 0).id,
    ]);
    expect(stored.map((step) => step.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('fails closed at the section cap without advancing contentRevision', async () => {
    const steps = makeSingleSteps(201);
    const sections = steps.slice(0, 200).map((step, index) => ({
      id: `section-${index}`,
      title: `Section ${index}`,
      startEntryId: step.id,
    }));
    const { project, snapshot } = await createTrackedProject(steps, { sections });
    expect(snapshot.project.sections).toHaveLength(200);

    await expect(addProjectSectionAtomically(
      project.id,
      itemAt(snapshot.entryIds, 200),
      'Overflow',
      snapshot.project.contentRevision,
    )).rejects.toThrow('Project cannot contain more than 200 sections.');

    const after = await getProjectStructureSnapshot(project.id);
    expect(after.project.contentRevision).toBe(snapshot.project.contentRevision);
    expect(after.project.sections).toEqual(snapshot.project.sections);
  });

  it('returns fresh previous entry order and sections from entry reorder transaction', async () => {
    const { project, snapshot } = await createTrackedProject(makeSingleSteps(3));
    const sectioned = await addProjectSectionAtomically(
      project.id,
      itemAt(snapshot.entryIds, 1),
      'Middle',
      snapshot.project.contentRevision,
    );
    const before = await getProjectStructureSnapshot(project.id);
    const result = await reorderProjectEntriesAtomically(
      project.id,
      [...before.entryIds].reverse(),
      before.project.sections,
      sectioned.project.contentRevision,
    );
    expect(result.previousEntryIds).toEqual(before.entryIds);
    expect(result.previousSections).toEqual(before.project.sections);
    expect(result.project.contentRevision).toBe(before.project.contentRevision + 1);
  });
});

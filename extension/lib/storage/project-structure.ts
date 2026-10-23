import {
  PROJECT_SECTION_LIMITS,
  repairProjectSections,
  sanitizeProjectSectionTitle,
  type ProjectSection,
} from '../project/project-sections';
import {
  assertExactEntryIds,
  buildCompleteStepEntries,
  entryId,
  ProjectStructureIntegrityError,
  flattenEntrySteps,
  orderedSessionSteps,
  sanitizeProject,
  sanitizeStepForStorage,
  stepRole,
  type Project,
  type Step,
  type StepEntry,
} from './models';
import { notifyProjectsChanged } from './change-notifier';
import {
  ProjectNotFoundError,
  requireWritableProject,
  runProjectStepsWrite,
  runWithDatabase,
  summarizeSteps,
  type ProjectStepsTransaction,
  type ReadonlyProjectStepsTransaction,
} from './database';

export class ProjectContentConflictError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super('Project content changed before the operation was committed.');
    this.name = 'ProjectContentConflictError';
  }
}

export interface ProjectStructureSnapshot {
  project: Project;
  entries: StepEntry[];
  entryIds: string[];
}

export interface ProjectStructureMutationResult {
  project: Project;
  /** The committed structure, so the caller can show it without reading it back. */
  entries: StepEntry[];
  entryIds: string[];
  affectedEntryIds: string[];
}

export interface ReorderProjectEntriesResult extends ProjectStructureMutationResult {
  /** Fresh transaction-local order, suitable for an undo CAS. */
  previousEntryIds: string[];
  /** Fresh transaction-local section metadata, before reorder repair/sorting. */
  previousSections: ProjectSection[];
}

export interface DeleteProjectAnnotationResult extends ProjectStructureMutationResult {
  /** Canonical snapshot read in the same transaction before any rows changed. */
  beforeSnapshot: ProjectStructureSnapshot;
  /** Annotation order read from the persisted group, never from editor state. */
  previousAnnotationIds: string[];
  previousEntryIds: string[];
  previousSections: ProjectSection[];
  /** One annotation normally; anchor + annotation when the group became empty. */
  deletedSteps: Step[];
  removedEntry: boolean;
}

export interface ReorderProjectAnnotationsResult extends ProjectStructureMutationResult {
  previousAnnotationIds: string[];
}

interface WritableProjectStructure extends ProjectStructureSnapshot {
  steps: Step[];
}

function structureSnapshot(
  project: Project,
  steps: readonly Step[],
  options: { skipPendingGroups?: boolean } = {},
): ProjectStructureSnapshot {
  const entries = buildCompleteStepEntries(steps, project.id, options);
  const repairedProject = sanitizeProject({
    ...project,
    sections: repairProjectSections(project.sections, entries),
  });
  return { project: repairedProject, entries, entryIds: entries.map(entryId) };
}

function copyStructureSnapshot(structure: ProjectStructureSnapshot): ProjectStructureSnapshot {
  return {
    project: {
      ...structure.project,
      sections: structure.project.sections.map((section) => ({ ...section })),
    },
    entries: structure.entries.map((entry): StepEntry => (
      entry.kind === 'single'
        ? { kind: 'single', step: { ...entry.step } }
        : {
            kind: 'group',
            anchor: { ...entry.anchor },
            annotations: entry.annotations.map((annotation) => ({ ...annotation })),
          }
    )),
    entryIds: [...structure.entryIds],
  };
}

function requireSnapshotGroup(entries: readonly StepEntry[], anchorId: string): Extract<StepEntry, { kind: 'group' }> {
  const entry = entries.find((candidate) => entryId(candidate) === anchorId);
  if (!entry || entry.kind !== 'group' || entry.anchor.id !== anchorId) {
    throw new ProjectStructureIntegrityError('Snapshot anchor was not found or no longer owns a complete group.');
  }
  return entry;
}

function assertExactAnnotationIds(
  group: Extract<StepEntry, { kind: 'group' }>,
  orderedAnnotationIds: readonly string[],
): void {
  const actualIds = group.annotations.map((annotation) => annotation.id);
  if (
    orderedAnnotationIds.length !== actualIds.length
    || new Set(orderedAnnotationIds).size !== orderedAnnotationIds.length
  ) {
    throw new ProjectStructureIntegrityError('Annotation order must contain every group annotation exactly once.');
  }
  const actual = new Set(actualIds);
  if (orderedAnnotationIds.some((id) => !actual.has(id))) {
    throw new ProjectStructureIntegrityError('Annotation order contains an anchor or an annotation from another group.');
  }
}

function assertExactRestoredAnnotationIds(
  group: Extract<StepEntry, { kind: 'group' }>,
  restoredAnnotationId: string,
  previousAnnotationIds: readonly string[],
): void {
  const expectedIds = new Set([
    ...group.annotations.map((annotation) => annotation.id),
    restoredAnnotationId,
  ]);
  if (
    previousAnnotationIds.length !== group.annotations.length + 1
    || new Set(previousAnnotationIds).size !== previousAnnotationIds.length
    || expectedIds.size !== group.annotations.length + 1
    || previousAnnotationIds.some((id) => !expectedIds.has(id))
  ) {
    throw new ProjectStructureIntegrityError(
      'Previous annotation order must contain the current group plus the restored annotation exactly once.',
    );
  }
}

async function requireWritableProjectStructure(
  tx: ProjectStepsTransaction,
  sessionId: string,
  expectedContentRevision: number,
): Promise<WritableProjectStructure> {
  if (!Number.isSafeInteger(expectedContentRevision) || expectedContentRevision < 0) {
    throw new TypeError('Expected content revision must be a non-negative integer.');
  }
  const project = await requireWritableProject(tx, sessionId);
  if (project.contentRevision !== expectedContentRevision) {
    throw new ProjectContentConflictError(sessionId, expectedContentRevision, project.contentRevision);
  }
  const steps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
  return { ...structureSnapshot(project, steps), steps: orderedSessionSteps(steps) };
}

async function commitProjectStructure(
  tx: ProjectStepsTransaction,
  structure: WritableProjectStructure,
  nextEntries: readonly StepEntry[],
  nextSections: readonly ProjectSection[],
  affectedEntryIds: readonly string[],
): Promise<ProjectStructureMutationResult> {
  const previousById = new Map(structure.steps.map((step) => [step.id, step]));
  // Rows exactly as stored, so the returned structure is what a later read would see.
  const denseSteps = flattenEntrySteps(nextEntries).map((step, order) => {
    const ordered = step.order === order ? step : { ...step, order };
    return previousById.get(ordered.id) === ordered ? ordered : sanitizeStepForStorage(ordered);
  });
  const completeEntries = buildCompleteStepEntries(denseSteps, structure.project.id);
  const nextIds = new Set(denseSteps.map((step) => step.id));

  for (const previous of structure.steps) {
    if (!nextIds.has(previous.id)) await tx.objectStore('steps').delete(previous.id);
  }
  for (const step of denseSteps) {
    if (previousById.get(step.id) !== step) await tx.objectStore('steps').put(step);
  }

  const now = Date.now();
  const project = sanitizeProject({
    ...structure.project,
    ...summarizeSteps(denseSteps),
    sections: repairProjectSections(nextSections, completeEntries),
    updatedAt: Math.max(structure.project.updatedAt, now),
    contentRevision: structure.project.contentRevision + 1,
  });
  await tx.objectStore('projects').put(project);
  return {
    project,
    entries: completeEntries,
    entryIds: completeEntries.map(entryId),
    affectedEntryIds: [...new Set(affectedEntryIds)],
  };
}

async function runProjectStructureMutation<T extends ProjectStructureMutationResult>(
  sessionId: string,
  expectedContentRevision: number,
  mutate: (tx: ProjectStepsTransaction, structure: WritableProjectStructure) => Promise<T>,
): Promise<T> {
  return runProjectStepsWrite(async (tx) => {
    const structure = await requireWritableProjectStructure(tx, sessionId, expectedContentRevision);
    return mutate(tx, structure);
  });
}

function requireEntrySelection(
  entries: readonly StepEntry[],
  requestedIds: readonly string[],
  allowEmpty = false,
): { selectedIds: Set<string>; byId: Map<string, StepEntry> } {
  const selectedIds = new Set(requestedIds);
  if ((!allowEmpty && selectedIds.size === 0) || selectedIds.size !== requestedIds.length) {
    throw new ProjectStructureIntegrityError('Entry selection must contain unique entry ids.');
  }
  const byId = new Map(entries.map((entry) => [entryId(entry), entry]));
  if ([...selectedIds].some((id) => !byId.has(id))) {
    throw new ProjectStructureIntegrityError('Entry selection contains an unknown or annotation id.');
  }
  return { selectedIds, byId };
}

function rebaseSectionsAfterDelete(
  sections: readonly ProjectSection[],
  previousEntryIds: readonly string[],
  survivingEntryIds: ReadonlySet<string>,
): ProjectSection[] {
  const starts = new Map(previousEntryIds.map((id, index) => [id, index]));
  const orderedSections = [...sections]
    .map((section) => ({ section, index: starts.get(section.startEntryId) }))
    .filter((item): item is { section: ProjectSection; index: number } => item.index !== undefined)
    .sort((left, right) => left.index - right.index);
  const rebased: ProjectSection[] = [];
  for (let index = 0; index < orderedSections.length; index += 1) {
    const current = orderedSections[index];
    const end = orderedSections[index + 1]?.index ?? previousEntryIds.length;
    const nextStart = previousEntryIds.slice(current.index, end).find((id) => survivingEntryIds.has(id));
    if (nextStart) rebased.push({ ...current.section, startEntryId: nextStart });
  }
  return rebased;
}

export async function getProjectStructureSnapshot(sessionId: string): Promise<ProjectStructureSnapshot> {
  return runWithDatabase(async (db) => {
    const tx: ReadonlyProjectStepsTransaction = db.transaction(['projects', 'steps'], 'readonly');
    const rawProject = await tx.objectStore('projects').get(sessionId);
    if (!rawProject) {
      await tx.done;
      throw new ProjectNotFoundError(sessionId);
    }
    const project = sanitizeProject(rawProject);
    const steps = await tx.objectStore('steps').index('by-session').getAll(sessionId);
    // Read-only view: a snapshot still waiting for its first annotation is not shown rather
    // than making the whole Project unreadable while it is being recorded.
    const snapshot = structureSnapshot(project, steps, { skipPendingGroups: true });
    await tx.done;
    return snapshot;
  });
}

/**
 * Removes snapshot anchors that never received an annotation. A recording cleans up its own,
 * but one can be left behind when the browser is closed mid-recording. The caller must make
 * sure no recording is still adding to this Project. Returns how many were removed.
 */
export async function repairEmptySnapshotAnchors(sessionId: string): Promise<number> {
  return runWithDatabase(async (db) => {
    const tx = db.transaction(['steps'], 'readwrite');
    const store = tx.objectStore('steps');
    const steps = await store.index('by-session').getAll(sessionId);
    const annotated = new Set(
      steps.filter((step) => step.groupId && stepRole(step) === 'annotation').map((step) => step.groupId),
    );
    const orphans = steps.filter((step) => step.groupId === step.id && stepRole(step) === 'anchor' && !annotated.has(step.id));
    for (const orphan of orphans) await store.delete(orphan.id);
    await tx.done;
    if (orphans.length > 0) notifyProjectsChanged();
    return orphans.length;
  });
}

export async function reorderProjectEntriesAtomically(
  sessionId: string,
  orderedEntryIds: readonly string[],
  sections: readonly ProjectSection[],
  expectedContentRevision: number,
): Promise<ReorderProjectEntriesResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    assertExactEntryIds(structure.entries, orderedEntryIds);
    const byId = new Map(structure.entries.map((entry) => [entryId(entry), entry]));
    const previousEntryIds = [...structure.entryIds];
    const previousSections = structure.project.sections.map((section) => ({ ...section }));
    const result = await commitProjectStructure(
      tx,
      structure,
      orderedEntryIds.map((id) => byId.get(id)!),
      sections,
      orderedEntryIds,
    );
    return { ...result, previousEntryIds, previousSections };
  });
}

export async function deleteProjectAnnotationAtomically(
  sessionId: string,
  anchorId: string,
  annotationId: string,
  expectedContentRevision: number,
): Promise<DeleteProjectAnnotationResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const group = requireSnapshotGroup(structure.entries, anchorId);
    const annotationIndex = group.annotations.findIndex((annotation) => annotation.id === annotationId);
    if (annotationIndex < 0) {
      throw new ProjectStructureIntegrityError('Annotation does not belong to the requested snapshot group.');
    }

    const beforeSnapshot = copyStructureSnapshot(structure);
    const previousAnnotationIds = group.annotations.map((annotation) => annotation.id);
    const previousEntryIds = [...structure.entryIds];
    const previousSections = structure.project.sections.map((section) => ({ ...section }));
    const removedEntry = group.annotations.length === 1;
    let nextEntries: StepEntry[];
    let nextSections: ProjectSection[] = structure.project.sections;
    let deletedSteps: Step[];

    if (removedEntry) {
      nextEntries = structure.entries.filter((entry) => entryId(entry) !== anchorId);
      const survivingIds = new Set(nextEntries.map(entryId));
      nextSections = rebaseSectionsAfterDelete(
        structure.project.sections,
        structure.entryIds,
        survivingIds,
      );
      deletedSteps = [group.anchor, group.annotations[annotationIndex]];
    } else {
      const annotations = group.annotations.filter((annotation) => annotation.id !== annotationId);
      nextEntries = structure.entries.map((entry): StepEntry => (
        entryId(entry) === anchorId ? { kind: 'group', anchor: group.anchor, annotations } : entry
      ));
      deletedSteps = [group.annotations[annotationIndex]];
    }

    const result = await commitProjectStructure(
      tx,
      structure,
      nextEntries,
      nextSections,
      [anchorId],
    );
    return {
      ...result,
      beforeSnapshot,
      previousAnnotationIds,
      previousEntryIds,
      previousSections,
      deletedSteps,
      removedEntry,
    };
  });
}

export async function reorderProjectAnnotationsAtomically(
  sessionId: string,
  anchorId: string,
  orderedAnnotationIds: readonly string[],
  expectedContentRevision: number,
): Promise<ReorderProjectAnnotationsResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const group = requireSnapshotGroup(structure.entries, anchorId);
    assertExactAnnotationIds(group, orderedAnnotationIds);
    const previousAnnotationIds = group.annotations.map((annotation) => annotation.id);
    const byId = new Map(group.annotations.map((annotation) => [annotation.id, annotation]));
    const reorderedGroup: StepEntry = {
      kind: 'group',
      anchor: group.anchor,
      annotations: orderedAnnotationIds.map((id) => byId.get(id)!),
    };
    const nextEntries = structure.entries.map((entry) => (
      entryId(entry) === anchorId ? reorderedGroup : entry
    ));
    const result = await commitProjectStructure(
      tx,
      structure,
      nextEntries,
      structure.project.sections,
      [anchorId],
    );
    return { ...result, previousAnnotationIds };
  });
}

/** Strict inverse of a non-terminal annotation delete. The restored row's old
 * numeric order is deliberately ignored: the transaction reconstructs the
 * complete group from previousAnnotationIds and then commits dense orders. */
export async function restoreProjectAnnotationAtomically(
  sessionId: string,
  anchorId: string,
  restoredAnnotation: Step,
  previousAnnotationIds: readonly string[],
  expectedContentRevision: number,
): Promise<ProjectStructureMutationResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const group = requireSnapshotGroup(structure.entries, anchorId);
    if (
      typeof restoredAnnotation.id !== 'string'
      || restoredAnnotation.id.length === 0
      || restoredAnnotation.id === anchorId
      || restoredAnnotation.sessionId !== sessionId
      || restoredAnnotation.groupId !== anchorId
    ) {
      throw new ProjectStructureIntegrityError(
        'Restored annotation must be a distinct member of the requested snapshot group.',
      );
    }
    if (await tx.objectStore('steps').get(restoredAnnotation.id)) {
      throw new ProjectStructureIntegrityError('Restored annotation id already exists.');
    }
    assertExactRestoredAnnotationIds(group, restoredAnnotation.id, previousAnnotationIds);

    const restored = sanitizeStepForStorage(restoredAnnotation);
    const byId = new Map(group.annotations.map((annotation) => [annotation.id, annotation]));
    byId.set(restored.id, restored);
    const restoredGroup: StepEntry = {
      kind: 'group',
      anchor: group.anchor,
      annotations: previousAnnotationIds.map((id) => byId.get(id)!),
    };
    const nextEntries = structure.entries.map((entry) => (
      entryId(entry) === anchorId ? restoredGroup : entry
    ));
    return commitProjectStructure(
      tx,
      structure,
      nextEntries,
      structure.project.sections,
      [anchorId],
    );
  });
}

export async function deleteProjectEntriesAtomically(
  sessionId: string,
  entryIdsToDelete: readonly string[],
  expectedContentRevision: number,
): Promise<ProjectStructureMutationResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { selectedIds } = requireEntrySelection(structure.entries, entryIdsToDelete);
    const nextEntries = structure.entries.filter((entry) => !selectedIds.has(entryId(entry)));
    const survivingIds = new Set(nextEntries.map(entryId));
    const sections = rebaseSectionsAfterDelete(structure.project.sections, structure.entryIds, survivingIds);
    return commitProjectStructure(tx, structure, nextEntries, sections, entryIdsToDelete);
  });
}

export async function restoreProjectEntriesAtomically(
  sessionId: string,
  restoredSteps: readonly Step[],
  previousEntryIds: readonly string[],
  previousSections: readonly ProjectSection[],
  expectedContentRevision: number,
): Promise<ProjectStructureMutationResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    if (restoredSteps.length === 0) throw new ProjectStructureIntegrityError('No entries were provided for restore.');
    const currentStepIds = new Set(structure.steps.map((step) => step.id));
    if (restoredSteps.some((step) => step.sessionId !== sessionId || currentStepIds.has(step.id))) {
      throw new ProjectStructureIntegrityError('Restored rows conflict with the current Project.');
    }
    const restoredEntries = buildCompleteStepEntries(restoredSteps, sessionId);
    const allEntries = [...structure.entries, ...restoredEntries];
    assertExactEntryIds(allEntries, previousEntryIds);
    const byId = new Map(allEntries.map((entry) => [entryId(entry), entry]));
    const nextEntries = previousEntryIds.map((id) => byId.get(id)!);
    return commitProjectStructure(
      tx,
      structure,
      nextEntries,
      repairProjectSections(previousSections, nextEntries),
      restoredEntries.map(entryId),
    );
  });
}

export async function moveProjectEntriesAtomically(
  sessionId: string,
  entryIdsToMove: readonly string[],
  destination: 'start' | 'end',
  expectedContentRevision: number,
): Promise<ProjectStructureMutationResult> {
  if (destination !== 'start' && destination !== 'end') throw new TypeError('Invalid move destination.');
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { selectedIds } = requireEntrySelection(structure.entries, entryIdsToMove);
    const selected = structure.entries.filter((entry) => selectedIds.has(entryId(entry)));
    const unselected = structure.entries.filter((entry) => !selectedIds.has(entryId(entry)));
    const nextEntries = destination === 'start' ? [...selected, ...unselected] : [...unselected, ...selected];
    return commitProjectStructure(tx, structure, nextEntries, structure.project.sections, entryIdsToMove);
  });
}

export async function setProjectEntriesNumberedAtomically(
  sessionId: string,
  entryIdsToUpdate: readonly string[],
  numbered: boolean,
  expectedContentRevision: number,
): Promise<ProjectStructureMutationResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const { selectedIds } = requireEntrySelection(structure.entries, entryIdsToUpdate);
    const affected: string[] = [];
    const nextEntries = structure.entries.map((entry): StepEntry => {
      const id = entryId(entry);
      if (!selectedIds.has(id) || entry.kind === 'single') return entry;
      affected.push(id);
      return {
        kind: 'group',
        anchor: { ...entry.anchor, numbered },
        annotations: entry.annotations.map((annotation) => ({ ...annotation, numbered })),
      };
    });
    if (affected.length === 0) {
      return { project: structure.project, entries: structure.entries, entryIds: structure.entryIds, affectedEntryIds: [] };
    }
    return commitProjectStructure(tx, structure, nextEntries, structure.project.sections, affected);
  });
}


export async function addProjectSectionAtomically(
  sessionId: string,
  startEntryId: string,
  title: string,
  expectedContentRevision: number,
): Promise<ProjectStructureMutationResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    requireEntrySelection(structure.entries, [startEntryId]);
    const sanitizedTitle = sanitizeProjectSectionTitle(title);
    if (!sanitizedTitle) throw new TypeError('Section title cannot be empty.');
    if (structure.project.sections.some((section) => section.startEntryId === startEntryId)) {
      throw new ProjectStructureIntegrityError('An entry can begin only one section.');
    }
    if (structure.project.sections.length >= PROJECT_SECTION_LIMITS.maxSections) {
      throw new ProjectStructureIntegrityError(
        `Project cannot contain more than ${PROJECT_SECTION_LIMITS.maxSections} sections.`,
      );
    }
    const sections = [...structure.project.sections, {
      id: crypto.randomUUID(),
      title: sanitizedTitle,
      startEntryId,
    }];
    return commitProjectStructure(tx, structure, structure.entries, sections, [startEntryId]);
  });
}

export async function renameProjectSectionAtomically(
  sessionId: string,
  sectionId: string,
  title: string,
  expectedContentRevision: number,
): Promise<ProjectStructureMutationResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const sanitizedTitle = sanitizeProjectSectionTitle(title);
    if (!sanitizedTitle) throw new TypeError('Section title cannot be empty.');
    let found = false;
    const sections = structure.project.sections.map((section) => {
      if (section.id !== sectionId) return section;
      found = true;
      return { ...section, title: sanitizedTitle };
    });
    if (!found) throw new ProjectStructureIntegrityError('Section not found.');
    return commitProjectStructure(tx, structure, structure.entries, sections, []);
  });
}

export async function deleteProjectSectionAtomically(
  sessionId: string,
  sectionId: string,
  expectedContentRevision: number,
): Promise<ProjectStructureMutationResult> {
  return runProjectStructureMutation(sessionId, expectedContentRevision, async (tx, structure) => {
    const sections = structure.project.sections.filter((section) => section.id !== sectionId);
    if (sections.length === structure.project.sections.length) {
      throw new ProjectStructureIntegrityError('Section not found.');
    }
    return commitProjectStructure(tx, structure, structure.entries, sections, []);
  });
}

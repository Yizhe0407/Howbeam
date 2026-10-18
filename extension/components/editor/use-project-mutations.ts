import {
  equalIds,
  type PendingUndoAction,
  type UndoAction,
} from '@/lib/editor/editor-app-model';
import { addProjectSectionAtomically, deleteProjectAnnotationAtomically, deleteProjectEntriesAtomically, deleteProjectSectionAtomically, getProjectStructureSnapshot, ProjectContentConflictError, renameProjectSectionAtomically, reorderProjectAnnotationsAtomically, reorderProjectEntriesAtomically, restoreProjectAnnotationAtomically, restoreProjectEntriesAtomically, setProjectEntriesNumberedAtomically, type ProjectStructureSnapshot } from '@/lib/storage/project-structure';
import { entryId, type Project, type Step, type StepEntry } from '@/lib/storage/models';
import { t, type Messages } from '@/lib/shared/i18n';

/** A structural edit with its own progress/failure copy in the i18n catalog. */
type ProjectMutationOperation = Exclude<keyof Messages['editor']['mutations'], 'conflict' | 'reloadFailed'>;

interface UseProjectMutationsOptions {
  sessionId: string | null;
  project: Project | null;
  /** The rendered (optimistic-first) entry list. */
  entries: StepEntry[];
  selectedEntryId: string | null;
  beginDataOperation: (label: string) => boolean;
  endDataOperation: () => void;
  setOptimisticEntries: (entries: StepEntry[] | null) => void;
  flushDescriptions: () => Promise<void>;
  refreshEditorData: () => Promise<ProjectStructureSnapshot | null>;
  /** Publishes the fresh Project a successful compare-and-swap returned. */
  adoptProject: (project: Project | null) => void;
  requireSelectedEntry: (expectedEntryId?: string) => StepEntry;
  setSelectedEntryId: (id: string | null) => void;
  setZoomOpen: (open: boolean) => void;
  setOperationError: (message: string | null) => void;
  undoAction: UndoAction | null;
  offerUndo: (pending: PendingUndoAction, projectId: string, superseded?: UndoAction | null) => void;
  takeUndo: () => UndoAction | null;
  returnUndo: (taken: UndoAction | null) => void;
  finalizeUndo: (taken: UndoAction | null) => void;
  clearUndo: () => void;
}

/**
 * The editor's structural mutations: each takes the data lock, flushes pending descriptions, reads a
 * fresh snapshot, compare-and-swaps against its revision, reloads, then offers an undo — rolling back
 * any optimistic entry swap first if the round-trip fails.
 */
export function useProjectMutations({
  sessionId,
  project,
  entries,
  selectedEntryId,
  beginDataOperation,
  endDataOperation,
  setOptimisticEntries,
  flushDescriptions,
  refreshEditorData,
  adoptProject,
  requireSelectedEntry,
  setSelectedEntryId,
  setZoomOpen,
  setOperationError,
  undoAction,
  offerUndo,
  takeUndo,
  returnUndo,
  finalizeUndo,
  clearUndo,
}: UseProjectMutationsOptions) {
  function showStructureMutationError(operation: ProjectMutationOperation, mutationError: unknown): void {
    console.error(`[stepmark] project mutation failed: ${operation}`, mutationError);
    setOperationError(
      mutationError instanceof ProjectContentConflictError
        ? t().editor.mutations.conflict
        : t().editor.mutations[operation].failed,
    );
  }

  /**
   * Shared lock/flush/reload/error contract for every structural edit; only `mutate` (the compare-and-swap
   * step) differs per operation. `optimistic` swaps the rendered entry list before the round-trip and
   * restores it on failure. `rethrow` is for callers whose child component renders its own inline failure state.
   */
  async function runProjectMutation({
    operation,
    optimistic,
    rethrow = false,
    mutate,
  }: {
    /** Names the operation's progress and failure copy in the i18n catalog. */
    operation: ProjectMutationOperation;
    optimistic?: { next: StepEntry[]; previous: StepEntry[] };
    rethrow?: boolean;
    mutate: (snapshot: ProjectStructureSnapshot, projectId: string) => Promise<PendingUndoAction | void>;
  }): Promise<void> {
    if (!sessionId || !beginDataOperation(t().editor.mutations[operation].pending)) return;
    // Only one undo is offered at a time: this mutation either replaces the pending one
    // (and says it is now final), makes it final without a replacement, or hands it back on failure.
    const takenUndo = takeUndo();
    setOperationError(null);
    if (optimistic) setOptimisticEntries(optimistic.next);
    try {
      let undo: PendingUndoAction | void;
      try {
        await flushDescriptions();
        const snapshot = await getProjectStructureSnapshot(sessionId);
        undo = await mutate(snapshot, sessionId);
      } catch (mutationError) {
        if (optimistic) setOptimisticEntries(optimistic.previous);
        showStructureMutationError(operation, mutationError);
        try {
          await refreshEditorData();
        } catch (refreshError) {
          console.error(`[stepmark] reload after failed ${operation} failed`, refreshError);
        } finally {
          if (!optimistic) setOptimisticEntries(null);
        }
        returnUndo(takenUndo);
        if (rethrow) throw mutationError;
        return;
      }
      // The compare-and-swap committed, so a failed reload must not roll back the now-accurate
      // optimistic entries or report the operation itself as failed — only that the screen may be stale.
      try {
        await refreshEditorData();
      } catch (reloadError) {
        console.error(`[stepmark] reload after ${operation} failed`, reloadError);
        setOperationError(t().editor.mutations.reloadFailed);
      }
      if (undo) offerUndo(undo, sessionId, takenUndo);
      else finalizeUndo(takenUndo);
    } finally {
      endDataOperation();
    }
  }

  async function handleReorderEntries(newEntries: StepEntry[]) {
    if (!project) return;
    const previousEntries = entries;
    const expectedRevision = project.contentRevision;
    await runProjectMutation({
      operation: 'reorderSteps',
      optimistic: { next: newEntries, previous: previousEntries },
      mutate: async (snapshot, projectId) => {
        if (!equalIds(snapshot.entryIds, previousEntries.map(entryId))) {
          throw new ProjectContentConflictError(projectId, expectedRevision, snapshot.project.contentRevision);
        }
        const result = await reorderProjectEntriesAtomically(
          projectId,
          newEntries.map(entryId),
          snapshot.project.contentRevision,
        );
        adoptProject(result.project);
        return {
          message: t().editor.mutations.reorderSteps.done,
          expectedRevision: result.project.contentRevision,
          restore: () => reorderProjectEntriesAtomically(
            projectId,
            result.previousEntryIds,
            result.project.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function handleReorderAnnotations(anchorId: string, reordered: Step[]) {
    requireSelectedEntry(anchorId);
    const previousEntries = entries;
    const previousGroup = previousEntries.find(
      (entry): entry is Extract<StepEntry, { kind: 'group' }> => entry.kind === 'group' && entry.anchor.id === anchorId,
    );
    if (!previousGroup) throw new Error(t().editor.mutations.reorderAnnotations.groupMissing);
    const nextEntries = previousEntries.map((entry) => (
      entry.kind === 'group' && entry.anchor.id === anchorId ? { ...entry, annotations: reordered } : entry
    ));
    await runProjectMutation({
      operation: 'reorderAnnotations',
      optimistic: { next: nextEntries, previous: previousEntries },
      rethrow: true,
      mutate: async (snapshot, projectId) => {
        const freshGroup = snapshot.entries.find(
          (entry): entry is Extract<StepEntry, { kind: 'group' }> => entry.kind === 'group' && entry.anchor.id === anchorId,
        );
        if (!freshGroup || !equalIds(
          freshGroup.annotations.map((annotation) => annotation.id),
          previousGroup.annotations.map((annotation) => annotation.id),
        )) {
          throw new ProjectContentConflictError(
            projectId,
            project?.contentRevision ?? snapshot.project.contentRevision,
            snapshot.project.contentRevision,
          );
        }
        const result = await reorderProjectAnnotationsAtomically(
          projectId,
          anchorId,
          reordered.map((annotation) => annotation.id),
          snapshot.project.contentRevision,
        );
        adoptProject(result.project);
        return {
          message: t().editor.mutations.reorderAnnotations.done,
          expectedRevision: result.project.contentRevision,
          restoreSelectionId: anchorId,
          restore: () => reorderProjectAnnotationsAtomically(
            projectId,
            anchorId,
            result.previousAnnotationIds,
            result.project.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function deleteEntry() {
    const currentEntryId = entryId(requireSelectedEntry());
    await runProjectMutation({
      operation: 'deleteStep',
      rethrow: true,
      mutate: async (snapshot, projectId) => {
        const deletingEntry = snapshot.entries.find((entry) => entryId(entry) === currentEntryId);
        if (!deletingEntry) throw new Error(t().editor.mutations.deleteStep.changed);
        const deletingIndex = snapshot.entryIds.indexOf(currentEntryId);
        const result = await deleteProjectEntriesAtomically(
          projectId,
          [currentEntryId],
          snapshot.project.contentRevision,
        );
        adoptProject(result.project);
        const nextIndex = Math.min(Math.max(deletingIndex, 0), result.entryIds.length - 1);
        setSelectedEntryId(nextIndex >= 0 ? result.entryIds[nextIndex] : null);
        setZoomOpen(false);
        const deletedSteps = deletingEntry.kind === 'single'
          ? [deletingEntry.step]
          : [deletingEntry.anchor, ...deletingEntry.annotations];
        return {
          message: t().editor.mutations.deleteStep.done(deletingIndex + 1),
          expectedRevision: result.project.contentRevision,
          restoreSelectionId: currentEntryId,
          restore: () => restoreProjectEntriesAtomically(
            projectId,
            deletedSteps,
            snapshot.entryIds,
            snapshot.project.sections,
            result.project.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function handleDeleteAnnotation(step: Step) {
    const currentEntry = requireSelectedEntry(step.groupId);
    if (currentEntry.kind !== 'group') throw new Error(t().editor.mutations.deleteAnnotation.notSnapshot);
    const groupId = step.groupId;
    if (!groupId) return;
    const previousEntries = entries;
    const deletingGroup = previousEntries.find(
      (entry): entry is Extract<StepEntry, { kind: 'group' }> => entry.kind === 'group' && entry.anchor.id === groupId,
    );
    const annotationIndex = deletingGroup?.annotations.findIndex((annotation) => annotation.id === step.id) ?? -1;
    const nextEntries = previousEntries.flatMap((entry) => {
      if (entry.kind !== 'group' || entry.anchor.id !== groupId) return [entry];
      if (entry.annotations.length === 1) return [];
      return [{ ...entry, annotations: entry.annotations.filter((annotation) => annotation.id !== step.id) }];
    });
    await runProjectMutation({
      operation: 'deleteAnnotation',
      optimistic: { next: nextEntries, previous: previousEntries },
      rethrow: true,
      mutate: async (snapshot, projectId) => {
        const result = await deleteProjectAnnotationAtomically(
          projectId,
          groupId,
          step.id,
          snapshot.project.contentRevision,
        );
        adoptProject(result.project);
        if (result.removedEntry) {
          const previousIndex = result.previousEntryIds.indexOf(groupId);
          const nextIndex = Math.min(Math.max(previousIndex, 0), result.entryIds.length - 1);
          setSelectedEntryId(nextIndex >= 0 ? result.entryIds[nextIndex] : null);
          setZoomOpen(false);
        }
        const deletedAnnotation = result.deletedSteps.find((deleted) => deleted.id === step.id);
        if (!deletedAnnotation) throw new Error(t().editor.mutations.deleteAnnotation.restoreDataMissing);
        const restoredIndex = result.previousAnnotationIds.indexOf(step.id);
        return {
          message: t().editor.mutations.deleteAnnotation.done((restoredIndex >= 0 ? restoredIndex : annotationIndex) + 1),
          expectedRevision: result.project.contentRevision,
          restoreSelectionId: groupId,
          restore: result.removedEntry
            ? () => restoreProjectEntriesAtomically(
                projectId,
                result.deletedSteps,
                result.previousEntryIds,
                result.previousSections,
                result.project.contentRevision,
              ).then(() => undefined)
            : () => restoreProjectAnnotationAtomically(
                projectId,
                groupId,
                deletedAnnotation,
                result.previousAnnotationIds,
                result.project.contentRevision,
              ).then(() => undefined),
        };
      },
    });
  }

  async function setEntriesNumbered(entryIdsToUpdate: readonly string[], numbered: boolean) {
    if (entryIdsToUpdate.length === 0) return;
    await runProjectMutation({
      operation: 'numbering',
      rethrow: true,
      mutate: async (snapshot, projectId) => {
        const selectedIds = new Set(entryIdsToUpdate);
        const previousValues = new Set(
          snapshot.entries
            .filter((entry): entry is Extract<StepEntry, { kind: 'group' }> => (
              entry.kind === 'group' && selectedIds.has(entry.anchor.id)
            ))
            .map((entry) => entry.anchor.numbered ?? false),
        );
        const result = await setProjectEntriesNumberedAtomically(
          projectId,
          entryIdsToUpdate,
          numbered,
          snapshot.project.contentRevision,
        );
        adoptProject(result.project);
        // A mixed selection has no single value to restore, and a no-op change has nothing to undo.
        const previousValue = previousValues.size === 1 ? [...previousValues][0] : undefined;
        if (result.affectedEntryIds.length === 0 || previousValue === undefined || previousValue === numbered) return;
        return {
          message: t().editor.mutations.numbering.done(numbered),
          expectedRevision: result.project.contentRevision,
          restoreSelectionId: selectedEntryId ?? undefined,
          restore: () => setProjectEntriesNumberedAtomically(
            projectId,
            result.affectedEntryIds,
            previousValue,
            result.project.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function addSection(startEntryId: string, title: string) {
    await runProjectMutation({
      operation: 'addSection',
      rethrow: true,
      mutate: async (snapshot, projectId) => {
        const result = await addProjectSectionAtomically(
          projectId,
          startEntryId,
          title,
          snapshot.project.contentRevision,
        );
        adoptProject(result.project);
        const added = result.project.sections.find((section) => section.startEntryId === startEntryId);
        if (!added) return;
        return {
          message: t().editor.mutations.addSection.done(added.title),
          expectedRevision: result.project.contentRevision,
          restore: () => deleteProjectSectionAtomically(
            projectId,
            added.id,
            result.project.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function renameSection(sectionId: string, title: string) {
    await runProjectMutation({
      operation: 'renameSection',
      rethrow: true,
      mutate: async (snapshot, projectId) => {
        const result = await renameProjectSectionAtomically(
          projectId,
          sectionId,
          title,
          snapshot.project.contentRevision,
        );
        adoptProject(result.project);
      },
    });
  }

  async function deleteSection(sectionId: string) {
    await runProjectMutation({
      operation: 'deleteSection',
      rethrow: true,
      mutate: async (snapshot, projectId) => {
        const deletedSection = snapshot.project.sections.find((section) => section.id === sectionId);
        const result = await deleteProjectSectionAtomically(
          projectId,
          sectionId,
          snapshot.project.contentRevision,
        );
        adoptProject(result.project);
        if (!deletedSection) return;
        // A section's display position derives from its start entry, so re-creating it with the
        // same start entry and title puts it back exactly where it was.
        return {
          message: t().editor.mutations.deleteSection.done(deletedSection.title),
          expectedRevision: result.project.contentRevision,
          restore: () => addProjectSectionAtomically(
            projectId,
            deletedSection.startEntryId,
            deletedSection.title,
            result.project.contentRevision,
          ).then(() => undefined),
        };
      },
    });
  }

  async function handleUndo() {
    if (!undoAction || !beginDataOperation(t().editor.undo.inProgress)) return;
    setOperationError(null);
    try {
      const snapshot = await getProjectStructureSnapshot(undoAction.projectId);
      if (snapshot.project.contentRevision !== undoAction.expectedRevision) {
        throw new ProjectContentConflictError(
          undoAction.projectId,
          undoAction.expectedRevision,
          snapshot.project.contentRevision,
        );
      }
      await undoAction.restore();
      // Cleared before the reload moves the revision, so the spent undo isn't announced as "now final".
      clearUndo();
      await refreshEditorData();
      if (undoAction.restoreSelectionId) {
        setSelectedEntryId(undoAction.restoreSelectionId);
      }
    } catch (undoError) {
      console.error('[stepmark] failed to undo editor operation', undoError);
      clearUndo();
      setOperationError(
        undoError instanceof ProjectContentConflictError
          ? t().editor.undo.conflict
          : t().editor.undo.failed,
      );
      await refreshEditorData().catch((refreshError) => console.error('[stepmark] reload after failed undo failed', refreshError));
    } finally {
      endDataOperation();
    }
  }

  return {
    handleReorderEntries,
    handleReorderAnnotations,
    deleteEntry,
    handleDeleteAnnotation,
    setEntriesNumbered,
    addSection,
    renameSection,
    deleteSection,
    handleUndo,
  };
}

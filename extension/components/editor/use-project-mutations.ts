import type { Dispatch, SetStateAction } from 'react';
import {
  equalIds,
  type OptimisticChange,
  type PendingUndoAction,
  type UndoAction,
} from '@/lib/editor/editor-app-model';
import { addProjectSectionAtomically, deleteProjectAnnotationAtomically, deleteProjectEntriesAtomically, deleteProjectSectionAtomically, getProjectStructureSnapshot, ProjectContentConflictError, renameProjectSectionAtomically, reorderProjectAnnotationsAtomically, reorderProjectEntriesAtomically, restoreProjectAnnotationAtomically, restoreProjectEntriesAtomically, setProjectEntriesNumberedAtomically, type ProjectStructureMutationResult, type ProjectStructureSnapshot } from '@/lib/storage/project-structure';
import { entryId, type Project, type Step, type StepEntry } from '@/lib/storage/models';
import { sectionsInRows, type ProjectSection, type RailRow } from '@/lib/project/project-sections';
import { t, type Messages } from '@/lib/shared/i18n';

/** A structural edit with its own progress/failure copy in the i18n catalog. */
type ProjectMutationOperation = Exclude<keyof Messages['editor']['mutations'], 'conflict'>;

type GroupEntry = Extract<StepEntry, { kind: 'group' }>;

interface UseProjectMutationsOptions {
  sessionId: string | null;
  project: Project | null;
  /** The rendered (optimistic-first) entry list. */
  entries: StepEntry[];
  /** The rendered (optimistic-first) sections. */
  sections: readonly ProjectSection[];
  selectedEntryId: string | null;
  /** Queues `operation` behind every data operation asked for before it. */
  runOperation: <T>(label: string | null, operation: () => Promise<T>) => Promise<T>;
  /** True while the Project can't be changed at all (deleted, being recorded, or in a permission flow). */
  editingBlocked: () => boolean;
  /** Shows `change` on top of the stored entries; the returned function takes it back. */
  showOptimistic: (change: OptimisticChange) => () => void;
  flushDescriptions: () => Promise<void>;
  /** Shows the structure a write just committed. */
  adoptCommitted: (result: ProjectStructureMutationResult) => void;
  requireSelectedEntry: (expectedEntryId?: string) => StepEntry;
  setSelectedEntryId: Dispatch<SetStateAction<string | null>>;
  setZoomOpen: (open: boolean) => void;
  setOperationError: (message: string | null) => void;
  /** The undo on screen. */
  undoAction: UndoAction | null;
  /** The undo that can be used right now. */
  offeredUndo: () => UndoAction | null;
  offerUndo: (pending: PendingUndoAction, projectId: string, superseded?: UndoAction | null) => void;
  takeUndo: () => UndoAction | null;
  returnUndo: (taken: UndoAction | null) => void;
  finalizeUndo: (taken: UndoAction | null) => void;
  clearUndo: () => void;
}

/** Puts items in the order of `ids`; items it doesn't name keep their relative place at the end. */
function inOrder<T>(ids: readonly string[], idOf: (item: T) => string): (items: T[]) => T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return (items) => [...items].sort((left, right) => (rank.get(idOf(left)) ?? ids.length) - (rank.get(idOf(right)) ?? ids.length));
}

/**
 * The editor's structural mutations. Each shows its result at once where it can
 * (an optimistic change over the stored entries), then takes its turn in the
 * operation queue: flush pending descriptions, read a fresh snapshot,
 * compare-and-swap against its revision, show the committed structure and offer
 * an undo. Its optimistic change goes away when it settles, whichever way.
 */
export function useProjectMutations({
  sessionId,
  project,
  entries,
  sections,
  selectedEntryId,
  runOperation,
  editingBlocked,
  showOptimistic,
  flushDescriptions,
  adoptCommitted,
  requireSelectedEntry,
  setSelectedEntryId,
  setZoomOpen,
  setOperationError,
  undoAction,
  offeredUndo,
  offerUndo,
  takeUndo,
  returnUndo,
  finalizeUndo,
  clearUndo,
}: UseProjectMutationsOptions) {
  function showStructureMutationError(operation: ProjectMutationOperation, mutationError: unknown): void {
    console.error(`[howbeam] project mutation failed: ${operation}`, mutationError);
    setOperationError(
      mutationError instanceof ProjectContentConflictError
        ? t().editor.mutations.conflict
        : t().editor.mutations[operation].failed,
    );
  }

  /**
   * Shared queue/flush/error contract for every structural edit; only `mutate` (the compare-and-swap
   * step) differs per operation. `optimistic` is shown from the click until the mutation settles, and
   * `atClick` runs with it (the selection). Whether editing is allowed is decided at the click; once
   * queued, an edit runs, and storage's revision check refuses it if the Project moved meanwhile.
   * `rethrow` is for callers that keep their own failure state open (the section dialog).
   */
  async function runProjectMutation({
    operation,
    optimistic,
    atClick,
    rethrow = false,
    mutate,
  }: {
    /** Names the operation's progress and failure copy in the i18n catalog. */
    operation: ProjectMutationOperation;
    optimistic?: OptimisticChange;
    atClick?: () => void;
    rethrow?: boolean;
    mutate: (snapshot: ProjectStructureSnapshot, projectId: string) => Promise<PendingUndoAction | void>;
  }): Promise<void> {
    if (!sessionId || editingBlocked()) return;
    const hideOptimistic = optimistic && showOptimistic(optimistic);
    atClick?.();
    await runOperation(t().editor.mutations[operation].pending, async () => {
      // Only one undo is offered at a time: this mutation either replaces the pending one
      // (and says it is now final), makes it final without a replacement, or hands it back on failure.
      const takenUndo = takeUndo();
      setOperationError(null);
      try {
        let undo: PendingUndoAction | void;
        try {
          await flushDescriptions();
          const snapshot = await getProjectStructureSnapshot(sessionId);
          undo = await mutate(snapshot, sessionId);
        } catch (mutationError) {
          showStructureMutationError(operation, mutationError);
          returnUndo(takenUndo);
          if (rethrow) throw mutationError;
          return;
        }
        if (undo) offerUndo(undo, sessionId, takenUndo);
        else finalizeUndo(takenUndo);
      } finally {
        // On success the committed structure is already shown, so taking this back changes nothing on screen.
        hideOptimistic?.();
      }
    });
  }

  /** Moves the selection from an entry that is going away to the one that takes
   * its place, unless the selection already moved elsewhere. */
  function selectInsteadOf(removedId: string, previousEntryIds: readonly string[], nextEntryIds: readonly string[]) {
    const previousIndex = previousEntryIds.indexOf(removedId);
    const nextIndex = Math.min(Math.max(previousIndex, 0), nextEntryIds.length - 1);
    const next = nextIndex >= 0 ? nextEntryIds[nextIndex] : null;
    setSelectedEntryId((current) => (current === removedId ? next : current));
    setZoomOpen(false);
  }

  /** `rows` is the rail after a drop: entries in their new order, each section heading where it was left. */
  async function handleReorderEntries(rows: readonly RailRow[]) {
    if (!project) return;
    const previousEntryIds = entries.map(entryId);
    const previousSectionIds = sections.map((section) => section.id).sort();
    const nextEntryIds = rows.flatMap((row) => (row.kind === 'entry' ? [row.id] : []));
    const expectedRevision = project.contentRevision;
    await runProjectMutation({
      operation: 'reorderSteps',
      optimistic: (shown) => ({
        entries: inOrder(nextEntryIds, entryId)(shown.entries),
        sections: sectionsInRows(shown.sections, rows),
      }),
      mutate: async (snapshot, projectId) => {
        if (
          !equalIds(snapshot.entryIds, previousEntryIds)
          || !equalIds(snapshot.project.sections.map((section) => section.id).sort(), previousSectionIds)
        ) {
          throw new ProjectContentConflictError(projectId, expectedRevision, snapshot.project.contentRevision);
        }
        const result = await reorderProjectEntriesAtomically(
          projectId,
          nextEntryIds,
          // Titles come from the snapshot, so a rename queued before this drop is kept.
          sectionsInRows(snapshot.project.sections, rows),
          snapshot.project.contentRevision,
        );
        adoptCommitted(result);
        return {
          message: t().editor.mutations.reorderSteps.done,
          expectedRevision: result.project.contentRevision,
          restore: () => reorderProjectEntriesAtomically(
            projectId,
            result.previousEntryIds,
            result.previousSections,
            result.project.contentRevision,
          ),
        };
      },
    });
  }

  async function handleReorderAnnotations(anchorId: string, reordered: Step[]) {
    requireSelectedEntry(anchorId);
    const previousGroup = entries.find(
      (entry): entry is GroupEntry => entry.kind === 'group' && entry.anchor.id === anchorId,
    );
    if (!previousGroup) throw new Error(t().editor.mutations.reorderAnnotations.groupMissing);
    const previousAnnotationIds = previousGroup.annotations.map((annotation) => annotation.id);
    await runProjectMutation({
      operation: 'reorderAnnotations',
      optimistic: (shown) => {
        const order = inOrder(reordered.map((annotation) => annotation.id), (annotation: Step) => annotation.id);
        return {
          ...shown,
          entries: shown.entries.map((entry) => (
            entry.kind === 'group' && entry.anchor.id === anchorId ? { ...entry, annotations: order(entry.annotations) } : entry
          )),
        };
      },
      mutate: async (snapshot, projectId) => {
        const freshGroup = snapshot.entries.find(
          (entry): entry is GroupEntry => entry.kind === 'group' && entry.anchor.id === anchorId,
        );
        if (!freshGroup || !equalIds(freshGroup.annotations.map((annotation) => annotation.id), previousAnnotationIds)) {
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
        adoptCommitted(result);
        return {
          message: t().editor.mutations.reorderAnnotations.done,
          expectedRevision: result.project.contentRevision,
          restoreSelectionId: anchorId,
          restore: () => reorderProjectAnnotationsAtomically(
            projectId,
            anchorId,
            result.previousAnnotationIds,
            result.project.contentRevision,
          ),
        };
      },
    });
  }

  async function deleteEntry() {
    const currentEntryId = entryId(requireSelectedEntry());
    await runProjectMutation({
      operation: 'deleteStep',
      mutate: async (snapshot, projectId) => {
        const deletingEntry = snapshot.entries.find((entry) => entryId(entry) === currentEntryId);
        if (!deletingEntry) throw new Error(t().editor.mutations.deleteStep.changed);
        const deletingIndex = snapshot.entryIds.indexOf(currentEntryId);
        const result = await deleteProjectEntriesAtomically(
          projectId,
          [currentEntryId],
          snapshot.project.contentRevision,
        );
        adoptCommitted(result);
        selectInsteadOf(currentEntryId, snapshot.entryIds, result.entryIds);
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
          ),
        };
      },
    });
  }

  async function handleDeleteAnnotation(step: Step) {
    const currentEntry = requireSelectedEntry(step.groupId);
    if (currentEntry.kind !== 'group') throw new Error(t().editor.mutations.deleteAnnotation.notSnapshot);
    const groupId = step.groupId;
    if (!groupId) return;
    const annotationIndex = currentEntry.annotations.findIndex((annotation) => annotation.id === step.id);
    const withoutMarker = (shown: StepEntry[]) => shown.flatMap((entry) => {
      if (entry.kind !== 'group' || entry.anchor.id !== groupId) return [entry];
      const remaining = entry.annotations.filter((annotation) => annotation.id !== step.id);
      return remaining.length === 0 ? [] : [{ ...entry, annotations: remaining }];
    });
    await runProjectMutation({
      operation: 'deleteAnnotation',
      optimistic: (shown) => ({ ...shown, entries: withoutMarker(shown.entries) }),
      // Deleting a snapshot's last marker takes the snapshot off the list at once, so the selection moves with it.
      atClick: () => {
        const after = withoutMarker(entries);
        if (after.length < entries.length) selectInsteadOf(groupId, entries.map(entryId), after.map(entryId));
      },
      mutate: async (snapshot, projectId) => {
        const result = await deleteProjectAnnotationAtomically(
          projectId,
          groupId,
          step.id,
          snapshot.project.contentRevision,
        );
        adoptCommitted(result);
        if (result.removedEntry) selectInsteadOf(groupId, result.previousEntryIds, result.entryIds);
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
              )
            : () => restoreProjectAnnotationAtomically(
                projectId,
                groupId,
                deletedAnnotation,
                result.previousAnnotationIds,
                result.project.contentRevision,
              ),
        };
      },
    });
  }

  async function setEntriesNumbered(entryIdsToUpdate: readonly string[], numbered: boolean) {
    if (entryIdsToUpdate.length === 0) return;
    const selectedIds = new Set(entryIdsToUpdate);
    await runProjectMutation({
      operation: 'numbering',
      optimistic: (shown) => ({
        ...shown,
        entries: shown.entries.map((entry) => (
          entry.kind === 'group' && selectedIds.has(entry.anchor.id)
            ? { ...entry, anchor: { ...entry.anchor, numbered } }
            : entry
        )),
      }),
      mutate: async (snapshot, projectId) => {
        const previousValues = new Set(
          snapshot.entries
            .filter((entry): entry is GroupEntry => entry.kind === 'group' && selectedIds.has(entry.anchor.id))
            .map((entry) => entry.anchor.numbered ?? false),
        );
        const result = await setProjectEntriesNumberedAtomically(
          projectId,
          entryIdsToUpdate,
          numbered,
          snapshot.project.contentRevision,
        );
        adoptCommitted(result);
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
          ),
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
        adoptCommitted(result);
        const added = result.project.sections.find((section) => section.startEntryId === startEntryId);
        if (!added) return;
        return {
          message: t().editor.mutations.addSection.done(added.title),
          expectedRevision: result.project.contentRevision,
          restore: () => deleteProjectSectionAtomically(
            projectId,
            added.id,
            result.project.contentRevision,
          ),
        };
      },
    });
  }

  async function renameSection(sectionId: string, title: string) {
    await runProjectMutation({
      operation: 'renameSection',
      rethrow: true,
      mutate: async (snapshot, projectId) => {
        adoptCommitted(await renameProjectSectionAtomically(
          projectId,
          sectionId,
          title,
          snapshot.project.contentRevision,
        ));
      },
    });
  }

  async function deleteSection(sectionId: string) {
    await runProjectMutation({
      operation: 'deleteSection',
      mutate: async (snapshot, projectId) => {
        const deletedSection = snapshot.project.sections.find((section) => section.id === sectionId);
        const result = await deleteProjectSectionAtomically(
          projectId,
          sectionId,
          snapshot.project.contentRevision,
        );
        adoptCommitted(result);
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
          ),
        };
      },
    });
  }

  async function handleUndo() {
    const clicked = undoAction;
    if (!clicked || editingBlocked()) return;
    // The undo notice shows its own progress.
    await runOperation(null, async () => {
      // An edit queued before this click may have replaced that undo, and a second click finds it used:
      // only the undo still offered when this turn comes is acted on.
      const action = offeredUndo();
      if (!action || action.id !== clicked.id) return;
      setOperationError(null);
      try {
        const snapshot = await getProjectStructureSnapshot(action.projectId);
        if (snapshot.project.contentRevision !== action.expectedRevision) {
          throw new ProjectContentConflictError(
            action.projectId,
            action.expectedRevision,
            snapshot.project.contentRevision,
          );
        }
        const result = await action.restore();
        // Cleared before the restored structure moves the revision, so the spent undo isn't announced as "now final".
        clearUndo();
        adoptCommitted(result);
        if (action.restoreSelectionId) setSelectedEntryId(action.restoreSelectionId);
      } catch (undoError) {
        console.error('[howbeam] failed to undo editor operation', undoError);
        clearUndo();
        setOperationError(
          undoError instanceof ProjectContentConflictError
            ? t().editor.undo.conflict
            : t().editor.undo.failed,
        );
      }
    });
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

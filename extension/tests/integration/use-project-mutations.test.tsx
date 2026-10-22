// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProjectStructureSnapshot: vi.fn(),
  reorderProjectEntriesAtomically: vi.fn(),
}));

vi.mock('@/lib/storage/project-structure', () => {
  class ProjectContentConflictError extends Error {
    constructor(
      public readonly projectId: string,
      public readonly expectedRevision: number,
      public readonly actualRevision: number,
    ) {
      super('Project content changed before the operation was committed.');
      this.name = 'ProjectContentConflictError';
    }
  }
  return {
    ProjectContentConflictError,
    getProjectStructureSnapshot: mocks.getProjectStructureSnapshot,
    reorderProjectEntriesAtomically: mocks.reorderProjectEntriesAtomically,
    addProjectSectionAtomically: vi.fn(),
    deleteProjectAnnotationAtomically: vi.fn(),
    deleteProjectEntriesAtomically: vi.fn(),
    deleteProjectSectionAtomically: vi.fn(),
    renameProjectSectionAtomically: vi.fn(),
    reorderProjectAnnotationsAtomically: vi.fn(),
    restoreProjectAnnotationAtomically: vi.fn(),
    restoreProjectEntriesAtomically: vi.fn(),
    setProjectEntriesNumberedAtomically: vi.fn(),
  };
});

import { useProjectMutations } from '@/components/editor/use-project-mutations';

const singleEntry = (id: string) => ({ kind: 'single', step: { id } }) as never;
const entries = [singleEntry('s1'), singleEntry('s2')];
const reordered = [entries[1], entries[0]];
const project = { id: 'g1', contentRevision: 1, sections: [] } as never;

function renderMutations(overrides: Record<string, unknown> = {}) {
  const options = {
    sessionId: 'g1',
    project,
    entries,
    selectedEntryId: null,
    runOperation: vi.fn((_label: string | null, operation: () => Promise<unknown>) => operation()),
    editingBlocked: vi.fn(() => false),
    // Each optimistic change shown returns its own way of taking it back.
    showOptimistic: vi.fn(() => vi.fn()),
    flushDescriptions: vi.fn().mockResolvedValue(undefined),
    adoptCommitted: vi.fn(),
    requireSelectedEntry: vi.fn(),
    setSelectedEntryId: vi.fn(),
    setZoomOpen: vi.fn(),
    setOperationError: vi.fn(),
    undoAction: null,
    offeredUndo: vi.fn(() => null),
    offerUndo: vi.fn(),
    takeUndo: vi.fn(() => null),
    returnUndo: vi.fn(),
    finalizeUndo: vi.fn(),
    clearUndo: vi.fn(),
    ...overrides,
  };
  const { result } = renderHook(() => useProjectMutations(options as never));
  return { result, options };
}

const committed = { project: { contentRevision: 2 }, entries: reordered, entryIds: ['s2', 's1'], previousEntryIds: ['s1', 's2'] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.getProjectStructureSnapshot.mockResolvedValue({
    project: { contentRevision: 1, sections: [] },
    entryIds: ['s1', 's2'],
    entries,
  });
  mocks.reorderProjectEntriesAtomically.mockResolvedValue(committed);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The optimistic change a mutation showed, applied to `shown`, and the spy that takes it back. */
function shownChange(options: ReturnType<typeof renderMutations>['options'], call = 0) {
  const [change] = options.showOptimistic.mock.calls[call] as unknown as [(entries: unknown[]) => unknown[]];
  const hide = options.showOptimistic.mock.results[call].value as ReturnType<typeof vi.fn>;
  return { change, hide };
}

describe('runProjectMutation (via handleReorderEntries)', () => {
  it('shows the result at the click, commits in the queue, then takes the optimistic change back', async () => {
    const { result, options } = renderMutations();

    await act(() => result.current.handleReorderEntries(reordered));

    const { change, hide } = shownChange(options);
    expect(change(entries)).toEqual(reordered);
    expect(options.runOperation).toHaveBeenCalledWith('正在儲存步驟順序…', expect.any(Function));
    expect(options.adoptCommitted).toHaveBeenCalledWith(committed);
    // Taken back only once the commit is on screen, so nothing reverts in between.
    expect(hide).toHaveBeenCalledOnce();
    expect(options.adoptCommitted.mock.invocationCallOrder[0]).toBeLessThan(hide.mock.invocationCallOrder[0]);
    expect(options.offerUndo).toHaveBeenCalledTimes(1);
    expect(options.setOperationError).not.toHaveBeenCalledWith(expect.stringContaining('失敗'));
  });

  it('takes back only its own optimistic change and reports the failure when the commit fails', async () => {
    mocks.reorderProjectEntriesAtomically.mockRejectedValue(new Error('cas boom'));
    const { result, options } = renderMutations();

    await act(() => result.current.handleReorderEntries(reordered));

    expect(shownChange(options).hide).toHaveBeenCalledOnce();
    expect(options.setOperationError).toHaveBeenLastCalledWith('步驟排序失敗，已重新載入目前資料。');
    expect(options.adoptCommitted).not.toHaveBeenCalled();
    expect(options.offerUndo).not.toHaveBeenCalled();
  });

  it('applies its change on top of whatever is shown when its change is replayed', async () => {
    const { result, options } = renderMutations();

    await act(() => result.current.handleReorderEntries(reordered));

    // A later read can bring a third entry; the reorder still puts the two it named in its order.
    const third = singleEntry('s3');
    expect(shownChange(options).change([entries[0], third, entries[1]])).toEqual([entries[1], entries[0], third]);
  });

  it('changes nothing while the Project cannot be edited', async () => {
    const { result, options } = renderMutations({ editingBlocked: vi.fn(() => true) });

    await act(() => result.current.handleReorderEntries(reordered));

    expect(options.showOptimistic).not.toHaveBeenCalled();
    expect(options.runOperation).not.toHaveBeenCalled();
  });
});

describe('deleting a snapshot’s last marker', () => {
  it('moves the selection to the next entry at the click, as the snapshot leaves the list', async () => {
    const marker = { id: 'm1', groupId: 'g' };
    const group = { kind: 'group', anchor: { id: 'g' }, annotations: [marker] } as never;
    const shown = [singleEntry('s1'), group, singleEntry('s2')];
    let selected: string | null = 'g';
    const setSelectedEntryId = vi.fn((next: string | null | ((current: string | null) => string | null)) => {
      selected = typeof next === 'function' ? next(selected) : next;
    });
    let selectedWhenQueued: string | null = null;
    const runOperation = vi.fn(async () => {
      selectedWhenQueued = selected;
    });
    const { result, options } = renderMutations({
      entries: shown,
      requireSelectedEntry: vi.fn(() => group),
      setSelectedEntryId,
      runOperation,
    });

    await act(() => result.current.handleDeleteAnnotation(marker as never));

    expect(shownChange(options).change(shown)).toEqual([shown[0], shown[2]]);
    expect(selectedWhenQueued).toBe('s2');
  });
});

describe('undo', () => {
  const offered = { id: 4, message: '已排序步驟', projectId: 'g1', expectedRevision: 1, restore: vi.fn() };

  it('restores the undo still offered when its turn comes, and shows what the restore committed', async () => {
    const restored = { project: { contentRevision: 2 }, entries, entryIds: ['s1', 's2'] };
    offered.restore.mockResolvedValue(restored);
    const { result, options } = renderMutations({ undoAction: offered, offeredUndo: vi.fn(() => offered) });

    await act(() => result.current.handleUndo());

    expect(offered.restore).toHaveBeenCalledOnce();
    expect(options.clearUndo).toHaveBeenCalledOnce();
    expect(options.adoptCommitted).toHaveBeenCalledWith(restored);
  });

  it('does nothing when an edit queued before the click replaced that undo, or a second click finds it used', async () => {
    const replaced = { ...offered, id: 5 };
    const { result, options } = renderMutations({ undoAction: offered, offeredUndo: vi.fn(() => replaced) });

    await act(() => result.current.handleUndo());
    expect(offered.restore).not.toHaveBeenCalled();

    options.offeredUndo.mockReturnValue(null);
    await act(() => result.current.handleUndo());
    expect(offered.restore).not.toHaveBeenCalled();
    expect(options.setOperationError).not.toHaveBeenCalled();
    expect(options.clearUndo).not.toHaveBeenCalled();
  });
});

describe('a pending undo when another mutation runs (single-level undo)', () => {
  const earlier = { id: 1, message: '已刪除步驟 3', projectId: 'g1', expectedRevision: 1, restore: vi.fn() };

  it('hands the earlier undo to the new one, which says it is now final', async () => {
    const { result, options } = renderMutations({ takeUndo: vi.fn(() => earlier) });

    await act(() => result.current.handleReorderEntries(reordered));

    expect(options.offerUndo).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2 }), 'g1', earlier);
    expect(options.finalizeUndo).not.toHaveBeenCalled();
    expect(options.returnUndo).not.toHaveBeenCalled();
  });

  it('announces the earlier undo as final when the new mutation offers none', async () => {
    const renameProjectSectionAtomically = (await import('@/lib/storage/project-structure')).renameProjectSectionAtomically as ReturnType<typeof vi.fn>;
    renameProjectSectionAtomically.mockResolvedValue({ project: { contentRevision: 2 }, entries, entryIds: ['s1', 's2'] });
    const { result, options } = renderMutations({ takeUndo: vi.fn(() => earlier) });

    await act(() => result.current.renameSection('section-1', '新名稱'));

    expect(options.offerUndo).not.toHaveBeenCalled();
    expect(options.finalizeUndo).toHaveBeenCalledWith(earlier);
  });

  it('hands the earlier undo back when the new mutation failed', async () => {
    mocks.reorderProjectEntriesAtomically.mockRejectedValue(new Error('cas boom'));
    const { result, options } = renderMutations({ takeUndo: vi.fn(() => earlier) });

    await act(() => result.current.handleReorderEntries(reordered));

    expect(options.returnUndo).toHaveBeenCalledWith(earlier);
    expect(options.finalizeUndo).not.toHaveBeenCalled();
  });
});

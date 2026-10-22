// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectNotFoundError } from '@/lib/storage/database';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getProjectStructureSnapshot: vi.fn(),
  listeners: new Set<() => void>(),
}));

vi.mock('@/lib/storage/project-repository', () => ({ getProject: mocks.getProject }));
vi.mock('@/lib/storage/project-structure', () => ({
  getProjectStructureSnapshot: mocks.getProjectStructureSnapshot,
  repairEmptySnapshotAnchors: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/storage/storage', () => ({ getRecordingState: vi.fn().mockResolvedValue({ isRecording: false }) }));
vi.mock('@/lib/storage/change-notifier', () => ({
  subscribeProjectsChanged: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));

import { useEditorProjectData } from '@/lib/editor/use-editor-project-data';
import type { Project, StepEntry } from '@/lib/storage/models';
import type { ProjectStructureMutationResult } from '@/lib/storage/project-structure';

const loaded = {
  id: 'p1', title: '原標題', description: '', sections: [],
  createdAt: 1, updatedAt: 1, contentRevision: 5, stepEditRevision: 0, metadataRevision: 2, stepCount: 0, entryCount: 0, storageBytes: 0,
} satisfies Project;

const entry = (id: string) => ({ kind: 'single', step: { id, screenshotBlob: new Blob(['x']) } }) as unknown as StepEntry;
const snapshotOf = (project: Project, ids: string[]) => ({ project, entries: ids.map(entry), entryIds: ids });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function somethingWrote() {
  await act(async () => {
    for (const listener of mocks.listeners) listener();
    await Promise.resolve();
  });
}

async function openProject() {
  const view = renderHook(() => useEditorProjectData('p1'));
  await waitFor(() => expect(view.result.current.projectLoadState).toBe('ready'));
  return view;
}

beforeEach(() => {
  mocks.listeners.clear();
  mocks.getProject.mockReset();
  mocks.getProjectStructureSnapshot.mockReset();
  mocks.getProjectStructureSnapshot.mockResolvedValue(snapshotOf(loaded, ['a']));
  // The row as the last write left it; tests that write move its revisions.
  mocks.getProject.mockResolvedValue(loaded);
});

describe('useEditorProjectData', () => {
  it('reads the structure again after a write that moved the Project', async () => {
    const { result } = await openProject();

    const moved = { ...loaded, contentRevision: 6 };
    mocks.getProject.mockResolvedValue(moved);
    mocks.getProjectStructureSnapshot.mockResolvedValue(snapshotOf(moved, ['a', 'b']));
    await somethingWrote();

    await waitFor(() => expect(result.current.canonicalSnapshot?.entryIds).toEqual(['a', 'b']));
    expect(result.current.project?.contentRevision).toBe(6);
  });

  it('skips the structure read when a write left this Project as it is shown', async () => {
    await openProject();
    mocks.getProjectStructureSnapshot.mockClear();

    await somethingWrote();

    await waitFor(() => expect(mocks.getProject).toHaveBeenCalled());
    expect(mocks.getProjectStructureSnapshot).not.toHaveBeenCalled();
  });

  it('takes a title another tab saved straight from the row', async () => {
    const { result } = await openProject();
    mocks.getProjectStructureSnapshot.mockClear();

    mocks.getProject.mockResolvedValue({ ...loaded, title: '新標題', metadataRevision: 3 });
    await somethingWrote();

    await waitFor(() => expect(result.current.project?.title).toBe('新標題'));
    expect(mocks.getProjectStructureSnapshot).not.toHaveBeenCalled();
  });

  it('folds writes that arrive during a read into one more read', async () => {
    await openProject();
    mocks.getProject.mockResolvedValue({ ...loaded, contentRevision: 6 });
    const pending = deferred<ReturnType<typeof snapshotOf>>();
    mocks.getProjectStructureSnapshot.mockClear();
    mocks.getProjectStructureSnapshot.mockReturnValueOnce(pending.promise);

    await somethingWrote();
    await somethingWrote();
    await somethingWrote();
    await waitFor(() => expect(mocks.getProjectStructureSnapshot).toHaveBeenCalledTimes(1));

    mocks.getProjectStructureSnapshot.mockResolvedValue(snapshotOf({ ...loaded, contentRevision: 6 }, ['a']));
    await act(async () => {
      pending.resolve(snapshotOf({ ...loaded, contentRevision: 6 }, ['a']));
      await pending.promise;
    });
    await waitFor(() => expect(mocks.getProjectStructureSnapshot).toHaveBeenCalledTimes(1));
    // The folded read found the row matching what was just shown, so it stopped at the row.
    expect(mocks.getProject.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never puts back a structure from before a commit it was handed', async () => {
    const { result } = await openProject();
    const stale = deferred<ReturnType<typeof snapshotOf>>();
    mocks.getProject.mockResolvedValue({ ...loaded, contentRevision: 6 });
    mocks.getProjectStructureSnapshot.mockReturnValueOnce(stale.promise);
    await somethingWrote();
    await waitFor(() => expect(mocks.getProjectStructureSnapshot).toHaveBeenCalledTimes(2));

    const committed = { ...snapshotOf({ ...loaded, contentRevision: 7 }, ['b']), affectedEntryIds: [] } as ProjectStructureMutationResult;
    act(() => result.current.adoptCommitted(committed));
    expect(result.current.canonicalSnapshot?.entryIds).toEqual(['b']);

    await act(async () => {
      stale.resolve(snapshotOf({ ...loaded, contentRevision: 6 }, ['a']));
      await stale.promise;
    });
    expect(result.current.canonicalSnapshot?.entryIds).toEqual(['b']);
  });

  it('takes only the metadata from a row a title edit returned', async () => {
    const { result } = await openProject();

    // The row already counts a structural write from another tab that this page hasn't read yet.
    act(() => result.current.adoptProject({ ...loaded, title: '新標題', metadataRevision: 3, contentRevision: 9 }));

    expect(result.current.project).toMatchObject({ title: '新標題', metadataRevision: 3, contentRevision: 5 });
    mocks.getProject.mockResolvedValue({ ...loaded, title: '新標題', metadataRevision: 3, contentRevision: 9 });
    mocks.getProjectStructureSnapshot.mockResolvedValue(snapshotOf({ ...loaded, title: '新標題', metadataRevision: 3, contentRevision: 9 }, ['a', 'c']));
    await somethingWrote();
    await waitFor(() => expect(result.current.canonicalSnapshot?.entryIds).toEqual(['a', 'c']));
  });

  it('keeps a Project deleted elsewhere on screen, read-only', async () => {
    const { result } = await openProject();

    mocks.getProject.mockResolvedValue(undefined);
    mocks.getProjectStructureSnapshot.mockRejectedValue(new ProjectNotFoundError('p1'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await somethingWrote();

    await waitFor(() => expect(result.current.projectDeleted).toBe(true));
    expect(result.current.project?.title).toBe('原標題');
    expect(result.current.projectLoadState).toBe('ready');
  });

  it('keeps what is shown when a later read fails for another reason', async () => {
    const { result } = await openProject();

    mocks.getProject.mockResolvedValue({ ...loaded, contentRevision: 6 });
    mocks.getProjectStructureSnapshot.mockRejectedValue(new Error('busy'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await somethingWrote();

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(result.current.projectLoadState).toBe('ready');
    expect(result.current.canonicalSnapshot?.entryIds).toEqual(['a']);
    expect(result.current.projectDeleted).toBe(false);
  });

  it('reports an unreadable structure as invalid on open while its row still exists', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getProjectStructureSnapshot.mockRejectedValue(new Error('broken'));

    const { result } = renderHook(() => useEditorProjectData('p1'));

    await waitFor(() => expect(result.current.projectLoadState).toBe('invalid'));
    expect(result.current.project?.title).toBe('原標題');
  });
});

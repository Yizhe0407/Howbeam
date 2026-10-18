// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { Project } from '@/lib/storage/models';

const loaded = {
  id: 'p1', title: '原標題', description: '', sections: [], tags: ['甲'],
  createdAt: 1, updatedAt: 1, contentRevision: 5, metadataRevision: 2, stepCount: 0, entryCount: 0, storageBytes: 0,
} satisfies Project;
const steps: unknown[] = [];

async function otherTabWrote() {
  await act(async () => {
    for (const listener of mocks.listeners) listener();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.listeners.clear();
  mocks.getProjectStructureSnapshot.mockResolvedValue({ project: loaded, entries: [], entryIds: [] });
});

describe('useEditorProjectData follows other tabs', () => {
  it('merges metadata another tab changed without adopting its structure revision', async () => {
    const { result } = renderHook(() => useEditorProjectData('p1', steps));
    await waitFor(() => expect(result.current.projectLoadState).toBe('ready'));

    mocks.getProject.mockResolvedValue({ ...loaded, title: '新標題', tags: ['甲', '乙'], contentRevision: 9, metadataRevision: 3 });
    await otherTabWrote();

    await waitFor(() => expect(result.current.project?.title).toBe('新標題'));
    expect(result.current.project).toMatchObject({ tags: ['甲', '乙'], contentRevision: 5, metadataRevision: 3 });
    expect(result.current.projectDeleted).toBe(false);
  });

  it('flags the Project as deleted once its row is gone', async () => {
    const { result } = renderHook(() => useEditorProjectData('p1', steps));
    await waitFor(() => expect(result.current.projectLoadState).toBe('ready'));

    mocks.getProject.mockResolvedValue(undefined);
    await otherTabWrote();

    await waitFor(() => expect(result.current.projectDeleted).toBe(true));
    // What was on screen stays readable; only saving is over.
    expect(result.current.project?.title).toBe('原標題');
  });
});

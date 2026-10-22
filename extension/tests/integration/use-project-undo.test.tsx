// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => vi.fn());
vi.mock('react-hot-toast', () => ({ default: toast }));

import { useProjectUndo } from '@/components/editor/use-project-undo';
import type { Project } from '@/lib/storage/models';

const projectAt = (contentRevision: number) => ({ id: 'p1', contentRevision }) as Project;
const pending = (message: string, expectedRevision: number) => ({ message, expectedRevision, restore: vi.fn() });

function renderUndo(initial: Project | null = projectAt(2)) {
  return renderHook(
    ({ project, projectDeleted }: { project: Project | null; projectDeleted?: boolean }) =>
      useProjectUndo({ project, operationActive: false, projectDeleted }),
    { initialProps: { project: initial } as { project: Project | null; projectDeleted?: boolean } },
  );
}

beforeEach(() => toast.mockClear());

describe('useProjectUndo', () => {
  it('names the undo a newer one replaced, so the earlier deletion is never final silently', () => {
    const { result, rerender } = renderUndo();
    act(() => result.current.offerUndo(pending('已刪除步驟 3', 2), 'p1'));

    let taken = null as ReturnType<typeof result.current.takeUndo>;
    act(() => { taken = result.current.takeUndo(); });
    rerender({ project: projectAt(3) });
    act(() => result.current.offerUndo(pending('已刪除步驟 2', 3), 'p1', taken));

    expect(result.current.undoAction).toMatchObject({ message: '已刪除步驟 2', supersedes: '已刪除步驟 3' });
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps the taken undo on screen until the mutation settles, so the notice updates in place', () => {
    const { result, rerender } = renderUndo();
    act(() => result.current.offerUndo(pending('已刪除步驟 3', 2), 'p1'));

    let taken = null as ReturnType<typeof result.current.takeUndo>;
    act(() => { taken = result.current.takeUndo(); });
    expect(result.current.undoAction).toMatchObject({ message: '已刪除步驟 3' });

    rerender({ project: projectAt(3) });
    expect(result.current.undoAction).toMatchObject({ message: '已刪除步驟 3' });
    expect(toast).not.toHaveBeenCalled();

    act(() => result.current.offerUndo(pending('已刪除步驟 2', 3), 'p1', taken));
    expect(result.current.undoAction).toMatchObject({ message: '已刪除步驟 2' });
  });

  it('takes a handed-back undo off screen when the Project moved past it meanwhile', () => {
    const { result, rerender } = renderUndo();
    act(() => result.current.offerUndo(pending('已刪除步驟 3', 2), 'p1'));
    let taken = null as ReturnType<typeof result.current.takeUndo>;
    act(() => { taken = result.current.takeUndo(); });

    rerender({ project: projectAt(3) });
    act(() => result.current.returnUndo(taken));

    expect(result.current.undoAction).toBeNull();
    expect(toast).toHaveBeenCalledWith('「已刪除步驟 3」已無法還原。');
  });

  it('announces an undo that the Project moved past before its window ended', () => {
    const { result, rerender } = renderUndo();
    act(() => result.current.offerUndo(pending('已刪除步驟 3', 2), 'p1'));

    rerender({ project: projectAt(3) });

    expect(result.current.undoAction).toBeNull();
    expect(toast).toHaveBeenCalledWith('「已刪除步驟 3」已無法還原。');
  });

  it('announces a taken undo that ended without a replacement, and keeps one handed back while still valid', () => {
    const { result } = renderUndo();
    act(() => result.current.offerUndo(pending('已刪除步驟 3', 2), 'p1'));

    let taken = null as ReturnType<typeof result.current.takeUndo>;
    act(() => { taken = result.current.takeUndo(); });
    act(() => result.current.returnUndo(taken));
    expect(result.current.undoAction).toMatchObject({ message: '已刪除步驟 3' });

    act(() => { taken = result.current.takeUndo(); });
    act(() => result.current.finalizeUndo(taken));
    expect(result.current.undoAction).toBeNull();
    expect(toast).toHaveBeenCalledWith('「已刪除步驟 3」已無法還原。');
  });

  it('does not bring back or announce an undo the user closed while a mutation held it', () => {
    const { result } = renderUndo();
    act(() => result.current.offerUndo(pending('已刪除步驟 3', 2), 'p1'));

    let taken = null as ReturnType<typeof result.current.takeUndo>;
    act(() => { taken = result.current.takeUndo(); });
    act(() => result.current.clearUndo());

    act(() => result.current.returnUndo(taken));
    expect(result.current.undoAction).toBeNull();
    act(() => result.current.finalizeUndo(taken));
    expect(toast).not.toHaveBeenCalled();

    act(() => result.current.offerUndo(pending('已刪除步驟 2', 3), 'p1', taken));
    expect(result.current.undoAction?.supersedes).toBeUndefined();
  });

  it('offers for use only the undo in play, not one a running mutation took', () => {
    const { result } = renderUndo();
    act(() => result.current.offerUndo(pending('已刪除步驟 3', 2), 'p1'));
    expect(result.current.offeredUndo()).toMatchObject({ message: '已刪除步驟 3' });

    act(() => { result.current.takeUndo(); });
    expect(result.current.offeredUndo()).toBeNull();
  });

  it('drops the undo of a deleted Project without announcing anything', () => {
    const { result, rerender } = renderUndo();
    act(() => result.current.offerUndo(pending('已刪除步驟 3', 2), 'p1'));

    rerender({ project: projectAt(2), projectDeleted: true });

    expect(result.current.undoAction).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});

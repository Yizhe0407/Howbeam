// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { UndoAction } from '@/lib/editor/editor-app-model';

const toast = vi.hoisted(() => ({ custom: vi.fn(), loading: vi.fn(), remove: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));

import { useBusyNotice, useUndoNotice } from '@/components/editor/use-notices';
import { BUSY_DELAY_MS, BUSY_MIN_SHOWN_MS } from '@/lib/shared/use-deferred-busy';
import { itemAt } from '../setup/item-at';

const action = (overrides: Partial<UndoAction> = {}) =>
  ({ id: 1, message: '已刪除步驟 1', projectId: 'p1', expectedRevision: 2, restore: vi.fn(), ...overrides }) as UndoAction;

type Props = { action: UndoAction | null; pending: boolean };

function renderUndoNotice(initial: Props, onUndo = vi.fn(), onDismiss = vi.fn()) {
  const view = renderHook(
    (props: Props) => useUndoNotice({ ...props, onUndo, onDismiss }),
    { initialProps: initial },
  );
  return { ...view, onUndo, onDismiss };
}

function shownNotice(): ReactElement {
  return toast.custom.mock.calls.at(-1)![0] as ReactElement;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useUndoNotice', () => {
  it('puts the offer on the notice stack under one id, with no timer of its own', () => {
    renderUndoNotice({ action: action(), pending: false });

    expect(toast.custom).toHaveBeenCalledOnce();
    expect(itemAt(toast.custom.mock.calls, 0)[1]).toEqual({ id: 'editor-undo', duration: Infinity });
    render(shownNotice());
    expect(screen.getByRole('status').textContent).toContain('已刪除步驟 1');
  });

  it('wires the notice buttons to the latest callbacks', () => {
    const { onUndo, onDismiss } = renderUndoNotice({ action: action(), pending: false });
    render(shownNotice());

    act(() => screen.getByRole('button', { name: '還原' }).click());
    act(() => screen.getByRole('button', { name: '關閉還原提示' }).click());

    expect(onUndo).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('auto-dismisses after five idle seconds', () => {
    const { onDismiss } = renderUndoNotice({ action: action(), pending: false });

    act(() => vi.advanceTimersByTime(4_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('holds the window while a restore is pending and restarts it afterwards', () => {
    const { rerender, onDismiss } = renderUndoNotice({ action: action(), pending: false });

    // The user clicks 還原 just before the window closes: the notice must not
    // go away mid-operation.
    act(() => vi.advanceTimersByTime(4_800));
    rerender({ action: action(), pending: true });
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
    render(shownNotice());
    expect(screen.getByText('還原中')).toBeTruthy();

    rerender({ action: action(), pending: false });
    act(() => vi.advanceTimersByTime(4_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('shows a restore as in progress only once it proves slow', () => {
    const { rerender } = renderUndoNotice({ action: action(), pending: false });
    toast.custom.mockClear();

    rerender({ action: action(), pending: true });
    act(() => vi.advanceTimersByTime(BUSY_DELAY_MS - 1));
    expect(toast.custom).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    render(shownNotice());
    expect(screen.getByText('還原中')).toBeTruthy();
  });

  it('starts a fresh window for a newer offer', () => {
    const { rerender, onDismiss } = renderUndoNotice({ action: action({ id: 1 }), pending: false });

    act(() => vi.advanceTimersByTime(4_000));
    rerender({ action: action({ id: 2, message: '已刪除步驟 2' }), pending: false });
    act(() => vi.advanceTimersByTime(4_999));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('removes the notice at once when the offer ends, and when the editor unmounts', () => {
    const { rerender, unmount } = renderUndoNotice({ action: action(), pending: false });
    toast.remove.mockClear();

    rerender({ action: null, pending: false });
    expect(toast.remove).toHaveBeenCalledWith('editor-undo');

    toast.remove.mockClear();
    unmount();
    expect(toast.remove).toHaveBeenCalledWith('editor-undo');
  });
});

describe('useBusyNotice', () => {
  const renderBusy = () => renderHook(({ label }: { label: string | null }) => useBusyNotice(label), {
    initialProps: { label: null as string | null },
  });

  it('shows the label once work proves slow and removes it when done', () => {
    const { rerender } = renderBusy();
    expect(toast.loading).not.toHaveBeenCalled();

    rerender({ label: '正在處理…' });
    act(() => vi.advanceTimersByTime(BUSY_DELAY_MS));
    // Infinite: the Toaster's own default duration must not hide it while work continues.
    expect(toast.loading).toHaveBeenCalledWith('正在處理…', { id: 'editor-busy', duration: Infinity });

    rerender({ label: null });
    act(() => vi.advanceTimersByTime(BUSY_MIN_SHOWN_MS));
    expect(toast.remove).toHaveBeenCalledWith('editor-busy');
  });

  it('shows nothing for work that finishes quickly', () => {
    const { rerender } = renderBusy();

    rerender({ label: '正在處理…' });
    act(() => vi.advanceTimersByTime(BUSY_DELAY_MS - 1));
    rerender({ label: null });
    act(() => vi.advanceTimersByTime(BUSY_MIN_SHOWN_MS * 2));

    expect(toast.loading).not.toHaveBeenCalled();
  });
});

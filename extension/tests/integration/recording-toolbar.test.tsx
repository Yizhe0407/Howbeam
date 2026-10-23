// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { id: 'test-extension' },
    storage: { local: { get: mocks.get, set: mocks.set, remove: mocks.remove } },
  },
}));

import RecordingToolbar, { type RecordingToolbarState } from '@/lib/recording/recording-toolbar';
import { RECORDING_TOOLBAR_CORNER_KEY } from '@/lib/recording/recording-toolbar-position';
import { RECORDING_TOOLBAR_COLLAPSED_KEY } from '@/lib/recording/use-toolbar-collapsed';
import { RECORDING_TOOLBAR_UNDO_KEY } from '@/lib/recording/use-toolbar-undo';
import { itemAt } from '../setup/item-at';

const state: RecordingToolbarState = {
  runId: 'run-1',
  mode: 'steps',
  phase: 'recording',
  itemCount: 2,
  error: null,
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.set.mockReset();
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.get.mockResolvedValue({ [RECORDING_TOOLBAR_CORNER_KEY]: 'bottom-right' });
  mocks.set.mockResolvedValue(undefined);
});

afterEach(cleanup);

/** The toolbar draws itself only once its saved collapse choice has been read, so wait for that. */
async function mount(ui: ReactElement) {
  const view = render(ui);
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(RECORDING_TOOLBAR_COLLAPSED_KEY));
  await act(async () => { await Promise.resolve(); });
  return view;
}

describe('recording toolbar', () => {
  it('shows a page-side notice as an alert, behind any run error', async () => {
    const { rerender } = await mount(<RecordingToolbar state={state} onCommand={vi.fn()} notice="剛才的點擊沒有記錄" />);
    expect(screen.getByRole('alert').textContent).toBe('剛才的點擊沒有記錄');
    rerender(<RecordingToolbar state={{ ...state, error: '擷取失敗' }} onCommand={vi.fn()} notice="剛才的點擊沒有記錄" />);
    expect(screen.getByRole('alert').textContent).toBe('擷取失敗');
    rerender(<RecordingToolbar state={state} onCommand={vi.fn()} notice={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the target project out of the bar, naming it only in the status label and tooltip', async () => {
    const { rerender } = await mount(<RecordingToolbar state={{ ...state, projectTitle: '既有教學' }} onCommand={vi.fn()} />);
    expect(screen.queryByText('既有教學')).toBeNull();
    const handle = screen.getByRole('button', { name: /拖曳移動/ });
    expect(handle.getAttribute('aria-label')).toContain('新步驟會加到「既有教學」');
    expect(handle.getAttribute('data-tooltip')).toBe('新步驟會加到「既有教學」');
    rerender(<RecordingToolbar state={{ ...state, projectTitle: null }} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /拖曳移動/ }).getAttribute('aria-label')).not.toContain('既有教學');
  });

  it('offers the position control as drag-only: arrow keys do not move it', async () => {
    await mount(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    const positionControl = screen.getByRole('button', { name: /拖曳移動/ });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(RECORDING_TOOLBAR_CORNER_KEY));
    expect(positionControl.getAttribute('aria-label')).not.toContain('方向鍵');

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      fireEvent.keyDown(positionControl, { key });
    }

    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('requires confirmation before discarding the current recording', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    await mount(<RecordingToolbar state={state} onCommand={onCommand} />);

    const openDiscard = () => fireEvent.click(screen.getByRole('button', { name: '放棄這次錄製' }));
    openDiscard();
    expect(screen.getByRole('alertdialog', { name: '放棄這次錄製？' })).toBeTruthy();
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();

    openDiscard();
    fireEvent.click(screen.getByRole('button', { name: '放棄錄製' }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('DISCARD_CURRENT_RECORDING', undefined));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('starts a region capture straight from the bar in either mode, and exposes its active state', async () => {
    const onStartRegionCapture = vi.fn();
    const { rerender } = await mount(
      <RecordingToolbar state={state} onCommand={vi.fn()} onStartRegionCapture={onStartRegionCapture} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '框選區域' }));
    expect(onStartRegionCapture).toHaveBeenCalledOnce();

    rerender(
      <RecordingToolbar state={{ ...state, mode: 'snapshot' }} onCommand={vi.fn()} onStartRegionCapture={onStartRegionCapture} />,
    );
    expect((screen.getByRole('button', { name: '框選區域' }) as HTMLButtonElement).disabled).toBe(false);

    rerender(
      <RecordingToolbar state={state} onCommand={vi.fn()} onStartRegionCapture={onStartRegionCapture} regionCaptureActive />,
    );
    expect(screen.getByRole('button', { name: /區域擷取中/ })).toBeTruthy();
    const active = screen.getByRole('button', { name: '區域擷取進行中' }) as HTMLButtonElement;
    expect(active.disabled).toBe(true);
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('區域擷取已啟動，請在畫面上拖曳選取範圍')).toBeTruthy();
  });

  it('has no region capture while a snapshot waits to be captured', async () => {
    await mount(
      <RecordingToolbar
        state={{ ...state, mode: 'snapshot', phase: 'preparing-next', itemCount: 0 }}
        onCommand={vi.fn()}
        onStartRegionCapture={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '框選區域' })).toBeNull();
  });

  it('collapses from the last button and keeps a meaningful compact status', async () => {
    await mount(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(itemAt(buttons, buttons.length - 1).getAttribute('aria-label')).toBe('收合控制器');
    fireEvent.click(screen.getByRole('button', { name: '收合控制器' }));

    expect(screen.getByRole('button', { name: /錄製中，2 步；展開錄製控制/ })).toBeTruthy();
  });

  // The 更多 menu held exactly one action in the invalidated shell; discard now sits directly in that row.
  it('offers discard directly in the invalidated shell, with no overflow menu', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    await mount(
      <RecordingToolbar
        state={{ ...state, mode: 'snapshot', phase: 'invalidated' }}
        onCommand={onCommand}
      />,
    );

    expect(screen.queryByRole('button', { name: '更多錄製動作' })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: '保留並重建' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '放棄這次錄製' }));
    expect(screen.getByRole('alertdialog', { name: '放棄這次錄製？' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '放棄錄製' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('DISCARD_CURRENT_RECORDING', undefined));
  });

  it('names the recording mode with the shared vocabulary in the snapshot undo snackbar', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true, undoToken: 'undo-1', removedItemNumber: 1 });
    await mount(<RecordingToolbar state={{ ...state, mode: 'snapshot' }} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole('button', { name: '復原上一個' }));

    // The snackbar and the live-region announcement now read the item noun from
    // the same map, so both say 標註 rather than one of them saying 步驟.
    expect(await screen.findAllByText('已移除標註 1')).toHaveLength(2);
  });

  it('switches from steps to snapshot without a confirmation', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    await mount(<RecordingToolbar state={state} onCommand={onCommand} />);

    expect(screen.getByRole('radio', { name: '步驟' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '標註' }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('SWITCH_TO_SNAPSHOT_MODE', undefined));
  });

  it('switches a snapshot with no annotations to steps immediately', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    await mount(<RecordingToolbar state={{ ...state, mode: 'snapshot', itemCount: 0 }} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole('radio', { name: '步驟' }));

    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('SWITCH_TO_STEPS_MODE', undefined));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('leaves a snapshot that already has annotations without asking, keeping what was marked', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    await mount(<RecordingToolbar state={{ ...state, mode: 'snapshot', itemCount: 2 }} onCommand={onCommand} />);

    fireEvent.click(screen.getByRole('radio', { name: '步驟' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('SWITCH_TO_STEPS_MODE', undefined));
  });

  it('shows one icon-and-count status per state, with the full wording as its label', async () => {
    const { rerender } = await mount(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /錄製中，2 步/ })).toBeTruthy();

    rerender(<RecordingToolbar state={{ ...state, phase: 'paused' }} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /已暫停，2 步/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '繼續錄製' })).toBeTruthy();

    rerender(<RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'recording' }} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /標註中，2 處/ })).toBeTruthy();

    rerender(<RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'preparing-next', itemCount: 0 }} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /待擷取/ })).toBeTruthy();
  });

  it('walks a snapshot through capture, next and finish with one main button per state', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = await mount(
      <RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'preparing-next', itemCount: 0 }} onCommand={onCommand} />,
    );
    expect(screen.getByText('調整好頁面後，按「擷取」。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '復原上一個' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '擷取' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('CREATE_NEXT_SNAPSHOT', undefined));

    rerender(<RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'recording', itemCount: 1 }} onCommand={onCommand} />);
    expect(screen.queryByRole('button', { name: '擷取' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下一張' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('PREPARE_NEXT_SNAPSHOT', undefined));

    // Finish is always the same control, whatever the state, and never doubles as another action.
    fireEvent.click(screen.getByRole('button', { name: '結束' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('FINISH_RECORDING', undefined));
  });

  it('finishes from the waiting state too', async () => {
    const onCommand = vi.fn().mockResolvedValue({ ok: true });
    await mount(<RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'preparing-next', itemCount: 0 }} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole('button', { name: '結束' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('FINISH_RECORDING', undefined));
  });
});

describe('recording toolbar collapse', () => {
  it('keeps the choice for the run: a toolbar mounted afresh (another tab) comes up collapsed, a new run does not', async () => {
    const { unmount } = await mount(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '收合控制器' }));
    expect(mocks.set).toHaveBeenCalledWith({ [RECORDING_TOOLBAR_COLLAPSED_KEY]: { runId: 'run-1', collapsed: true } });
    unmount();

    mocks.get.mockImplementation(async (key: string) => (
      key === RECORDING_TOOLBAR_COLLAPSED_KEY ? { [key]: { runId: 'run-1', collapsed: true } } : { [RECORDING_TOOLBAR_CORNER_KEY]: 'bottom-right' }
    ));
    const second = await mount(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    expect(screen.getByRole('button', { name: /展開錄製控制/ })).toBeTruthy();
    second.unmount();

    await mount(<RecordingToolbar state={{ ...state, runId: 'run-2' }} onCommand={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /展開錄製控制/ })).toBeNull();
    expect(screen.getByRole('button', { name: '收合控制器' })).toBeTruthy();
  });

  it('is not drawn until its saved corner is known, so it never appears in the default corner first', async () => {
    const releases: Array<() => void> = [];
    mocks.get.mockImplementation((key: string) => new Promise((resolve) => {
      releases.push(() => resolve(key === RECORDING_TOOLBAR_CORNER_KEY ? { [key]: 'bottom-left' } : {}));
    }));
    const { container } = render(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.ft-position')).toBeNull();

    await act(async () => { releases.forEach((release) => release()); await Promise.resolve(); });
    await waitFor(() => expect(container.querySelector('.ft-position')).not.toBeNull());
    expect(container.querySelector('.ft-position')!.getAttribute('data-horizontal')).toBe('left');
  });

  it('shows no guidance hint while collapsed', async () => {
    await mount(<RecordingToolbar state={{ ...state, mode: 'snapshot', phase: 'preparing-next', itemCount: 0 }} onCommand={vi.fn()} />);
    expect(screen.getByText('調整好頁面後，按「擷取」。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收合控制器' }));
    expect(screen.queryByText('調整好頁面後，按「擷取」。')).toBeNull();
  });
});

describe('recording toolbar undo offer', () => {
  const stored = (overrides: Record<string, unknown> = {}) => ({
    token: 'undo-1', itemNumber: 2, runId: 'run-1', expiresAt: Date.now() + 4_000, itemCount: 1, ...overrides,
  });
  const serve = (offer: unknown) => mocks.get.mockImplementation(async (key: string) => (
    key === RECORDING_TOOLBAR_UNDO_KEY ? { [key]: offer } : { [RECORDING_TOOLBAR_CORNER_KEY]: 'bottom-right' }
  ));

  it('saves the offer after an undo and removes it once restored', async () => {
    const onCommand = vi.fn().mockResolvedValueOnce({ ok: true, undoToken: 'undo-1', removedItemNumber: 2 }).mockResolvedValue({ ok: true });
    const { rerender } = await mount(<RecordingToolbar state={state} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole('button', { name: '復原上一個' }));
    await screen.findAllByText('已移除步驟 2');
    expect(mocks.set).toHaveBeenCalledWith({ [RECORDING_TOOLBAR_UNDO_KEY]: expect.objectContaining({ token: 'undo-1', runId: 'run-1', itemCount: 1 }) });

    // The new count arrives after the undo: the offer must survive that, not be taken for a stale one.
    rerender(<RecordingToolbar state={{ ...state, itemCount: 1 }} onCommand={onCommand} />);
    fireEvent.click(await screen.findByRole('button', { name: '還原' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith('RESTORE_LAST_CAPTURE', 'undo-1'));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(RECORDING_TOOLBAR_UNDO_KEY));
  });

  it('offers Restore again in a toolbar mounted afresh while the window is still open', async () => {
    serve(stored());
    await mount(<RecordingToolbar state={{ ...state, itemCount: 1 }} onCommand={vi.fn()} />);
    expect(await screen.findByText('已移除步驟 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: '還原' })).toBeTruthy();
  });

  it.each([
    ['has expired', stored({ expiresAt: Date.now() - 1 }), 1],
    ['belongs to another run', stored({ runId: 'run-0' }), 1],
    ['no longer matches the item count', stored(), 3],
  ])('does not offer Restore when the saved offer %s', async (_name, offer, count) => {
    serve(offer);
    await mount(<RecordingToolbar state={{ ...state, itemCount: count }} onCommand={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: '還原' })).toBeNull();
  });
});

describe('recording toolbar layout', () => {
  /** jsdom has no layout, so the measured rectangles are supplied: the toolbar's right edge and its last child's. */
  function stubWidths(lastChildRight: number, toolbarRight: number) {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const right = this.classList.contains('ft-toolbar') ? toolbarRight : lastChildRight;
      return { x: 0, y: 0, top: 0, left: 0, bottom: 0, width: right, height: 0, right, toJSON: () => ({}) } as DOMRect;
    });
    return () => spy.mockRestore();
  }

  it('stays on one row while its content fits', async () => {
    const restore = stubWidths(590, 600);
    await mount(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    expect(screen.getByRole('toolbar', { hidden: true }).hasAttribute('data-compact')).toBe(false);
    restore();
  });

  it('stacks only when the single row would overflow, whatever the language', async () => {
    const restore = stubWidths(700, 600);
    await mount(<RecordingToolbar state={state} onCommand={vi.fn()} />);
    expect(screen.getByRole('toolbar', { hidden: true }).hasAttribute('data-compact')).toBe(true);
    restore();
  });
});

// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let listener: ((state: any) => void) | null = null;
  return {
    getRecordingState: vi.fn(),
    getSteps: vi.fn(),
    onRecordingStateChange: vi.fn((callback: (state: any) => void) => {
      listener = callback;
      return vi.fn();
    }),
    emit(state: any) {
      listener?.(state);
    },
    resetListener() {
      listener = null;
    },
  };
});

// The hook takes its initial value from the real createDefaultRecordingState
// (lib/storage/recording-state); only the async store access is mocked.
vi.mock('@/lib/storage/storage', () => ({
  getRecordingState: mocks.getRecordingState,
  onRecordingStateChange: mocks.onRecordingStateChange,
}));
vi.mock('@/lib/storage/step-repository', () => ({ getSteps: mocks.getSteps }));

import {
  RECORDING_RECONCILE_INTERVAL_MS,
  reconcileSteps,
  useRecordingSession,
} from '@/lib/recording/use-recording-session';
import { makeRecordingState } from '../setup/recording-state';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function state(sessionId: string) {
  return makeRecordingState({ isRecording: true, phase: 'recording', sessionId, tabId: 1 });
}

beforeEach(() => {
  mocks.getRecordingState.mockReset();
  mocks.getSteps.mockReset();
  mocks.onRecordingStateChange.mockClear();
  mocks.resetListener();
});

describe('useRecordingSession', () => {
  it('reads an explicit Project from IndexedDB only once during initial mount', async () => {
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockResolvedValue([{ id: 'url-step' }]);

    const { result } = renderHook(() => useRecordingSession('url-session'));

    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'url-step' }]));
    expect(mocks.getSteps.mock.calls).toEqual([['url-session']]);
  });

  it('reads the active recording from IndexedDB only once after initial state resolves', async () => {
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockResolvedValue([{ id: 'recording-step' }]);

    const { result } = renderHook(() => useRecordingSession());

    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'recording-step' }]));
    expect(mocks.getSteps.mock.calls).toEqual([['recording-session']]);
  });

  it('refreshes a changed recording session once instead of from both the event and effect', async () => {
    mocks.getRecordingState.mockResolvedValue(state('old-session'));
    mocks.getSteps.mockImplementation(async (sessionId: string) => [{ id: `${sessionId}-step` }]);
    const { result } = renderHook(() => useRecordingSession());
    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'old-session-step' }]));

    act(() => mocks.emit(state('new-session')));

    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'new-session-step' }]));
    expect(mocks.getSteps.mock.calls.filter(([sessionId]) => sessionId === 'new-session')).toHaveLength(1);
  });

  it('does not let a stale initial storage read replace a newer change event', async () => {
    const initial = deferred<ReturnType<typeof state>>();
    mocks.getRecordingState.mockReturnValue(initial.promise);
    mocks.getSteps.mockResolvedValue([{ id: 'new-step' }]);
    const { result } = renderHook(() => useRecordingSession());

    act(() => mocks.emit(state('new-session')));
    await waitFor(() => expect(result.current.sessionId).toBe('new-session'));

    await act(async () => {
      initial.resolve(state('old-session'));
      await initial.promise;
    });

    expect(result.current.sessionId).toBe('new-session');
  });

  it('does not let old session steps replace a newer session result', async () => {
    const oldSteps = deferred<any[]>();
    const newSteps = deferred<any[]>();
    mocks.getRecordingState.mockResolvedValue(state('old-session'));
    mocks.getSteps.mockImplementation((sessionId: string) =>
      sessionId === 'old-session' ? oldSteps.promise : newSteps.promise,
    );
    const { result } = renderHook(() => useRecordingSession());
    await waitFor(() => expect(result.current.sessionId).toBe('old-session'));

    act(() => mocks.emit(state('new-session')));
    await act(async () => {
      newSteps.resolve([{ id: 'new-step' }]);
      await newSteps.promise;
    });
    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'new-step' }]));

    await act(async () => {
      oldSteps.resolve([{ id: 'old-step' }]);
      await oldSteps.promise;
    });

    expect(result.current.steps).toEqual([{ id: 'new-step' }]);
  });

  it('不會讓缺少 sessionId 的編輯器退回顯示其他錄製中的 Project', async () => {
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockImplementation(async (sessionId: string) => [{ id: `${sessionId}-step` }]);

    const { result } = renderHook(() => useRecordingSession(null));

    await waitFor(() => expect(result.current.recording.sessionId).toBe('recording-session'));
    expect(result.current.sessionId).toBeNull();
    expect(result.current.steps).toEqual([]);
    expect(mocks.getSteps).not.toHaveBeenCalledWith('recording-session');
  });

  it('uses an explicit editor session as the authoritative step source', async () => {
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockImplementation(async (sessionId: string) => [{ id: `${sessionId}-step` }]);

    const { result } = renderHook(() => useRecordingSession('url-session'));

    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'url-session-step' }]));
    expect(result.current.sessionId).toBe('url-session');
    expect(result.current.recording.sessionId).toBe('recording-session');

    act(() => mocks.emit(state('other-recording-session')));
    await waitFor(() => expect(result.current.recording.sessionId).toBe('other-recording-session'));
    expect(result.current.sessionId).toBe('url-session');
    expect(mocks.getSteps).not.toHaveBeenCalledWith('recording-session');
    expect(mocks.getSteps).not.toHaveBeenCalledWith('other-recording-session');
  });

  it('refreshes the explicit Project after same-session recording-state events', async () => {
    let revision = 1;
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockImplementation(async (sessionId: string) => [{ id: `${sessionId}-step-${revision}` }]);

    const { result } = renderHook(() => useRecordingSession('url-session'));
    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'url-session-step-1' }]));

    revision = 2;
    act(() => mocks.emit(state('recording-session')));

    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'url-session-step-2' }]));
    expect(mocks.getSteps.mock.calls.filter(([sessionId]) => sessionId === 'url-session')).toHaveLength(2);
    expect(mocks.getSteps).not.toHaveBeenCalledWith('recording-session');
  });

  it('protects explicit URL session changes from stale IndexedDB responses', async () => {
    const oldSteps = deferred<any[]>();
    const newSteps = deferred<any[]>();
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    mocks.getSteps.mockImplementation((sessionId: string) =>
      sessionId === 'old-url-session' ? oldSteps.promise : newSteps.promise,
    );

    const { result, rerender } = renderHook(
      ({ sessionId }) => useRecordingSession(sessionId),
      { initialProps: { sessionId: 'old-url-session' } },
    );
    await waitFor(() => expect(mocks.getSteps).toHaveBeenCalledWith('old-url-session'));

    rerender({ sessionId: 'new-url-session' });
    await act(async () => {
      newSteps.resolve([{ id: 'new-url-step' }]);
      await newSteps.promise;
    });
    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'new-url-step' }]));

    await act(async () => {
      oldSteps.resolve([{ id: 'old-url-step' }]);
      await oldSteps.promise;
    });

    expect(result.current.sessionId).toBe('new-url-session');
    expect(result.current.steps).toEqual([{ id: 'new-url-step' }]);
  });

  it('surfaces recording-state read failures without an unhandled rejection', async () => {
    const error = new Error('storage unavailable');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getRecordingState.mockRejectedValue(error);
    mocks.getSteps.mockResolvedValue([]);

    const { result } = renderHook(() => useRecordingSession());

    await waitFor(() => expect(result.current.dataError).toBe('無法讀取錄製狀態，請重新整理後再試一次。'));
    expect(consoleError).toHaveBeenCalledWith('[howbeam] failed to read recording state', error);
  });

  it('surfaces IndexedDB refresh failures and recovers after a successful refresh', async () => {
    const error = new Error('indexeddb closed');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getRecordingState.mockResolvedValue(state('session'));
    mocks.getSteps.mockRejectedValue(error);

    const { result } = renderHook(() => useRecordingSession('session'));

    await waitFor(() => expect(result.current.dataError).toBe('無法讀取錄製內容，請重新整理後再試一次。'));
    mocks.getSteps.mockResolvedValue([{ id: 'recovered-step' }]);
    await act(async () => result.current.refresh());
    await waitFor(() => expect(result.current.steps).toEqual([{ id: 'recovered-step' }]));
    expect(result.current.dataError).toBeNull();
  });

  it('withSteps:false 只讀取錄製狀態，不讀步驟也不啟動 reconcile timer', async () => {
    vi.useFakeTimers();
    try {
      mocks.getRecordingState.mockResolvedValue(state('session'));
      mocks.getSteps.mockResolvedValue([{ id: 'ignored-step' }]);
      const { result } = renderHook(() => useRecordingSession(undefined, { withSteps: false }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.recording.sessionId).toBe('session');

      // Same-session state events and the reconciliation interval both stay
      // free of IndexedDB step reads (and their screenshot Blobs).
      act(() => mocks.emit(state('session')));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECORDING_RECONCILE_INTERVAL_MS * 3);
      });

      expect(mocks.getSteps).not.toHaveBeenCalled();
      expect(result.current.steps).toEqual([]);
      expect(result.current.dataError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overlap periodic IndexedDB reconciliation reads', async () => {
    vi.useFakeTimers();
    try {
      const pendingPoll = deferred<any[]>();
      mocks.getRecordingState.mockResolvedValue(state('session'));
      mocks.getSteps.mockResolvedValue([]);
      const { result } = renderHook(() => useRecordingSession('session'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.recording.sessionId).toBe('session');
      const callsBeforePolling = mocks.getSteps.mock.calls.length;
      mocks.getSteps.mockReturnValue(pendingPoll.promise);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECORDING_RECONCILE_INTERVAL_MS);
      });
      expect(mocks.getSteps.mock.calls.length).toBe(callsBeforePolling + 1);

      // A read still in flight must never be joined by a second one.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECORDING_RECONCILE_INTERVAL_MS * 5);
      });
      expect(mocks.getSteps.mock.calls.length).toBe(callsBeforePolling + 1);

      await act(async () => {
        pendingPoll.resolve([]);
        await pendingPoll.promise;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECORDING_RECONCILE_INTERVAL_MS - 1);
      });
      expect(mocks.getSteps.mock.calls.length).toBe(callsBeforePolling + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.getSteps.mock.calls.length).toBe(callsBeforePolling + 2);
      expect(result.current.dataError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

});

describe('reconcileSteps', () => {
  it('retains immutable screenshot Blob wrappers across IndexedDB refreshes', () => {
    const previousBlob = new Blob(['same screenshot'], { type: 'image/jpeg' });
    const refreshedBlob = new Blob(['same screenshot'], { type: 'image/jpeg' });
    const previous = [{ id: 'anchor', screenshotBlob: previousBlob, description: 'before' }] as any[];
    const next = [{ id: 'anchor', screenshotBlob: refreshedBlob, description: 'after' }] as any[];

    const [reconciled] = reconcileSteps(previous, next);

    expect(reconciled.screenshotBlob).toBe(previousBlob);
    expect(reconciled.description).toBe('after');
  });

  it('applies manual-bound and privacy metadata changes without replacing the Blob', () => {
    const previousBlob = new Blob(['same'], { type: 'image/jpeg' });
    const refreshedBlob = new Blob(['same'], { type: 'image/jpeg' });
    const previous = [{
      id: 'step',
      screenshotBlob: previousBlob,
      captureRevision: 1,
      manualBounds: null,
      redactions: [],
    }] as any[];
    const next = [{
      ...previous[0],
      screenshotBlob: refreshedBlob,
      manualBounds: { x: 10, y: 20, width: 30, height: 40 },
      redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 4 } }],
      redactionReviewRequired: true,
    }] as any[];

    const [reconciled] = reconcileSteps(previous, next);

    expect(reconciled).not.toBe(previous[0]);
    expect(reconciled.screenshotBlob).toBe(previousBlob);
    expect(reconciled.manualBounds).toEqual(next[0].manualBounds);
    expect(reconciled.redactions).toEqual(next[0].redactions);
    expect(reconciled.redactionReviewRequired).toBe(true);
  });

  it('uses the replacement Blob when captureRevision changes', () => {
    const previousBlob = new Blob(['before'], { type: 'image/jpeg' });
    const replacementBlob = new Blob(['after'], { type: 'image/jpeg' });
    const previous = [{ id: 'step', screenshotBlob: previousBlob, captureRevision: 2 }] as any[];
    const next = [{ id: 'step', screenshotBlob: replacementBlob, captureRevision: 3 }] as any[];

    const [reconciled] = reconcileSteps(previous, next);

    expect(reconciled.screenshotBlob).toBe(replacementBlob);
    expect(reconciled.captureRevision).toBe(3);
  });

  it('retains the existing Blob for metadata-only refreshes at the same captureRevision', () => {
    const previousBlob = new Blob(['same'], { type: 'image/jpeg' });
    const refreshedBlob = new Blob(['same'], { type: 'image/jpeg' });
    const previous = [{ id: 'step', screenshotBlob: previousBlob, captureRevision: 4, description: 'before' }] as any[];
    const next = [{ id: 'step', screenshotBlob: refreshedBlob, captureRevision: 4, description: 'after' }] as any[];

    const [reconciled] = reconcileSteps(previous, next);

    expect(reconciled.screenshotBlob).toBe(previousBlob);
    expect(reconciled.description).toBe('after');
  });

  it('takes a new image edit revision even when the edits read back identical', () => {
    const blob = new Blob(['same'], { type: 'image/jpeg' });
    const previous = [{ id: 'step', screenshotBlob: blob, imageEditRevision: 1, redactions: [] }] as any[];
    const next = [{ id: 'step', screenshotBlob: new Blob(['same'], { type: 'image/jpeg' }), imageEditRevision: 2, redactions: [] }] as any[];

    const [reconciled] = reconcileSteps(previous, next);

    // An image editor opened from a stale row would be refused on its first save.
    expect(reconciled.imageEditRevision).toBe(2);
    expect(reconciled.screenshotBlob).toBe(blob);
  });

  it('returns the previous objects and array when a poll contains no changes', () => {
    const previousBlob = new Blob(['same screenshot'], { type: 'image/jpeg' });
    const refreshedBlob = new Blob(['same screenshot'], { type: 'image/jpeg' });
    const previous = [
      {
        id: 'anchor',
        sessionId: 'session',
        order: 0,
        screenshotBlob: previousBlob,
        bounds: null,
        devicePixelRatio: 2,
        screenshotScale: 2,
        description: '',
        url: 'https://example.com',
        timestamp: 1,
        groupId: 'anchor',
        numbered: true,
      },
    ];
    const next = [{ ...previous[0], screenshotBlob: refreshedBlob }];

    const reconciled = reconcileSteps(previous, next);

    expect(reconciled).toBe(previous);
    expect(reconciled[0]).toBe(previous[0]);
  });
});

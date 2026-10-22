// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let listener: ((state: any) => void) | null = null;
  return {
    getRecordingState: vi.fn(),
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

import { useRecordingSession } from '@/lib/recording/use-recording-session';
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
  mocks.onRecordingStateChange.mockClear();
  mocks.resetListener();
});

describe('useRecordingSession', () => {
  it('follows the active recording when no Project is named', async () => {
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));
    const { result } = renderHook(() => useRecordingSession());

    await waitFor(() => expect(result.current.sessionId).toBe('recording-session'));

    act(() => mocks.emit(state('next-session')));
    expect(result.current.sessionId).toBe('next-session');
  });

  it('does not let a stale initial storage read replace a newer change event', async () => {
    const initial = deferred<ReturnType<typeof state>>();
    mocks.getRecordingState.mockReturnValue(initial.promise);
    const { result } = renderHook(() => useRecordingSession());

    act(() => mocks.emit(state('new-session')));
    await waitFor(() => expect(result.current.sessionId).toBe('new-session'));

    await act(async () => {
      initial.resolve(state('old-session'));
      await initial.promise;
    });

    expect(result.current.sessionId).toBe('new-session');
  });

  it('不會讓缺少 sessionId 的編輯器退回顯示其他錄製中的 Project', async () => {
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));

    const { result } = renderHook(() => useRecordingSession(null));

    await waitFor(() => expect(result.current.recording.sessionId).toBe('recording-session'));
    expect(result.current.sessionId).toBeNull();
  });

  it('keeps an explicit editor Project while recordings elsewhere come and go', async () => {
    mocks.getRecordingState.mockResolvedValue(state('recording-session'));

    const { result } = renderHook(() => useRecordingSession('url-session'));

    await waitFor(() => expect(result.current.recording.sessionId).toBe('recording-session'));
    expect(result.current.sessionId).toBe('url-session');

    act(() => mocks.emit(state('other-recording-session')));
    expect(result.current.recording.sessionId).toBe('other-recording-session');
    expect(result.current.sessionId).toBe('url-session');
  });

  it('surfaces recording-state read failures without an unhandled rejection', async () => {
    const error = new Error('storage unavailable');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getRecordingState.mockRejectedValue(error);

    const { result } = renderHook(() => useRecordingSession());

    await waitFor(() => expect(result.current.dataError).toBe('無法讀取錄製狀態，請重新整理後再試一次。'));
    expect(consoleError).toHaveBeenCalledWith('[howbeam] failed to read recording state', error);
  });
});

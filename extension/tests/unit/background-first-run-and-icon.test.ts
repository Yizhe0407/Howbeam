import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORDING_STATE_KEY, type RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());
const extra = vi.hoisted(() => ({
  installedListener: null as null | ((details: { reason: string }) => void),
  storageListeners: [] as ((changes: Record<string, { newValue?: unknown }>, areaName: string) => void)[],
  setIcon: vi.fn(),
}));

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks, {
    onInstalled: (listener) => {
      extra.installedListener = listener;
    },
    onStorageChanged: (listener) => {
      extra.storageListeners.push(listener);
    },
    actionSetIcon: extra.setIcon,
  }));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/project-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockProjectRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));
vi.mock('@/lib/recording/background/pending-undo-store', async () =>
  (await import('../setup/background-test-utils')).mockPendingUndoStoreModule(mocks));

const IDLE_ICON = { 16: '/icon/16.png', 32: '/icon/32.png' };
const RECORDING_ICON = { 16: '/icon/recording-16.png', 32: '/icon/recording-32.png' };

let storedState: RecordingState;

function publishState(state: RecordingState): void {
  storedState = state;
  for (const listener of extra.storageListeners) listener({ [RECORDING_STATE_KEY]: { newValue: state } }, 'local');
}

beforeEach(() => {
  vi.clearAllMocks();
  extra.installedListener = null;
  extra.storageListeners = [];
  extra.setIcon.mockResolvedValue(undefined);
  storedState = makeRecordingState();
  mocks.getRecordingState.mockImplementation(async () => storedState);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    storedState = next;
  });
  mocks.tabsCreate.mockResolvedValue({ id: 99 });
  mocks.readPendingUndoRecord.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('first run', () => {
  it('opens the welcome page once, on install', async () => {
    await importBackground();
    expect(extra.installedListener).toBeTypeOf('function');

    extra.installedListener?.({ reason: 'install' });
    await flushAsyncWork();

    expect(mocks.tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://extension-id/welcome.html', active: true });
  });

  it.each(['update', 'chrome_update', 'shared_module_update'])('stays quiet on %s', async (reason) => {
    await importBackground();

    extra.installedListener?.({ reason });
    await flushAsyncWork();

    expect(mocks.tabsCreate).not.toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('welcome') }));
  });
});

describe('toolbar icon', () => {
  it('shows the idle mascot when the worker starts outside a run', async () => {
    await importBackground();
    await flushAsyncWork();

    expect(extra.setIcon).toHaveBeenCalledWith({ path: IDLE_ICON });
  });

  it('switches to the recording dot while a run is live and back when it ends', async () => {
    await importBackground();
    await flushAsyncWork();
    extra.setIcon.mockClear();

    publishState(makeRecordingState({ operation: 'recording', isRecording: true, phase: 'recording', sessionId: 'g', runId: 'r', tabId: 4 }));
    await flushAsyncWork();
    expect(extra.setIcon).toHaveBeenLastCalledWith({ path: RECORDING_ICON });

    // Pausing or counting items keeps the run live: no redundant icon swap.
    publishState(makeRecordingState({ operation: 'recording', isRecording: true, phase: 'paused', sessionId: 'g', runId: 'r', tabId: 4 }));
    await flushAsyncWork();
    expect(extra.setIcon).toHaveBeenCalledOnce();

    publishState(makeRecordingState());
    await flushAsyncWork();
    expect(extra.setIcon).toHaveBeenLastCalledWith({ path: IDLE_ICON });
  });

  it('restores the recording dot when the worker wakes mid-run', async () => {
    storedState = makeRecordingState({ operation: 'recording', isRecording: true, phase: 'recording', sessionId: 'g', runId: 'r', tabId: 4 });
    mocks.tabsGet.mockResolvedValue({ id: 4, windowId: 1, url: 'https://example.com' });

    await importBackground();
    await flushAsyncWork();

    expect(extra.setIcon).toHaveBeenCalledWith({ path: RECORDING_ICON });
  });

  it('never lets a failed icon swap escape into the worker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    extra.setIcon.mockRejectedValue(new Error('no window'));

    await importBackground();
    await flushAsyncWork();

    expect(warn).toHaveBeenCalledWith('[howbeam] failed to update the toolbar icon', expect.any(Error));
  });
});

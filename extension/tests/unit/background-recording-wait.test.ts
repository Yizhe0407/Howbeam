import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());
const extra = vi.hoisted(() => ({
  permissionsAddedListener: null as null | ((permissions: { origins?: string[] }) => void),
}));

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks, {
    onPermissionsAdded: (listener) => {
      extra.permissionsAddedListener = listener;
    },
  }),
);
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal),
);
vi.mock('@/lib/storage/project-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockProjectRepositoryModule(mocks, importOriginal),
);
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal),
);
vi.mock('@/lib/recording/background/pending-undo-store', async () =>
  (await import('../setup/background-test-utils')).mockPendingUndoStoreModule(mocks),
);

let storedState: RecordingState;

function recordingState(overrides: Partial<RecordingState> = {}): RecordingState {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    sessionId: 'project-a',
    tabId: 4,
    runId: 'run-1',
    ...overrides,
  });
}

/** Reports the recorded tab (4) as finished loading `url`, then lets the handling settle. */
async function recordedTabLoaded(url: string | undefined): Promise<void> {
  mocks.tabUpdatedListener?.(4, { status: 'complete' }, { id: 4, url, active: true });
  await flushAsyncWork();
  await vi.advanceTimersByTimeAsync(0);
  await flushAsyncWork();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.tabUpdatedListener = null;
  extra.permissionsAddedListener = null;
  storedState = recordingState();
  mocks.getRecordingState.mockImplementation(async () => storedState);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    storedState = next;
  });
  mocks.permissionsContains.mockResolvedValue(true);
  mocks.getSteps.mockResolvedValue([]);
  mocks.tabsGet.mockResolvedValue({ id: 4, windowId: 1, active: true, url: 'https://example.com/flow' });
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.executeScript.mockResolvedValue([]);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a steps run whose tab leaves the recordable web', () => {
  it('waits on a browser page and resumes when the tab is back on a website', async () => {
    await importBackground();
    await flushAsyncWork();

    await recordedTabLoaded('chrome://settings/');

    expect(storedState).toMatchObject({ isRecording: true, phase: 'recording', tabId: 4, runId: 'run-1' });
    expect(storedState.recoverableError).toEqual({
      code: 'RECORDING_WAITING_RESTRICTED_PAGE',
      copy: 'background.waitingRestrictedPage',
    });
    expect(storedState.error).toBe('background.waitingRestrictedPage');
    expect(mocks.executeScript).not.toHaveBeenCalled();

    await recordedTabLoaded('https://example.com/next');

    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 4, allFrames: true } }),
    );
    expect(storedState).toMatchObject({ isRecording: true, phase: 'recording', error: null, recoverableError: null });
  });

  it('keeps a paused run paused while it waits', async () => {
    storedState = recordingState({ phase: 'paused' });
    await importBackground();
    await flushAsyncWork();

    await recordedTabLoaded('chrome://extensions/');

    expect(storedState).toMatchObject({ isRecording: true, phase: 'paused' });
    expect(storedState.recoverableError?.code).toBe('RECORDING_WAITING_RESTRICTED_PAGE');
  });

  it('says site access is missing (not that the page is restricted) when the browser hides the URL for lack of permission', async () => {
    mocks.permissionsContains.mockResolvedValue(false);
    await importBackground();
    await flushAsyncWork();

    await recordedTabLoaded(undefined);

    expect(storedState).toMatchObject({ isRecording: true, tabId: 4 });
    expect(storedState.recoverableError).toEqual({
      code: 'RECORDING_WAITING_SITE_ACCESS',
      copy: 'background.waitingSiteAccess',
    });
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('resumes a run waiting for site access once access to all sites is granted', async () => {
    mocks.permissionsContains.mockResolvedValue(false);
    await importBackground();
    await flushAsyncWork();
    await recordedTabLoaded(undefined);
    expect(storedState.recoverableError?.code).toBe('RECORDING_WAITING_SITE_ACCESS');

    mocks.permissionsContains.mockResolvedValue(true);
    mocks.tabsGet.mockResolvedValue({ id: 4, windowId: 1, active: true, url: 'https://other-origin.example/' });
    extra.permissionsAddedListener?.({ origins: ['<all_urls>'] });
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();

    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 4, allFrames: true } }),
    );
    expect(storedState).toMatchObject({ isRecording: true, error: null, recoverableError: null });
  });

  it('waits out a page that failed to load instead of ending the run', async () => {
    silenceIntentionalErrorLogs();
    mocks.executeScript.mockRejectedValue(new Error('Frame with ID 0 is showing error page'));
    await importBackground();
    await flushAsyncWork();

    await recordedTabLoaded('https://unreachable.example/');

    expect(storedState).toMatchObject({ isRecording: true, tabId: 4 });
    expect(storedState.recoverableError).toEqual({
      code: 'RECORDING_WAITING_PAGE_FAILED',
      copy: 'background.errorPageFailedToLoad',
    });
  });

  it('still ends the run when the recorder cannot be restored on a recordable page', async () => {
    silenceIntentionalErrorLogs();
    mocks.executeScript.mockRejectedValue(new Error('Unexpected scripting failure'));
    await importBackground();
    await flushAsyncWork();

    await recordedTabLoaded('https://example.com/next');

    expect(storedState).toMatchObject({ isRecording: false, phase: 'error' });
    expect(storedState.error).toBe('background.stoppedRecorderUnavailable');
  });

  it('keeps an unrelated capture error when the run resumes', async () => {
    storedState = recordingState({
      error: 'background.captureFailed',
      recoverableError: { code: 'CAPTURE_FAILED', copy: 'background.captureFailed' },
    });
    await importBackground();
    await flushAsyncWork();

    await recordedTabLoaded('https://example.com/next');

    expect(storedState.recoverableError).toEqual({ code: 'CAPTURE_FAILED', copy: 'background.captureFailed' });
  });
});

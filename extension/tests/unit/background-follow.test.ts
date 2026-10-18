import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/project-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockProjectRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));
vi.mock('@/lib/recording/background/pending-undo-store', async () =>
  (await import('../setup/background-test-utils')).mockPendingUndoStoreModule(mocks));

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

/** The durable state the mocked storage serves; setRecordingState writes it so follow-mode's read-validate-write cycle behaves like the real store. */
let storedState: RecordingState;

const RECORDED_TAB = { id: 4, windowId: 1, active: false, url: 'https://example.com/flow' };
const OTHER_TAB = { id: 9, windowId: 2, active: true, url: 'https://other.example/page' };

async function activateTab(tabId: number): Promise<void> {
  mocks.tabActivatedListener?.({ tabId, windowId: 2 });
  await vi.advanceTimersByTimeAsync(300);
  await flushAsyncWork();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.messageListener = null;
  mocks.tabActivatedListener = null;
  mocks.windowFocusListener = null;
  mocks.tabRemovedListener = null;
  mocks.tabUpdatedListener = null;
  storedState = recordingState();
  mocks.getRecordingState.mockImplementation(async () => storedState);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    storedState = next;
  });
  mocks.permissionsContains.mockResolvedValue(true);
  mocks.getSteps.mockResolvedValue([]);
  mocks.tabsGet.mockImplementation(async (tabId: number) => {
    if (tabId === OTHER_TAB.id) return OTHER_TAB;
    if (tabId === RECORDED_TAB.id) return RECORDED_TAB;
    throw new Error(`No tab with id: ${tabId}.`);
  });
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.executeScript.mockResolvedValue([]);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('follow-the-active-tab recording (steps mode)', () => {
  it('moves the run to an eligible activated tab: state first, then inject, then stop the old recorder', async () => {
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(9);
    expect(storedState.runId).toBe('run-1');
    expect(storedState.isRecording).toBe(true);
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 9, allFrames: true } }),
    );
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(4, { type: 'STEPMARK_STOP' });
    // READY validation reads state.tabId, so the state write must precede injection, and the old recorder must only stop after the new one is in.
    const stateWriteOrder = mocks.setRecordingState.mock.invocationCallOrder[0];
    const injectOrder = mocks.executeScript.mock.invocationCallOrder[0];
    const stopOrder = mocks.tabsSendMessage.mock.invocationCallOrder[0];
    expect(stateWriteOrder).toBeLessThan(injectOrder);
    expect(injectOrder).toBeLessThan(stopOrder);
  });

  it('debounces rapid switches: only the tab still active after the pause is followed', async () => {
    const THIRD_TAB = { id: 12, windowId: 2, active: true, url: 'https://third.example/app' };
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === THIRD_TAB.id) return THIRD_TAB;
      if (tabId === OTHER_TAB.id) return { ...OTHER_TAB, active: false };
      return RECORDED_TAB;
    });
    await importBackground();
    await flushAsyncWork();

    mocks.tabActivatedListener?.({ tabId: 9, windowId: 2 });
    await vi.advanceTimersByTimeAsync(100);
    mocks.tabActivatedListener?.({ tabId: 12, windowId: 2 });
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(storedState.tabId).toBe(12);
    expect(mocks.executeScript).toHaveBeenCalledTimes(1);
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 12, allFrames: true } }),
    );
  });

  it('stays on the previous tab when a restricted or extension tab is activated', async () => {
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === 9) return { id: 9, windowId: 2, active: true, url: 'chrome://settings/' };
      return RECORDED_TAB;
    });
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(4);
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();
    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
  });

  it('keeps single-tab behavior when the <all_urls> grant is absent', async () => {
    mocks.permissionsContains.mockResolvedValue(false);
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(mocks.permissionsContains).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(storedState.tabId).toBe(4);
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('never follows once a snapshot has been captured', async () => {
    storedState = recordingState({ mode: 'snapshot', groupAnchorId: 'anchor-1' });
    mocks.getStep.mockResolvedValue({
      id: 'anchor-1',
      sessionId: 'project-a',
      groupId: 'anchor-1',
      url: 'https://example.com/flow',
      screenshotBlob: new Blob(['image']),
    });
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(4);
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('follows while a snapshot run is only waiting to capture, so any page can be chosen', async () => {
    storedState = recordingState({ mode: 'snapshot', phase: 'preparing-next', itemCount: 0 });
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(9);
    expect(mocks.executeScript).toHaveBeenCalled();
  });

  it('abandons a stale follow when the run changes between the read and the state mutation', async () => {
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === 9) {
        // A concurrent control settles the old run while the follow is still validating its target tab; the serialized mutation must notice.
        storedState = recordingState({ runId: 'run-2', tabId: 4 });
        return OTHER_TAB;
      }
      return RECORDED_TAB;
    });
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(4);
    expect(storedState.runId).toBe('run-2');
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('follows the focused window\'s active tab on cross-window switches', async () => {
    mocks.tabsQuery.mockResolvedValue([OTHER_TAB]);
    await importBackground();
    await flushAsyncWork();

    mocks.windowFocusListener?.(2);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(mocks.tabsQuery).toHaveBeenCalledWith({ active: true, windowId: 2 });
    expect(storedState.tabId).toBe(9);
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 9, allFrames: true } }),
    );
  });

  it('ignores focus leaving the browser entirely (WINDOW_ID_NONE)', async () => {
    await importBackground();
    await flushAsyncWork();

    mocks.windowFocusListener?.(-1);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(mocks.tabsQuery).not.toHaveBeenCalled();
    expect(storedState.tabId).toBe(4);
  });

  it('hands the run back to the previous tab when injection into the new tab fails', async () => {
    silenceIntentionalErrorLogs();
    mocks.executeScript.mockRejectedValue(new Error('Cannot access contents of the page.'));
    await importBackground();
    await flushAsyncWork();

    await activateTab(9);

    expect(storedState.tabId).toBe(4);
    expect(storedState.isRecording).toBe(true);
    // The previous tab's recorder was never stopped, so no stop message and no user-facing error: the run simply stays where it was.
    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(storedState.error).toBeNull();
  });

  it('does nothing when the activated tab is the recorded tab itself', async () => {
    await importBackground();
    await flushAsyncWork();

    await activateTab(4);

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(mocks.executeScript).not.toHaveBeenCalled();
    expect(mocks.tabsSendMessage).not.toHaveBeenCalled();
  });
});

/** Closes a tab and lets the removal settle through the lifecycle queue. */
async function closeTab(tabId: number): Promise<void> {
  mocks.tabRemovedListener?.(tabId);
  await flushAsyncWork();
  await vi.advanceTimersByTimeAsync(0);
  await flushAsyncWork();
}

describe('closing the tab a recording followed into', () => {
  const NEW_TAB_PAGE = { id: 20, windowId: 2, active: true, url: 'chrome://newtab/' };

  /** Follows from the recorded tab (4) into tab 9, then makes 9 a closed tab. */
  async function followIntoOtherTabThenClose(focusedAfterClose: { id: number; url?: string; active?: boolean }) {
    await importBackground();
    await flushAsyncWork();
    await activateTab(9);
    expect(storedState.tabId).toBe(9);
    vi.clearAllMocks();
    mocks.executeScript.mockResolvedValue([]);
    mocks.tabsSendMessage.mockResolvedValue(undefined);
    mocks.permissionsContains.mockResolvedValue(true);
    mocks.getRecordingState.mockImplementation(async () => storedState);
    mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
      storedState = next;
    });
    mocks.tabsQuery.mockResolvedValue([focusedAfterClose]);
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === RECORDED_TAB.id) return { ...RECORDED_TAB, active: focusedAfterClose.id === RECORDED_TAB.id };
      if (tabId === NEW_TAB_PAGE.id) return NEW_TAB_PAGE;
      throw new Error(`No tab with id: ${tabId}.`);
    });
    await closeTab(9);
  }

  it('hands the run back to the original tab that is active again, instead of ending it', async () => {
    await followIntoOtherTabThenClose({ ...RECORDED_TAB, active: true });

    expect(mocks.tabsQuery).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(storedState).toMatchObject({ isRecording: true, phase: 'recording', runId: 'run-1', tabId: 4 });
    expect(storedState.recoverableError).toBeNull();
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 4, allFrames: true } }),
    );
  });

  it('returns to the tab it came from when the now-active tab cannot be recorded', async () => {
    await followIntoOtherTabThenClose(NEW_TAB_PAGE);

    expect(storedState).toMatchObject({ isRecording: true, runId: 'run-1', tabId: 4 });
    expect(mocks.executeScript).toHaveBeenCalledTimes(1);
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 4, allFrames: true } }),
    );
  });

  it('ends the run only when there is nowhere to continue', async () => {
    await importBackground();
    await flushAsyncWork();
    mocks.tabsQuery.mockResolvedValue([NEW_TAB_PAGE]);
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === NEW_TAB_PAGE.id) return NEW_TAB_PAGE;
      throw new Error(`No tab with id: ${tabId}.`);
    });

    await closeTab(4);

    expect(storedState).toMatchObject({ isRecording: false, phase: 'error', tabId: null });
    expect(storedState.recoverableError?.code).toBe('RECORDED_TAB_CLOSED');
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('ends a single-tab run (no <all_urls> grant) when its tab closes', async () => {
    mocks.permissionsContains.mockResolvedValue(false);
    mocks.tabsQuery.mockResolvedValue([OTHER_TAB]);
    await importBackground();
    await flushAsyncWork();

    await closeTab(4);

    expect(storedState.isRecording).toBe(false);
    expect(storedState.recoverableError?.code).toBe('RECORDED_TAB_CLOSED');
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('ends a captured snapshot run when its tab closes, even with somewhere to go', async () => {
    storedState = recordingState({ mode: 'snapshot', groupAnchorId: 'anchor-1' });
    mocks.getStep.mockResolvedValue({
      id: 'anchor-1',
      sessionId: 'project-a',
      groupId: 'anchor-1',
      url: 'https://example.com/flow',
      screenshotBlob: new Blob(['image']),
    });
    mocks.tabsQuery.mockResolvedValue([OTHER_TAB]);
    await importBackground();
    await flushAsyncWork();

    await closeTab(4);

    expect(storedState.isRecording).toBe(false);
    expect(storedState.recoverableError?.code).toBe('RECORDED_TAB_CLOSED');
  });

  it('ignores the closing of a tab the run does not live in', async () => {
    await importBackground();
    await flushAsyncWork();

    await closeTab(9);

    expect(storedState).toMatchObject({ isRecording: true, tabId: 4 });
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('following a blank tab once it loads a page', () => {
  const LOADED_TAB = { id: 9, windowId: 2, active: true, url: 'https://typed.example/' };

  it('follows the focused window\'s active tab when it finishes loading a recordable URL', async () => {
    mocks.tabsQuery.mockResolvedValue([LOADED_TAB]);
    mocks.tabsGet.mockImplementation(async (tabId: number) => (tabId === 9 ? LOADED_TAB : RECORDED_TAB));
    await importBackground();
    await flushAsyncWork();

    // Ctrl+T: the blank tab is activated first, which cannot be followed.
    mocks.tabsGet.mockImplementationOnce(async () => ({ ...LOADED_TAB, url: 'chrome://newtab/' }));
    await activateTab(9);
    expect(storedState.tabId).toBe(4);

    // The user types a URL and it loads.
    mocks.tabUpdatedListener?.(9, { status: 'complete' }, LOADED_TAB);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(mocks.tabsQuery).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(storedState.tabId).toBe(9);
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 9, allFrames: true } }),
    );
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(4, { type: 'STEPMARK_STOP' });
  });

  it('never follows a page loading in a window the user is not in', async () => {
    // Tab 9 is active in its own window, but another window holds focus.
    mocks.tabsQuery.mockResolvedValue([{ id: 30, windowId: 3, active: true, url: 'https://focused.example/' }]);
    mocks.tabsGet.mockImplementation(async (tabId: number) => (tabId === 9 ? LOADED_TAB : RECORDED_TAB));
    await importBackground();
    await flushAsyncWork();

    mocks.tabUpdatedListener?.(9, { status: 'complete' }, LOADED_TAB);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(storedState.tabId).toBe(4);
    expect(mocks.executeScript).not.toHaveBeenCalled();
  });

  it('does no follow work for page loads while nothing is recording', async () => {
    storedState = makeRecordingState();
    await importBackground();
    await flushAsyncWork();

    mocks.tabUpdatedListener?.(9, { status: 'complete' }, LOADED_TAB);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(mocks.tabsQuery).not.toHaveBeenCalled();
    expect(mocks.permissionsContains).not.toHaveBeenCalled();
  });

  it('ignores a background tab finishing its load', async () => {
    await importBackground();
    await flushAsyncWork();

    mocks.tabUpdatedListener?.(9, { status: 'complete' }, { ...LOADED_TAB, active: false });
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(mocks.tabsQuery).not.toHaveBeenCalled();
    expect(storedState.tabId).toBe(4);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';
import { type Step } from '@/lib/storage/models';
import { itemAt } from '../setup/item-at';

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

function awaitingTargetState(): RecordingState {
  return makeRecordingState({
    operation: 'recapture',
    recapture: {
      runId: 'recapture-1',
      sessionId: 'project-a',
      target: { kind: 'single', stepId: 'step-1' },
      entryId: 'step-1',
      phase: 'awaiting-target',
      sourceTabId: 11,
      sourceWindowId: 5,
      sourceUrl: 'https://persisted.example/path',
      sourceTabCreated: true,
      startedAt: 1,
    },
  });
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: 'project-a',
    order: 0,
    screenshotBlob: new Blob(['image']),
    bounds: { x: 1, y: 2, width: 30, height: 40 },
    devicePixelRatio: 2,
    screenshotScale: 2,
    description: 'Persisted step',
    url: 'https://persisted.example/path',
    timestamp: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messageListener = null;
  mocks.getRecordingState.mockResolvedValue(makeRecordingState());
  mocks.setRecordingState.mockResolvedValue(undefined);
  mocks.getSteps.mockResolvedValue([]);
  mocks.storeStep.mockResolvedValue(undefined);
  mocks.deleteStep.mockResolvedValue(undefined);
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.tabsRemove.mockResolvedValue(undefined);
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.savePendingUndoRecord.mockResolvedValue(undefined);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
});

describe('service-worker startup recovery for recording runs', () => {
  it('settles a persisted run whose recorded tab no longer exists', async () => {
    mocks.getRecordingState.mockResolvedValue(recordingState());
    mocks.tabsGet.mockRejectedValue(new Error('No tab with id: 4.'));

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: null,
          isRecording: false,
          phase: 'error',
          tabId: null,
          recoverableError: expect.objectContaining({ code: 'RECORDED_TAB_CLOSED' }),
        }),
      );
    });
  });

  it('keeps a steps run waiting when the worker restarts while its tab shows a restricted page', async () => {
    // The worker idles out while the run waits on a browser page (no recorder there keeps it alive); waking up must not end the run.
    mocks.getRecordingState.mockResolvedValue(recordingState());
    mocks.permissionsContains.mockResolvedValue(true);
    mocks.tabsGet.mockResolvedValue({ id: 4, url: 'chrome://newtab/' });

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: true,
          phase: 'recording',
          tabId: 4,
          recoverableError: expect.objectContaining({ code: 'RECORDING_WAITING_RESTRICTED_PAGE' }),
        }),
      );
    });
    expect(mocks.setRecordingState).not.toHaveBeenCalledWith(expect.objectContaining({ isRecording: false }));
  });

  it('settles a snapshot run whose tab id now names a restricted page', async () => {
    mocks.getRecordingState.mockResolvedValue(recordingState({ mode: 'snapshot', phase: 'preparing-next' }));
    mocks.tabsGet.mockResolvedValue({ id: 4, url: 'chrome://newtab/' });

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          recoverableError: expect.objectContaining({ code: 'RECORDED_TAB_CLOSED' }),
        }),
      );
    });
  });

  it('hands a following run to the active tab when its tab closed while the worker was down', async () => {
    let stored = recordingState();
    mocks.getRecordingState.mockImplementation(async () => stored);
    mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
      stored = next;
    });
    mocks.permissionsContains.mockResolvedValue(true);
    mocks.executeScript.mockResolvedValue([]);
    const activeTab = { id: 9, windowId: 1, active: true, url: 'https://example.com/other' };
    mocks.tabsQuery.mockResolvedValue([activeTab]);
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === 9) return activeTab;
      throw new Error(`No tab with id: ${tabId}.`);
    });

    await importBackground();

    await vi.waitFor(() => expect(stored.tabId).toBe(9));
    expect(stored).toMatchObject({ isRecording: true, runId: 'run-1', phase: 'recording' });
    expect(mocks.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 9, allFrames: true } }));
  });

  it('keeps a run whose recorded tab is still intact', async () => {
    mocks.getRecordingState.mockResolvedValue(recordingState());
    mocks.tabsGet.mockResolvedValue({ id: 4, url: 'https://example.com/flow' });

    await importBackground();
    await vi.waitFor(() => expect(mocks.tabsGet).toHaveBeenCalledWith(4));
    await flushAsyncWork();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('settles a snapshot run whose tab no longer shows the anchor document', async () => {
    mocks.getRecordingState.mockResolvedValue(
      recordingState({ mode: 'snapshot', groupAnchorId: 'anchor-1' }),
    );
    mocks.getStep.mockResolvedValue(step({ id: 'anchor-1', groupId: 'anchor-1', url: 'https://a.example/page' }));
    mocks.getSteps.mockResolvedValue([
      step({ id: 'anchor-1', groupId: 'anchor-1', url: 'https://a.example/page' }),
      step({ id: 'mark-1', groupId: 'anchor-1', url: 'https://a.example/page' }),
    ]);
    mocks.tabsGet.mockResolvedValue({ id: 4, url: 'https://b.example/other' });

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          phase: 'error',
          recoverableError: expect.objectContaining({ code: 'RECORDED_TAB_CLOSED' }),
        }),
      );
    });
  });
});

describe('service-worker startup recovery for awaiting-target recaptures', () => {
  it('fails a recapture whose source tab is gone and closes out its state', async () => {
    mocks.getRecordingState.mockResolvedValue(awaitingTargetState());
    mocks.tabsGet.mockRejectedValue(new Error('No tab with id: 11.'));

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: null,
          recapture: null,
          recaptureResult: expect.objectContaining({
            runId: 'recapture-1',
            status: 'failed',
            errorCode: 'SOURCE_TAB_CLOSED',
          }),
        }),
      );
    });
  });

  it('fails a recapture whose source tab navigated away from the armed page', async () => {
    mocks.getRecordingState.mockResolvedValue(awaitingTargetState());
    mocks.tabsGet.mockResolvedValue({ id: 11, url: 'https://elsewhere.example/' });

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          recaptureResult: expect.objectContaining({ status: 'failed', errorCode: 'SOURCE_TAB_CLOSED' }),
        }),
      );
    });
  });

  it('keeps an awaiting-target recapture whose source tab is intact', async () => {
    mocks.getRecordingState.mockResolvedValue(awaitingTargetState());
    mocks.tabsGet.mockResolvedValue({ id: 11, url: 'https://persisted.example/path' });

    await importBackground();
    await vi.waitFor(() => expect(mocks.tabsGet).toHaveBeenCalledWith(11));
    await flushAsyncWork();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('recapture source tab leak cleanup', () => {
  const editorSender = {
    frameId: 0,
    url: 'chrome-extension://extension-id/editor.html?sessionId=project-a',
    tab: { id: 7, windowId: 3, url: 'chrome-extension://extension-id/editor.html?sessionId=project-a' },
  };

  it('closes a created source tab when the exact-URL recheck fails after load', async () => {
    mocks.getStep.mockResolvedValue(step());
    mocks.getSteps.mockResolvedValue([step()]);
    mocks.permissionsContains.mockResolvedValue(true);
    mocks.tabsQuery.mockResolvedValue([]);
    mocks.tabsCreate.mockResolvedValue({ id: 42 });
    // The created tab finished loading on a redirected URL.
    mocks.tabsGet.mockResolvedValue({
      id: 42,
      windowId: 5,
      status: 'complete',
      url: 'https://redirected.example/elsewhere',
    });

    await importBackground();
    const result = await mocks.messageListener?.({
      type: 'START_STEP_RECAPTURE',
      sessionId: 'project-a',
      target: { kind: 'single', stepId: 'step-1' },
    }, editorSender);

    expect(result).toMatchObject({ ok: false, code: 'SOURCE_TAB_FAILED' });
    expect(mocks.tabsRemove).toHaveBeenCalledWith(42);
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('undo window persistence across worker restarts', () => {
  it('persists the removed step before deleting it from the project', async () => {
    mocks.getRecordingState.mockResolvedValue(recordingState({ itemCount: 1 }));
    mocks.getSteps.mockResolvedValue([step({ runId: 'run-1' })]);

    await importBackground();
    const result = await mocks.messageListener?.(
      { type: 'UNDO_LAST_CAPTURE', runId: 'run-1' },
      { frameId: 0, url: 'chrome-extension://extension-id/popup.html' },
    ) as { ok: boolean; undoToken?: string };

    expect(result).toMatchObject({ ok: true });
    expect(mocks.savePendingUndoRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        expectedItemCount: 0,
        step: expect.objectContaining({ id: 'step-1' }),
      }),
    );
    expect(mocks.deleteStep).toHaveBeenCalledWith('step-1');
    const saveOrder = mocks.savePendingUndoRecord.mock.invocationCallOrder[0];
    const deleteOrder = itemAt(mocks.deleteStep.mock.invocationCallOrder, 0);
    expect(saveOrder).toBeLessThan(deleteOrder);
  });

  it('rehydrates a persisted undo window at startup so restore still works', async () => {
    const record = {
      token: 'undo-token',
      runId: 'run-1',
      step: step({ runId: 'run-1' }),
      expectedItemCount: 0,
      expiresAt: Date.now() + 5_000,
    };
    mocks.readPendingUndoRecord.mockResolvedValue(record);
    mocks.getRecordingState.mockResolvedValue(recordingState({ itemCount: 0 }));

    await importBackground();
    const result = await mocks.messageListener?.(
      { type: 'RESTORE_LAST_CAPTURE', runId: 'run-1', undoToken: 'undo-token' },
      { frameId: 0, url: 'chrome-extension://extension-id/popup.html' },
    );

    expect(result).toMatchObject({ ok: true });
    expect(mocks.storeStep).toHaveBeenCalledWith(record.step);
    expect(mocks.clearPendingUndoRecord).toHaveBeenCalled();
  });

  it('hard-deletes an expired persisted undo window at startup', async () => {
    mocks.readPendingUndoRecord.mockResolvedValue({
      token: 'undo-token',
      runId: 'run-1',
      step: step({ runId: 'run-1' }),
      expectedItemCount: 0,
      expiresAt: Date.now() - 1,
    });
    mocks.getRecordingState.mockResolvedValue(recordingState({ itemCount: 0 }));

    await importBackground();

    await vi.waitFor(() => expect(mocks.clearPendingUndoRecord).toHaveBeenCalled());
    expect(mocks.storeStep).not.toHaveBeenCalled();
  });
});

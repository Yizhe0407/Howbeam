import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';
import { type Step } from '@/lib/storage/models';

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

const popupSender = { frameId: 0, url: 'chrome-extension://extension-id/popup.html' };
const recorderSender = {
  frameId: 0,
  url: 'https://example.com/flow',
  tab: { id: 4, windowId: 2, url: 'https://example.com/flow' },
};

const VIEWPORT = { width: 1280, height: 800, scrollX: 0, scrollY: 0 };

function snapshotState(overrides: Partial<RecordingState> = {}): RecordingState {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    mode: 'snapshot',
    sessionId: 'project-a',
    tabId: 4,
    runId: 'run-1',
    itemCount: 2,
    groupAnchorId: 'anchor-1',
    snapshotViewport: VIEWPORT,
    snapshotDevicePixelRatio: 2,
    ...overrides,
  });
}

function stepsState(overrides: Partial<RecordingState> = {}): RecordingState {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    mode: 'steps',
    sessionId: 'project-a',
    tabId: 4,
    runId: 'run-1',
    itemCount: 1,
    ...overrides,
  });
}

function capturingRecaptureState(): RecordingState {
  return makeRecordingState({
    operation: 'recapture',
    recapture: {
      runId: 'recapture-1',
      sessionId: 'project-a',
      target: { kind: 'single', stepId: 'step-1' },
      entryId: 'step-1',
      phase: 'capturing',
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
    runId: 'run-1',
    order: 0,
    screenshotBlob: new Blob(['image']),
    bounds: { x: 1, y: 2, width: 30, height: 40 },
    devicePixelRatio: 2,
    screenshotScale: 2,
    description: 'Persisted step',
    url: 'https://example.com/flow',
    timestamp: 1,
    ...overrides,
  };
}

function anchorStep(): Step {
  return step({ id: 'anchor-1', groupId: 'anchor-1', bounds: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messageListener = null;
  mocks.tabUpdatedListener = null;
  mocks.getRecordingState.mockResolvedValue(makeRecordingState());
  mocks.setRecordingState.mockResolvedValue(undefined);
  mocks.getStep.mockResolvedValue(undefined);
  mocks.getSteps.mockResolvedValue([]);
  mocks.storeStep.mockResolvedValue(undefined);
  mocks.deleteStep.mockResolvedValue(undefined);
  mocks.tabsGet.mockResolvedValue({ id: 4, windowId: 2, url: 'https://example.com/flow' });
  mocks.tabsQuery.mockResolvedValue([]);
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.tabsRemove.mockResolvedValue(undefined);
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
  mocks.executeScript.mockResolvedValue(undefined);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.savePendingUndoRecord.mockResolvedValue(undefined);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
});

describe('SNAPSHOT_INVALIDATED handling', () => {
  beforeEach(() => {
    mocks.getStep.mockResolvedValue(anchorStep());
  });

  it('invalidates the run once when the reported viewport no longer matches', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    await importBackground();
    await flushAsyncWork();

    const result = await mocks.messageListener?.(
      {
        type: 'SNAPSHOT_INVALIDATED',
        runId: 'run-1',
        viewport: { ...VIEWPORT, width: 999 },
        devicePixelRatio: 2,
      },
      recorderSender,
    );

    expect(result).toBe(true);
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'invalidated',
        recoverableError: expect.objectContaining({ code: 'SNAPSHOT_VIEWPORT_CHANGED' }),
      }),
    );
  });

  it('answers true idempotently when the atomic claim finds the run already invalidated', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    await importBackground();
    await flushAsyncWork();

    // The atomic claim's re-read finds the run already invalidated concurrently; the handler must still report success without a second state write.
    mocks.getRecordingState
      .mockResolvedValueOnce(snapshotState())
      .mockResolvedValueOnce(snapshotState({ phase: 'invalidated' }));
    const result = await mocks.messageListener?.(
      {
        type: 'SNAPSHOT_INVALIDATED',
        runId: 'run-1',
        viewport: { ...VIEWPORT, width: 999 },
        devicePixelRatio: 2,
      },
      recorderSender,
    );

    expect(result).toBe(true);
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('rejects an invalidation whose viewport still matches the anchor', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    await importBackground();
    await flushAsyncWork();

    const result = await mocks.messageListener?.(
      { type: 'SNAPSHOT_INVALIDATED', runId: 'run-1', viewport: { ...VIEWPORT }, devicePixelRatio: 2 },
      recorderSender,
    );

    expect(result).toBe(false);
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('rebuild-invalidated-snapshot failure rollback', () => {
  it('restores the invalidated phase, counters and anchor, and re-injects the toolbar', async () => {
    mocks.getStep.mockResolvedValue(anchorStep());
    mocks.getRecordingState.mockResolvedValue(
      snapshotState({ phase: 'invalidated', itemCount: 3 }),
    );
    await importBackground();
    await flushAsyncWork();

    mocks.tabsGet.mockRejectedValueOnce(new Error('boom'));
    const result = await mocks.messageListener?.(
      { type: 'REBUILD_INVALIDATED_SNAPSHOT', runId: 'run-1' },
      popupSender,
    );

    expect(result).toEqual({ ok: false, error: '無法重建快照，請重試。' });
    // The claim first cleared run-scoped fields into 'starting'; the rollback must restore every one of them.
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'starting', itemCount: 0, groupAnchorId: null }),
    );
    expect(mocks.setRecordingState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'invalidated',
        itemCount: 3,
        groupAnchorId: 'anchor-1',
        snapshotViewport: VIEWPORT,
        snapshotDevicePixelRatio: 2,
        recoverableError: expect.objectContaining({ code: 'REBUILD_SNAPSHOT_FAILED' }),
      }),
    );
    // Toolbar re-injection fallback so the page is not left without controls.
    expect(mocks.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ tabId: 4 }) }),
    );
  });
});

describe('undo/restore lost-CAS compensation', () => {
  it('re-adds the removed step when the undo state write loses the race', async () => {
    const removed = step();
    mocks.getRecordingState.mockResolvedValue(stepsState());
    mocks.getSteps.mockResolvedValue([removed]);
    await importBackground();
    await flushAsyncWork();

    mocks.getRecordingState
      .mockResolvedValueOnce(stepsState())
      // The conditional write re-reads the state and finds the run gone.
      .mockResolvedValueOnce(makeRecordingState());
    const result = await mocks.messageListener?.(
      { type: 'UNDO_LAST_CAPTURE', runId: 'run-1' },
      popupSender,
    );

    expect(result).toMatchObject({ ok: false });
    expect(mocks.deleteStep).toHaveBeenCalledWith('step-1');
    expect(mocks.storeStep).toHaveBeenCalledWith(removed);
    const deleteOrder = mocks.deleteStep.mock.invocationCallOrder[0];
    const addOrder = mocks.storeStep.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(addOrder);
    // The undo window is over: its persisted copy must be hard-deleted.
    expect(mocks.clearPendingUndoRecord).toHaveBeenCalled();
  });

  it('re-deletes the restored step when the restore state write loses the race', async () => {
    const record = {
      token: 'undo-token',
      runId: 'run-1',
      step: step(),
      expectedItemCount: 0,
      expiresAt: Date.now() + 5_000,
    };
    mocks.readPendingUndoRecord.mockResolvedValue(record);
    mocks.getRecordingState.mockResolvedValue(stepsState({ itemCount: 0 }));
    await importBackground();
    await flushAsyncWork();

    mocks.getRecordingState
      .mockResolvedValueOnce(stepsState({ itemCount: 0 }))
      .mockResolvedValueOnce(makeRecordingState());
    const result = await mocks.messageListener?.(
      { type: 'RESTORE_LAST_CAPTURE', runId: 'run-1', undoToken: 'undo-token' },
      popupSender,
    );

    expect(result).toMatchObject({ ok: false });
    expect(mocks.storeStep).toHaveBeenCalledWith(record.step);
    expect(mocks.deleteStep).toHaveBeenCalledWith('step-1');
    const addOrder = mocks.storeStep.mock.invocationCallOrder[0];
    const deleteOrder = mocks.deleteStep.mock.invocationCallOrder[0];
    expect(addOrder).toBeLessThan(deleteOrder);
  });
});

describe('capturing-phase recapture recovery fork', () => {
  it('settles as replaced when the durable capture marker proves the commit landed', async () => {
    mocks.getRecordingState.mockResolvedValue(capturingRecaptureState());
    mocks.getStep.mockResolvedValue(step({ lastCaptureRunId: 'recapture-1' }));

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: null,
          recapture: null,
          recaptureResult: expect.objectContaining({ runId: 'recapture-1', status: 'replaced' }),
        }),
      );
    });
  });

  it('settles as WORKER_RESTARTED when no durable capture marker exists', async () => {
    mocks.getRecordingState.mockResolvedValue(capturingRecaptureState());
    mocks.getStep.mockResolvedValue(step());

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          recaptureResult: expect.objectContaining({ status: 'failed', errorCode: 'WORKER_RESTARTED' }),
        }),
      );
    });
  });
});

describe('live SOURCE_NAVIGATED leg through tabs.onUpdated', () => {
  it('fails an awaiting-target recapture when its source tab starts navigating', async () => {
    mocks.getRecordingState.mockResolvedValue(
      makeRecordingState({
        operation: 'recapture',
        recapture: {
          ...capturingRecaptureState().recapture!,
          phase: 'awaiting-target',
        },
      }),
    );
    mocks.tabsGet.mockResolvedValue({ id: 11, url: 'https://persisted.example/path' });
    await importBackground();
    await flushAsyncWork();
    expect(mocks.setRecordingState).not.toHaveBeenCalled();

    mocks.tabUpdatedListener?.(11, { status: 'loading' }, { id: 11 });

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: null,
          recapture: null,
          recaptureResult: expect.objectContaining({ status: 'failed', errorCode: 'SOURCE_NAVIGATED' }),
        }),
      );
    });
    // The flow owned the created source tab, so failing must close it.
    await vi.waitFor(() => expect(mocks.tabsRemove).toHaveBeenCalledWith(11));
  });
});

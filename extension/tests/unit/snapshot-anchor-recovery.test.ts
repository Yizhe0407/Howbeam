import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';
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

const PAGE_URL = 'https://site.example/page';

function snapshotState(overrides: Partial<RecordingState> = {}): RecordingState {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    sessionId: 'project-a',
    tabId: 4,
    runId: 'run-1',
    mode: 'snapshot',
    groupAnchorId: 'anchor-1',
    ...overrides,
  });
}

function anchorStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'anchor-1',
    sessionId: 'project-a',
    runId: 'run-1',
    order: 0,
    screenshotBlob: new Blob(['base-image']),
    bounds: null,
    devicePixelRatio: 2,
    screenshotScale: 2,
    description: '',
    url: PAGE_URL,
    timestamp: 1,
    groupId: 'anchor-1',
    numbered: true,
    ...overrides,
  };
}

const recordedPageSender = {
  frameId: 0,
  url: PAGE_URL,
  tab: { id: 4, windowId: 6, url: PAGE_URL },
};

function clickMessage(): Record<string, unknown> {
  return {
    type: 'STEPMARK_CLICK',
    captureKind: 'element',
    captureId: 'capture-1',
    runId: 'run-1',
    rect: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 2,
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    text: 'Save',
    tagName: 'BUTTON',
    intent: 'mark',
    url: PAGE_URL,
    timestamp: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messageListener = null;
  mocks.getRecordingState.mockResolvedValue(makeRecordingState());
  mocks.setRecordingState.mockResolvedValue(undefined);
  mocks.getStep.mockResolvedValue(undefined);
  mocks.getSteps.mockResolvedValue([]);
  mocks.storeStep.mockResolvedValue(undefined);
  mocks.deleteStep.mockResolvedValue(undefined);
  mocks.tabsGet.mockResolvedValue({ id: 4, windowId: 6, url: PAGE_URL });
  mocks.tabsQuery.mockResolvedValue([]);
  mocks.tabsCreate.mockResolvedValue({ id: 99 });
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
});

describe('startup recovery validates the snapshot anchor', () => {
  it('settles a run recovered into phase recording whose anchor row is gone', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(undefined);

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: null,
          isRecording: false,
          phase: 'error',
          groupAnchorId: null,
          recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
        }),
      );
    });
  });

  it('settles a run whose anchor row lost its base image', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(anchorStep({ screenshotBlob: undefined }));

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
        }),
      );
    });
  });

  it('settles a snapshot run recovered into phase recording without an anchor id', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState({ groupAnchorId: null }));

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
        }),
      );
    });
  });

  it('settles a run interrupted mid-finish after its empty anchor was deleted', async () => {
    // finishRecording used to delete the empty anchor before the final state
    // write; a service-worker death in between persisted phase 'finishing'
    // with a groupAnchorId whose row is gone — a zombie that accepted clicks.
    mocks.getRecordingState.mockResolvedValue(snapshotState({ phase: 'finishing' }));
    mocks.getStep.mockResolvedValue(undefined);

    await importBackground();

    await vi.waitFor(() => {
      expect(mocks.setRecordingState).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: false,
          phase: 'error',
          recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
        }),
      );
    });
  });

  it('keeps a healthy snapshot run whose anchor and base image are intact', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(anchorStep());

    await importBackground();
    await vi.waitFor(() => expect(mocks.getStep).toHaveBeenCalledWith('anchor-1'));
    await flushAsyncWork();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('keeps a preparing-next run, whose anchor is legitimately absent', async () => {
    mocks.getRecordingState.mockResolvedValue(
      snapshotState({ phase: 'preparing-next', groupAnchorId: null }),
    );

    await importBackground();
    await vi.waitFor(() => expect(mocks.tabsGet).toHaveBeenCalledWith(4));
    await flushAsyncWork();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('a click that wakes the worker over a stale persisted run', () => {
  it('queues behind startup recovery, which settles the run silently instead of the in-click anchor settle', async () => {
    // The user's bfcache-restored recorder fires a click that wakes the
    // service worker. Startup recovery must win: the run is settled once by
    // recovery and the click is rejected quietly — never the louder
    // "snapshot anchor is gone; settling the run" in-click path.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let releaseTabGet!: (tab: { id: number; windowId: number; url: string }) => void;
    mocks.tabsGet.mockImplementation(() => new Promise((resolve) => {
      releaseTabGet = resolve;
    }));
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(undefined);
    mocks.getSteps.mockResolvedValue([]);

    await importBackground();
    // Recovery is still blocked on tabs.get when the click arrives.
    const pendingClick = mocks.messageListener?.(clickMessage(), recordedPageSender) as Promise<unknown>;
    releaseTabGet({ id: 4, windowId: 6, url: PAGE_URL });

    expect(await pendingClick).toMatchObject({ ok: false });
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({
        isRecording: false,
        phase: 'error',
        recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
      }),
    );
    expect(mocks.setRecordingState).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('snapshot anchor is gone'),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });
});

describe('annotation clicks against a run whose anchor disappeared mid-run', () => {
  it('settles the run once with a recoverable error instead of a per-click error', async () => {
    // Recovery sees a healthy anchor at startup; the row disappears afterwards
    // (e.g. deleted through the editor while the run was still live).
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(anchorStep());

    await importBackground();
    await flushAsyncWork();
    mocks.setRecordingState.mockClear();
    mocks.getStep.mockResolvedValue(undefined);

    const result = await mocks.messageListener?.(clickMessage(), recordedPageSender);

    expect(result).toMatchObject({ ok: false });
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: null,
        isRecording: false,
        phase: 'error',
        groupAnchorId: null,
        runId: null,
        recoverableError: expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
      }),
    );
    // The recorder in the tab is torn down so the user is not left clicking
    // into a shield whose run is already broken.
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(4, { type: 'STEPMARK_STOP' });
  });
});

describe('empty-anchor cleanup ordering in finishRecording', () => {
  it('deletes the empty anchor only after the run state stopped referencing it', async () => {
    mocks.getRecordingState.mockResolvedValue(snapshotState());
    mocks.getStep.mockResolvedValue(anchorStep());
    mocks.getSteps.mockResolvedValue([anchorStep()]);

    await importBackground();
    await flushAsyncWork();
    mocks.setRecordingState.mockClear();
    mocks.deleteStep.mockClear();

    const result = await mocks.messageListener?.(
      { type: 'FINISH_RECORDING', runId: 'run-1' },
      { frameId: 0, url: 'chrome-extension://extension-id/popup.html' },
    );

    expect(result).toMatchObject({ ok: true });
    expect(mocks.deleteStep).toHaveBeenCalledWith('anchor-1');
    const stopWriteIndex = mocks.setRecordingState.mock.calls.findIndex(
      ([state]) => (state as RecordingState).isRecording === false,
    );
    expect(stopWriteIndex).toBeGreaterThanOrEqual(0);
    const stopOrder = mocks.setRecordingState.mock.invocationCallOrder[stopWriteIndex];
    const deleteOrder = mocks.deleteStep.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(deleteOrder);
  });
});

describe('annotation failures shown to the user', () => {
  it('stores the localized reason verbatim, never as "Error: …"', async () => {
    const { zhTW } = await import('@/lib/shared/i18n/messages/zh-TW');
    let stored = snapshotState();
    mocks.getRecordingState.mockImplementation(async () => stored);
    mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
      stored = next;
    });
    // The anchor was taken on another page than the one the click comes from.
    mocks.getStep.mockResolvedValue(anchorStep());
    silenceIntentionalErrorLogs();

    await importBackground();
    await flushAsyncWork();
    mocks.getStep.mockResolvedValue(anchorStep({ url: 'https://site.example/other' }));
    const result = await mocks.messageListener?.(clickMessage(), recordedPageSender);

    expect(result).toMatchObject({ ok: false });
    expect(stored.error).toBe(zhTW.background.annotationSkippedPageChanged);
    expect(stored.recoverableError?.message).toBe(zhTW.background.annotationSkippedPageChanged);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { createControlPlane } from '@/lib/recording/background/control-plane';
import { createCaptureFlow, type CaptureFlow } from '@/lib/recording/background/capture-flow';
import { createRunState } from '@/lib/recording/background/run-state';
import { cancelCapture } from '@/lib/recording/background/capture-registry';
import type { ClickCapture } from '@/lib/runtime/messages';
import type { Step } from '@/lib/storage/models';
import type { RecordingState } from '@/lib/storage/recording-state';
import { t } from '@/lib/shared/i18n';
import { makeRecordingState } from '../setup/recording-state';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

/**
 * The capture flow runs against the real control plane, run-state writes,
 * capture registry, capture queue and sender guards; only the browser APIs,
 * the step repository and the recorder runtime's image helpers are mocked.
 * Recording state is a live in-memory cell, so each test asserts on what the
 * flow actually persisted.
 */

const mocks = await vi.hoisted(async () =>
  (await import('../setup/background-test-utils')).makeBackgroundMocks());

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));

const PAGE_URL = 'https://site.example/page';
const SESSION_ID = 'project-a';
const RUN_ID = 'run-1';
const TAB_ID = 4;
const WINDOW_ID = 6;
const VIEWPORT = { width: 1280, height: 720, scrollX: 0, scrollY: 0 };

function sender(overrides: { frameId?: number; tabId?: number; windowId?: number } = {}): Browser.runtime.MessageSender {
  return {
    frameId: overrides.frameId ?? 0,
    url: PAGE_URL,
    tab: { id: overrides.tabId ?? TAB_ID, windowId: overrides.windowId ?? WINDOW_ID, url: PAGE_URL },
  } as unknown as Browser.runtime.MessageSender;
}

function click(overrides: Partial<ClickCapture> = {}): ClickCapture {
  return {
    type: 'STEPMARK_CLICK',
    captureKind: 'element',
    captureId: 'capture-1',
    runId: RUN_ID,
    rect: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 2,
    viewport: VIEWPORT,
    text: 'Save',
    tagName: 'BUTTON',
    intent: 'mark',
    url: PAGE_URL,
    timestamp: 123,
    ...overrides,
  } as ClickCapture;
}

function liveRun(overrides: Partial<RecordingState> = {}): RecordingState {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    mode: 'steps',
    sessionId: SESSION_ID,
    runId: RUN_ID,
    tabId: TAB_ID,
    itemCount: 2,
    ...overrides,
  });
}

function snapshotRun(overrides: Partial<RecordingState> = {}): RecordingState {
  return liveRun({
    mode: 'snapshot',
    groupAnchorId: 'anchor-1',
    snapshotViewport: VIEWPORT,
    snapshotDevicePixelRatio: 2,
    ...overrides,
  });
}

function anchor(overrides: Partial<Step> = {}): Step {
  return {
    id: 'anchor-1',
    sessionId: SESSION_ID,
    runId: RUN_ID,
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

interface Harness {
  flow: CaptureFlow;
  control: ReturnType<typeof createControlPlane>;
  getState: () => RecordingState;
  setState: (state: RecordingState) => void;
  captureVisibleTabWithRetry: ReturnType<typeof vi.fn>;
  stopRunWithError: ReturnType<typeof vi.fn>;
  handleRecordedTabGone: ReturnType<typeof vi.fn>;
  discardPendingUndo: ReturnType<typeof vi.fn>;
}

let harness: Harness;

function createHarness(): Harness {
  let state = liveRun();
  mocks.getRecordingState.mockImplementation(async () => state);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    state = next;
  });

  const discardPendingUndo = vi.fn();
  const control = createControlPlane({ discardPendingUndo });
  const captureVisibleTabWithRetry = vi.fn().mockResolvedValue('data:image/png;base64,AAAA');
  const stopRunWithError = vi.fn().mockResolvedValue(undefined);
  const handleRecordedTabGone = vi.fn().mockResolvedValue(undefined);
  const flow = createCaptureFlow({
    control,
    runtime: {
      injectRecorder: vi.fn(),
      stopRecorderInTab: vi.fn(),
      captureVisibleTabWithRetry,
      dataUrlToBlob: vi.fn().mockResolvedValue(new Blob(['shot'])),
      getScreenshotScale: vi.fn().mockResolvedValue(2),
    } as unknown as Parameters<typeof createCaptureFlow>[0]['runtime'],
    runState: createRunState({ control }),
    stopRunWithError,
    handleRecordedTabGone,
    discardPendingUndo,
  });

  return {
    flow,
    control,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    captureVisibleTabWithRetry,
    stopRunWithError,
    handleRecordedTabGone,
    discardPendingUndo,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSteps.mockResolvedValue([]);
  mocks.storeStep.mockResolvedValue(undefined);
  mocks.deleteStep.mockResolvedValue(undefined);
  mocks.tabsQuery.mockResolvedValue([{ id: TAB_ID, url: PAGE_URL }]);
  mocks.tabsSendMessage.mockResolvedValue(true);
  mocks.executeScript.mockResolvedValue([]);
  mocks.insertCSS.mockResolvedValue(undefined);
  harness = createHarness();
});

const handle = (message = click(), from = sender()) =>
  harness.flow.handleClick(message, from, harness.control.controlVersion);

describe('handleClick in a steps run', () => {
  it('stores the step and counts it on the run', async () => {
    harness.setState(liveRun({ error: 'old', recoverableError: { code: 'CAPTURE_FAILED', message: 'old' } }));
    mocks.getSteps.mockResolvedValue([anchor({ id: 'earlier', groupId: undefined })]);

    await expect(handle()).resolves.toEqual({ ok: true });

    expect(harness.discardPendingUndo).toHaveBeenCalledTimes(1);
    expect(mocks.storeStep).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION_ID,
      runId: RUN_ID,
      order: 1,
      bounds: click().rect,
      screenshotScale: 2,
      url: PAGE_URL,
      timestamp: 123,
    }));
    expect(harness.getState()).toMatchObject({
      itemCount: 3,
      lastCommittedCaptureId: 'capture-1',
      error: null,
      recoverableError: null,
    });
  });

  it.each([
    ['a stopped run', () => harness.setState(liveRun({ isRecording: false })), 'not-recording'],
    ['another run', () => harness.setState(liveRun({ runId: 'run-2' })), 'not-recording'],
    ['a paused run', () => harness.setState(liveRun({ phase: 'paused' })), 'wrong-phase'],
  ])('turns down a click for %s before any work', async (_label, arrange, error) => {
    arrange();

    await expect(handle()).resolves.toEqual({ ok: false, error });

    expect(harness.captureVisibleTabWithRetry).not.toHaveBeenCalled();
    expect(harness.discardPendingUndo).not.toHaveBeenCalled();
  });

  it('turns down a click sent under an older control version', async () => {
    const version = harness.control.controlVersion;
    harness.control.bumpVersion();

    await expect(harness.flow.handleClick(click(), sender(), version))
      .resolves.toEqual({ ok: false, error: 'stale-control-version' });
  });

  it('turns down a sub-frame or another tab as an untrusted sender', async () => {
    await expect(handle(click(), sender({ frameId: 3 }))).resolves.toEqual({ ok: false, error: 'untrusted-sender' });
    await expect(handle(click(), sender({ tabId: 9 }))).resolves.toEqual({ ok: false, error: 'untrusted-sender' });
    expect(mocks.storeStep).not.toHaveBeenCalled();
  });

  it('stores nothing when control changes while the screenshot is taken, and stays silent', async () => {
    harness.captureVisibleTabWithRetry.mockImplementation(async () => {
      harness.control.bumpVersion();
      return 'data:image/png;base64,AAAA';
    });

    const result = await handle();

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^stale-capture/) });
    expect(result).not.toHaveProperty('reported');
    expect(mocks.storeStep).not.toHaveBeenCalled();
    expect(harness.getState().itemCount).toBe(2);
  });

  it('stores nothing when the gesture is cancelled mid-capture', async () => {
    harness.captureVisibleTabWithRetry.mockImplementation(async () => {
      cancelCapture('capture-1');
      return 'data:image/png;base64,AAAA';
    });

    await expect(handle()).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/^stale-capture/) });
    expect(mocks.storeStep).not.toHaveBeenCalled();
  });

  it('reports a click taken while another tab is active', async () => {
    mocks.tabsQuery.mockResolvedValue([{ id: 99, url: 'https://elsewhere.example/' }]);

    await expect(handle()).resolves.toMatchObject({ ok: false, reported: true });

    expect(harness.getState()).toMatchObject({
      error: t().background.stepSkippedInactiveTab,
      recoverableError: { code: 'CAPTURE_FAILED', message: t().background.stepSkippedInactiveTab },
    });
  });

  it('reports a failed screenshot with localized copy, never the raw browser error', async () => {
    silenceIntentionalErrorLogs();
    harness.captureVisibleTabWithRetry.mockRejectedValue(new Error('Image readback failed'));

    await expect(handle()).resolves.toMatchObject({ ok: false, reported: true });

    expect(harness.getState().error).toBe(t().background.captureFailed);
  });

  it('hands a closed tab to the tab-gone path without writing an error', async () => {
    harness.captureVisibleTabWithRetry.mockRejectedValue(new Error('No tab with id: 4.'));

    await expect(handle()).resolves.toEqual({ ok: false, error: 'tab-closed', reported: true });

    expect(harness.handleRecordedTabGone).toHaveBeenCalledWith(TAB_ID);
    expect(harness.getState().error).toBeNull();
  });

  it('stops accepting clicks when even the failure cannot be recorded', async () => {
    silenceIntentionalErrorLogs();
    harness.captureVisibleTabWithRetry.mockRejectedValue(new Error('Image readback failed'));
    mocks.setRecordingState.mockRejectedValue(new Error('storage quota'));

    const result = await handle();

    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(harness.control.acceptingClicks).toBe(false);
  });
});

describe('handleClick in a snapshot run', () => {
  it('stores an annotation on the anchor without taking a screenshot', async () => {
    harness.setState(snapshotRun());
    mocks.getSteps.mockResolvedValue([anchor()]);

    await expect(handle()).resolves.toEqual({ ok: true });

    expect(harness.captureVisibleTabWithRetry).not.toHaveBeenCalled();
    expect(mocks.storeStep).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'anchor-1',
      order: 1,
      bounds: click().rect,
      screenshotScale: 2,
      numbered: harness.getState().numbered,
    }));
    expect(mocks.storeStep.mock.calls[0][0]).not.toHaveProperty('screenshotBlob');
    expect(harness.getState().itemCount).toBe(3);
  });

  it('invalidates the snapshot when the viewport no longer matches the anchor', async () => {
    harness.setState(snapshotRun());

    await expect(handle(click({ viewport: { ...VIEWPORT, scrollY: 300 } })))
      .resolves.toEqual({ ok: false, error: 'snapshot-viewport-changed', reported: true });

    expect(harness.getState()).toMatchObject({
      phase: 'invalidated',
      recoverableError: { code: 'SNAPSHOT_VIEWPORT_CHANGED' },
    });
    expect(mocks.storeStep).not.toHaveBeenCalled();
  });

  it.each([
    ['the anchor id is gone', () => harness.setState(snapshotRun({ groupAnchorId: null })), [] as Step[]],
    ['the anchor row is gone', () => harness.setState(snapshotRun()), [] as Step[]],
    ['the anchor lost its image', () => harness.setState(snapshotRun()), [anchor({ screenshotBlob: undefined })]],
  ])('settles the run once when %s', async (_label, arrange, steps) => {
    silenceIntentionalErrorLogs();
    arrange();
    mocks.getSteps.mockResolvedValue(steps);

    await expect(handle()).resolves.toEqual({ ok: false, error: 'snapshot-anchor-missing', reported: true });

    expect(harness.stopRunWithError).toHaveBeenCalledWith(
      RUN_ID,
      t().background.snapshotAnchorLost,
      expect.any(Number),
      { code: 'SNAPSHOT_ANCHOR_MISSING', message: t().background.snapshotAnchorLost },
    );
  });

  it('reports an annotation from a page other than the anchor', async () => {
    harness.setState(snapshotRun());
    mocks.getSteps.mockResolvedValue([anchor({ url: 'https://site.example/other' })]);

    await expect(handle()).resolves.toMatchObject({ ok: false, reported: true });

    expect(harness.getState().error).toBe(t().background.annotationSkippedPageChanged);
  });
});

describe('createAndActivateSnapshotAnchor', () => {
  const context = { url: PAGE_URL, viewport: VIEWPORT, devicePixelRatio: 2, timestamp: 7 };

  const create = () => harness.flow.createAndActivateSnapshotAnchor(
    harness.getState(),
    TAB_ID,
    WINDOW_ID,
    context,
    harness.control.controlVersion,
  );

  beforeEach(() => {
    harness.setState(snapshotRun({ phase: 'preparing-next', groupAnchorId: null, snapshotViewport: null, snapshotDevicePixelRatio: null }));
  });

  it('stores the base image, publishes it on the run and activates the recorder', async () => {
    const anchorId = await create();

    expect(mocks.storeStep).toHaveBeenCalledWith(expect.objectContaining({
      id: anchorId,
      groupId: anchorId,
      bounds: null,
      screenshotBlob: expect.any(Blob),
    }));
    expect(harness.getState()).toMatchObject({
      groupAnchorId: anchorId,
      snapshotViewport: VIEWPORT,
      snapshotDevicePixelRatio: 2,
    });
    expect(harness.control.acceptingClicks).toBe(true);
    expect(mocks.tabsSendMessage).toHaveBeenCalledWith(
      TAB_ID,
      { type: 'STEPMARK_SNAPSHOT_ACTIVE', runId: RUN_ID },
      { frameId: 0 },
    );
  });

  it('withdraws and deletes a published anchor the recorder never activated', async () => {
    mocks.tabsSendMessage.mockResolvedValue(false);

    await expect(create()).rejects.toThrow(/could not be activated/);

    const anchorId = mocks.storeStep.mock.calls[0][0].id;
    expect(harness.getState()).toMatchObject({ groupAnchorId: null, snapshotViewport: null });
    expect(mocks.deleteStep).toHaveBeenCalledWith(anchorId);
    expect(harness.control.acceptingClicks).toBe(false);
  });

  it('deletes an unpublished anchor when control changes before it is published', async () => {
    mocks.storeStep.mockImplementation(async () => {
      harness.control.bumpVersion();
    });

    await expect(create()).rejects.toThrow(/changed while saving the snapshot/);

    expect(mocks.deleteStep).toHaveBeenCalledWith(mocks.storeStep.mock.calls[0][0].id);
    expect(harness.getState().groupAnchorId).toBeNull();
  });
});

describe('withdrawAnchorThenDelete', () => {
  it('keeps the row when the published id cannot be withdrawn from the run', async () => {
    harness.setState(snapshotRun({ runId: 'run-2' }));

    await harness.flow.withdrawAnchorThenDelete(RUN_ID, 'anchor-1', harness.control.controlVersion, true);

    expect(mocks.deleteStep).not.toHaveBeenCalled();
    expect(harness.getState().groupAnchorId).toBe('anchor-1');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { createControlPlane } from '@/lib/recording/background/control-plane';
import { createRecaptureFlow, type RecaptureFlow } from '@/lib/recording/background/recapture-flow';
import { StaleCaptureError } from '@/lib/recording/background-queues';
import { StepRecaptureError } from '@/lib/storage/step-repository';
import type { Step } from '@/lib/storage/models';
import type { RecordingState } from '@/lib/storage/recording-state';
import type { StepRecaptureTarget } from '@/lib/storage/step-repository';
import type { HowbeamRecaptureTargetMessage } from '@/lib/runtime/messages';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork } from '../setup/background-test-utils';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

/**
 * The recapture state machine is exercised against the real control plane,
 * capture registry, source-tab helpers and sender guards: only the browser
 * APIs and the IndexedDB repositories are mocked. Recording state is backed by
 * a live in-memory cell so each test asserts on the transitions the flow
 * actually persists (starting → awaiting-target → capturing → settled) rather
 * than on a frozen snapshot.
 */

const mocks = await vi.hoisted(async () =>
  (await import('../setup/background-test-utils')).makeBackgroundMocks());

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));

const EDITOR_URL = 'chrome-extension://extension-id/editor.html';
const SOURCE_URL = 'https://source.example/page';
const SESSION_ID = 'project-a';
const SOURCE_TAB_ID = 11;
const SOURCE_WINDOW_ID = 5;

const singleTarget: StepRecaptureTarget = { kind: 'single', stepId: 'step-1' };

/**
 * Sender doubles carrying only the fields the trust guards read (frameId, url,
 * tab id/windowId/url); Browser.tabs.Tab demands a dozen more that no guard
 * consults, so the cast keeps the fixtures honest about what is under test.
 */
function asSender(sender: {
  frameId: number;
  url: string;
  tab: { id: number; windowId: number; url: string };
}): Browser.runtime.MessageSender {
  return sender as unknown as Browser.runtime.MessageSender;
}

function editorSender(sessionId = SESSION_ID): Browser.runtime.MessageSender {
  const url = `${EDITOR_URL}?sessionId=${sessionId}&entryId=step-1`;
  return asSender({ frameId: 0, url, tab: { id: 0, windowId: 7, url } });
}

function sourceSender(
  overrides: { tabId?: number; url?: string } = {},
): Browser.runtime.MessageSender {
  const url = overrides.url ?? SOURCE_URL;
  return asSender({
    frameId: 0,
    url,
    tab: { id: overrides.tabId ?? SOURCE_TAB_ID, windowId: SOURCE_WINDOW_ID, url },
  });
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: SESSION_ID,
    order: 0,
    screenshotBlob: new Blob(['image']),
    bounds: { x: 1, y: 2, width: 30, height: 40 },
    devicePixelRatio: 2,
    screenshotScale: 2,
    description: 'Persisted step',
    url: SOURCE_URL,
    timestamp: 1,
    ...overrides,
  };
}

function recaptureContext(overrides: Partial<NonNullable<RecordingState['recapture']>> = {}) {
  return {
    runId: 'recapture-1',
    sessionId: SESSION_ID,
    target: singleTarget,
    entryId: 'step-1',
    phase: 'awaiting-target' as const,
    sourceTabId: SOURCE_TAB_ID,
    sourceWindowId: SOURCE_WINDOW_ID,
    sourceUrl: SOURCE_URL,
    sourceTabCreated: true,
    startedAt: 1,
    ...overrides,
  };
}

function targetMessage(
  overrides: Partial<HowbeamRecaptureTargetMessage> = {},
): HowbeamRecaptureTargetMessage {
  return {
    type: 'HOWBEAM_RECAPTURE_TARGET',
    runId: 'recapture-1',
    captureId: 'capture-1',
    rect: { x: 5, y: 6, width: 70, height: 80 },
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    devicePixelRatio: 2,
    url: SOURCE_URL,
    timestamp: 99,
    ...overrides,
  };
}

interface Harness {
  flow: RecaptureFlow;
  control: ReturnType<typeof createControlPlane>;
  getState: () => RecordingState;
  setState: (state: RecordingState) => void;
  openEditor: ReturnType<typeof vi.fn>;
  captureScreenshotWithGuard: ReturnType<typeof vi.fn>;
  injectRecorder: ReturnType<typeof vi.fn>;
  stopRecorderInTab: ReturnType<typeof vi.fn>;
  discardPendingUndo: ReturnType<typeof vi.fn>;
}

let harness: Harness;

function createHarness(): Harness {
  let state = makeRecordingState();
  mocks.getRecordingState.mockImplementation(async () => state);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    state = next;
  });

  const discardPendingUndo = vi.fn();
  const control = createControlPlane({ discardPendingUndo });
  const openEditor = vi.fn().mockResolvedValue(undefined);
  const captureScreenshotWithGuard = vi
    .fn()
    .mockResolvedValue({ blob: new Blob(['replacement']), scale: 2 });
  const injectRecorder = vi.fn().mockResolvedValue(undefined);
  const stopRecorderInTab = vi.fn().mockResolvedValue(undefined);

  const flow = createRecaptureFlow({
    control,
    runtime: {
      injectRecorder,
      stopRecorderInTab,
      captureVisibleTabWithRetry: vi.fn(),
      dataUrlToBlob: vi.fn(),
      getScreenshotScale: vi.fn(),
    } as unknown as Parameters<typeof createRecaptureFlow>[0]['runtime'],
    captureScreenshotWithGuard,
    openEditor,
  });

  return {
    flow,
    control,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    openEditor,
    captureScreenshotWithGuard,
    injectRecorder,
    stopRecorderInTab,
    discardPendingUndo,
  };
}

/** Puts the flow in the mid-run state a given phase represents. */
function armRecapture(overrides: Partial<NonNullable<RecordingState['recapture']>> = {}): void {
  harness.setState(
    makeRecordingState({
      operation: 'recapture',
      sessionId: SESSION_ID,
      recapture: recaptureContext(overrides),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSteps.mockResolvedValue([]);
  mocks.replaceStepCaptureAtomically.mockResolvedValue(undefined);
  mocks.permissionsContains.mockResolvedValue(true);
  mocks.tabsQuery.mockResolvedValue([]);
  mocks.tabsGet.mockResolvedValue({
    id: SOURCE_TAB_ID,
    windowId: SOURCE_WINDOW_ID,
    url: SOURCE_URL,
    status: 'complete',
  });
  mocks.tabsCreate.mockResolvedValue({
    id: SOURCE_TAB_ID,
    windowId: SOURCE_WINDOW_ID,
    url: SOURCE_URL,
    status: 'complete',
  });
  mocks.tabsRemove.mockResolvedValue(undefined);
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
  harness = createHarness();
});

describe('preflightStepRecaptureSourcePermission', () => {
  it('rejects a sender that is not the editor for the named session', async () => {
    mocks.getStep.mockResolvedValue(step());

    const result = await harness.flow.preflightStepRecaptureSourcePermission(
      { type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION', sessionId: SESSION_ID, target: singleTarget },
      editorSender('project-b'),
    );

    expect(result).toEqual({ ok: false, code: 'INVALID_EDITOR', message: expect.any(String) });
    expect(mocks.getStep).not.toHaveBeenCalled();
  });

  it('rejects a blank session id before touching the repository', async () => {
    const result = await harness.flow.preflightStepRecaptureSourcePermission(
      { type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION', sessionId: '   ', target: singleTarget },
      editorSender(),
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_EDITOR' });
    expect(mocks.getStep).not.toHaveBeenCalled();
  });

  it('reports a missing step and a step belonging to another session as not found', async () => {
    mocks.getStep.mockResolvedValueOnce(undefined);
    await expect(
      harness.flow.preflightStepRecaptureSourcePermission(
        { type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION', sessionId: SESSION_ID, target: singleTarget },
        editorSender(),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'TARGET_NOT_FOUND' });

    mocks.getStep.mockResolvedValueOnce(step({ sessionId: 'other-project' }));
    await expect(
      harness.flow.preflightStepRecaptureSourcePermission(
        { type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION', sessionId: SESSION_ID, target: singleTarget },
        editorSender(),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'TARGET_NOT_FOUND' });
  });

  it('reports a single target that has since joined a group or lost its image as changed', async () => {
    mocks.getStep.mockResolvedValueOnce(step({ groupId: 'group-1' }));
    await expect(
      harness.flow.preflightStepRecaptureSourcePermission(
        { type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION', sessionId: SESSION_ID, target: singleTarget },
        editorSender(),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'TARGET_CHANGED' });

    mocks.getStep.mockResolvedValueOnce(step({ screenshotBlob: undefined }));
    await expect(
      harness.flow.preflightStepRecaptureSourcePermission(
        { type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION', sessionId: SESSION_ID, target: singleTarget },
        editorSender(),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'TARGET_CHANGED' });
  });

  it('refuses a snapshot group that carries more than the one annotation being recaptured', async () => {
    const anchor = step({ id: 'anchor-1', groupId: 'anchor-1' });
    const annotation = step({ id: 'note-1', groupId: 'anchor-1' });
    const sibling = step({ id: 'note-2', groupId: 'anchor-1' });
    mocks.getStep.mockImplementation(async (id: string) =>
      ({ 'anchor-1': anchor, 'note-1': annotation, 'note-2': sibling })[id]);
    mocks.getSteps.mockResolvedValue([anchor, annotation, sibling]);

    const result = await harness.flow.preflightStepRecaptureSourcePermission(
      {
        type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
        sessionId: SESSION_ID,
        target: { kind: 'snapshot-singleton', anchorId: 'anchor-1', annotationId: 'note-1' },
      },
      editorSender(),
    );

    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_SNAPSHOT_GROUP' });
  });

  it('accepts a valid single-annotation snapshot group', async () => {
    const anchor = step({ id: 'anchor-1', groupId: 'anchor-1' });
    const annotation = step({ id: 'note-1', groupId: 'anchor-1' });
    mocks.getStep.mockImplementation(async (id: string) =>
      ({ 'anchor-1': anchor, 'note-1': annotation })[id]);
    mocks.getSteps.mockResolvedValue([anchor, annotation]);

    const result = await harness.flow.preflightStepRecaptureSourcePermission(
      {
        type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
        sessionId: SESSION_ID,
        target: { kind: 'snapshot-singleton', anchorId: 'anchor-1', annotationId: 'note-1' },
      },
      editorSender(),
    );

    expect(result).toEqual({
      ok: true,
      sourceUrl: SOURCE_URL,
      sourceOrigin: 'https://source.example',
      permissionPattern: 'https://source.example/*',
    });
  });

  it('refuses a source URL the extension may never record', async () => {
    mocks.getStep.mockResolvedValue(step({ url: 'chrome://settings' }));

    const result = await harness.flow.preflightStepRecaptureSourcePermission(
      { type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );

    expect(result).toMatchObject({ ok: false, code: 'RESTRICTED_SOURCE' });
  });
});

describe('startStepRecapture', () => {
  /** Drives the injection→READY handshake the way the content script does. */
  function wireReadyHandshake(): void {
    harness.injectRecorder.mockImplementation(async () => {
      const context = harness.getState().recapture!;
      await harness.flow.handleRecaptureReady(
        { type: 'HOWBEAM_RECAPTURE_READY', runId: context.runId, url: SOURCE_URL },
        sourceSender(),
      );
    });
  }

  beforeEach(() => {
    mocks.getStep.mockResolvedValue(step());
  });

  it('publishes the recapture context and arms selection once the recorder is ready', async () => {
    wireReadyHandshake();

    const result = await harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );

    expect(result).toMatchObject({ ok: true, tabId: SOURCE_TAB_ID, reusedTab: false });
    const state = harness.getState();
    expect(state.operation).toBe('recapture');
    expect(state.isRecording).toBe(false);
    expect(state.recapture).toMatchObject({
      sessionId: SESSION_ID,
      entryId: 'step-1',
      phase: 'awaiting-target',
      sourceTabId: SOURCE_TAB_ID,
      sourceUrl: SOURCE_URL,
      sourceTabCreated: true,
    });
    expect(harness.control.acceptingClicks).toBe(true);
    expect(harness.discardPendingUndo).toHaveBeenCalledOnce();
  });

  it('reuses an already-open exact-URL tab instead of creating one', async () => {
    mocks.tabsQuery.mockResolvedValue([
      { id: SOURCE_TAB_ID, windowId: SOURCE_WINDOW_ID, url: SOURCE_URL, status: 'complete' },
    ]);
    wireReadyHandshake();

    const result = await harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );

    expect(result).toMatchObject({ ok: true, reusedTab: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(harness.getState().recapture).toMatchObject({ sourceTabCreated: false });
  });

  it('rejects a sender that is not the editor for the session', async () => {
    const result = await harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender('project-b'),
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_EDITOR' });
    expect(harness.getState().operation).toBeNull();
  });

  it('refuses a second start while the first has not published state yet', async () => {
    wireReadyHandshake();
    let releaseSourceTab!: () => void;
    mocks.tabsCreate.mockImplementation(
      () => new Promise((resolve) => {
        releaseSourceTab = () =>
          resolve({ id: SOURCE_TAB_ID, windowId: SOURCE_WINDOW_ID, url: SOURCE_URL, status: 'complete' });
      }),
    );

    const first = harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );
    await flushAsyncWork();
    // Acquiring the source tab happens before the state write, so nothing is
    // persisted yet and only the in-memory mutex can refuse the second start.
    expect(harness.getState().operation).toBeNull();
    expect(harness.flow.isStartingRecapture()).toBe(true);

    const second = await harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );
    expect(second).toMatchObject({ ok: false, code: 'ACTIVE_OPERATION' });
    expect(mocks.tabsCreate).toHaveBeenCalledOnce();

    releaseSourceTab();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(harness.flow.isStartingRecapture()).toBe(false);
  });

  it('refuses to start while another operation owns the capture machinery', async () => {
    harness.setState(makeRecordingState({ operation: 'recording', isRecording: true }));

    const result = await harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );

    expect(result).toMatchObject({ ok: false, code: 'ACTIVE_OPERATION' });
  });

  it('asks the editor to obtain the host permission rather than prompting itself', async () => {
    mocks.permissionsContains.mockResolvedValue(false);

    const result = await harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );

    expect(result).toMatchObject({ ok: false, code: 'HOST_PERMISSION_REQUIRED' });
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
    expect(harness.getState().operation).toBeNull();
  });

  it('reports a source tab that landed on a different URL and closes the tab it created', async () => {
    mocks.tabsCreate.mockResolvedValue({
      id: 77,
      windowId: SOURCE_WINDOW_ID,
      url: 'https://source.example/redirected',
      status: 'complete',
    });
    mocks.tabsGet.mockResolvedValue({
      id: 77,
      windowId: SOURCE_WINDOW_ID,
      url: 'https://source.example/redirected',
      status: 'complete',
    });

    const result = await harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );

    expect(result).toMatchObject({ ok: false, code: 'SOURCE_TAB_FAILED' });
    expect(mocks.tabsRemove).toHaveBeenCalledWith(77);
    expect(harness.getState().operation).toBeNull();
  });

  it('settles the run as failed when the recorder never becomes ready', async () => {
    harness.injectRecorder.mockRejectedValue(new Error('injection blocked'));

    silenceIntentionalErrorLogs();
    const result = await harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );

    expect(result).toMatchObject({ ok: false, code: 'INJECTION_FAILED' });
    const state = harness.getState();
    expect(state.operation).toBeNull();
    expect(state.recapture).toBeNull();
    expect(state.recaptureResult).toMatchObject({ status: 'failed', errorCode: 'INJECTION_FAILED' });
    // The flow created this tab, so settling must close it and return the user
    // to the editor at the entry the run was working on.
    expect(mocks.tabsRemove).toHaveBeenCalledWith(SOURCE_TAB_ID);
    expect(harness.openEditor).toHaveBeenCalledWith({ sessionId: SESSION_ID, entryId: 'step-1' });
  });
});

describe('handleRecaptureReady', () => {
  /**
   * Runs a real start whose injection reports READY through `handshake`, so the
   * startup gate is live while the guard runs. Asserting against a null gate
   * would pass whatever the guard decided.
   */
  async function startWithHandshake(
    handshake: (runId: string) => Promise<unknown>,
  ): Promise<{ settle: () => Promise<unknown> }> {
    mocks.getStep.mockResolvedValue(step());
    harness.injectRecorder.mockImplementation(async () => {
      await handshake(harness.getState().recapture!.runId);
    });
    const start = harness.flow.startStepRecapture(
      { type: 'START_STEP_RECAPTURE', sessionId: SESSION_ID, target: singleTarget },
      editorSender(),
    );
    await flushAsyncWork();
    return { settle: () => start };
  }

  it('advances selection only for the persisted source document', async () => {
    const { settle } = await startWithHandshake((runId) =>
      harness.flow.handleRecaptureReady(
        { type: 'HOWBEAM_RECAPTURE_READY', runId, url: SOURCE_URL },
        sourceSender(),
      ),
    );

    await expect(settle()).resolves.toMatchObject({ ok: true });
    expect(harness.getState().recapture).toMatchObject({ phase: 'awaiting-target' });
  });

  it('does not let another tab satisfy the startup gate', async () => {
    silenceIntentionalErrorLogs();
    const acknowledged: boolean[] = [];
    const { settle } = await startWithHandshake(async (runId) => {
      acknowledged.push(
        await harness.flow.handleRecaptureReady(
          { type: 'HOWBEAM_RECAPTURE_READY', runId, url: SOURCE_URL },
          sourceSender({ tabId: 999 }),
        ),
      );
    });

    expect(acknowledged).toEqual([false]);
    // The gate is still waiting, so selection was never armed.
    expect(harness.getState().recapture).toMatchObject({ phase: 'starting' });

    harness.control.pendingRecaptureReady?.cancel();
    await expect(settle()).resolves.toMatchObject({ ok: false, code: 'INJECTION_FAILED' });
  });

  it('does not let a handshake for another run satisfy the gate', async () => {
    silenceIntentionalErrorLogs();
    const { settle } = await startWithHandshake(async () => {
      await harness.flow.handleRecaptureReady(
        { type: 'HOWBEAM_RECAPTURE_READY', runId: 'some-other-run', url: SOURCE_URL },
        sourceSender(),
      );
    });

    expect(harness.getState().recapture).toMatchObject({ phase: 'starting' });
    harness.control.pendingRecaptureReady?.cancel();
    await expect(settle()).resolves.toMatchObject({ ok: false, code: 'INJECTION_FAILED' });
  });

  it('ignores a handshake once selection is already armed', async () => {
    armRecapture({ phase: 'awaiting-target' });

    await expect(
      harness.flow.handleRecaptureReady(
        { type: 'HOWBEAM_RECAPTURE_READY', runId: 'recapture-1', url: SOURCE_URL },
        sourceSender(),
      ),
    ).resolves.toBe(false);
  });
});

describe('handleRecaptureTarget', () => {
  beforeEach(() => {
    armRecapture();
    harness.control.acceptingClicks = true;
  });

  it('replaces the capture atomically and settles the run as replaced', async () => {
    const message = targetMessage();

    const result = await harness.flow.handleRecaptureTarget(
      message,
      sourceSender(),
      harness.control.controlVersion,
    );

    expect(result).toEqual({ ok: true, status: 'replaced' });
    expect(mocks.replaceStepCaptureAtomically).toHaveBeenCalledWith(
      SESSION_ID,
      singleTarget,
      expect.objectContaining({
        bounds: message.rect,
        devicePixelRatio: 2,
        screenshotScale: 2,
        url: SOURCE_URL,
        timestamp: 99,
      }),
      'recapture-1',
    );
    const state = harness.getState();
    expect(state.operation).toBeNull();
    expect(state.recapture).toBeNull();
    expect(state.recaptureResult).toMatchObject({ status: 'replaced', entryId: 'step-1' });
    expect(harness.stopRecorderInTab).toHaveBeenCalledWith(SOURCE_TAB_ID);
    expect(harness.openEditor).toHaveBeenCalledWith({ sessionId: SESSION_ID, entryId: 'step-1' });
  });

  it('marks the source tab as capturing before taking the screenshot', async () => {
    harness.captureScreenshotWithGuard.mockImplementation(async () => {
      expect(harness.getState().recapture).toMatchObject({ phase: 'capturing' });
      // A click arriving mid-capture must no longer be accepted.
      expect(harness.control.acceptingClicks).toBe(false);
      return { blob: new Blob(['replacement']), scale: 2 };
    });

    await expect(
      harness.flow.handleRecaptureTarget(targetMessage(), sourceSender(), harness.control.controlVersion),
    ).resolves.toEqual({ ok: true, status: 'replaced' });
    expect(harness.captureScreenshotWithGuard).toHaveBeenCalledOnce();
  });

  it('rejects a target message from anything but the persisted top-level source document', async () => {
    await expect(
      harness.flow.handleRecaptureTarget(
        targetMessage(),
        asSender({ frameId: 3, url: SOURCE_URL, tab: { id: SOURCE_TAB_ID, windowId: SOURCE_WINDOW_ID, url: SOURCE_URL } }),
        harness.control.controlVersion,
      ),
    ).resolves.toEqual({ ok: false, status: 'rejected' });

    await expect(
      harness.flow.handleRecaptureTarget(
        targetMessage(),
        sourceSender({ tabId: 999 }),
        harness.control.controlVersion,
      ),
    ).resolves.toEqual({ ok: false, status: 'rejected' });

    expect(harness.captureScreenshotWithGuard).not.toHaveBeenCalled();
    expect(harness.getState().recapture).toMatchObject({ phase: 'awaiting-target' });
  });

  it('rejects a target message whose payload URL disagrees with the persisted source', async () => {
    await expect(
      harness.flow.handleRecaptureTarget(
        targetMessage({ url: 'https://source.example/elsewhere' }),
        sourceSender(),
        harness.control.controlVersion,
      ),
    ).resolves.toEqual({ ok: false, status: 'rejected' });
    expect(harness.captureScreenshotWithGuard).not.toHaveBeenCalled();
  });

  it('rejects a stale control version without reading state', async () => {
    const stale = harness.control.controlVersion;
    harness.control.bumpVersion();

    await expect(
      harness.flow.handleRecaptureTarget(targetMessage(), sourceSender(), stale),
    ).resolves.toEqual({ ok: false, status: 'rejected' });
    expect(mocks.getRecordingState).not.toHaveBeenCalled();
  });

  it('consumes the one-shot capture slot so a second target message is refused', async () => {
    let releaseScreenshot!: () => void;
    harness.captureScreenshotWithGuard.mockImplementation(
      () => new Promise((resolve) => {
        releaseScreenshot = () => resolve({ blob: new Blob(['replacement']), scale: 2 });
      }),
    );

    const first = harness.flow.handleRecaptureTarget(
      targetMessage(),
      sourceSender(),
      harness.control.controlVersion,
    );
    await flushAsyncWork();

    const second = await harness.flow.handleRecaptureTarget(
      targetMessage({ captureId: 'capture-2' }),
      sourceSender(),
      harness.control.controlVersion,
    );
    expect(second).toEqual({ ok: false, status: 'rejected' });

    releaseScreenshot();
    await expect(first).resolves.toEqual({ ok: true, status: 'replaced' });
    expect(mocks.replaceStepCaptureAtomically).toHaveBeenCalledOnce();
  });

  it('refuses a second target message while a capture is still in flight', async () => {
    let releaseScreenshot!: () => void;
    harness.captureScreenshotWithGuard.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseScreenshot = () => resolve({ blob: new Blob(['replacement']), scale: 2 });
      }),
    );

    const first = harness.flow.handleRecaptureTarget(
      targetMessage(),
      sourceSender(),
      harness.control.controlVersion,
    );
    await flushAsyncWork();

    // Re-arming selection must not let a second click start a parallel capture:
    // the persisted phase is back to awaiting-target, so only the in-memory
    // capture slot stands between the two screenshots.
    armRecapture();
    harness.control.acceptingClicks = true;

    await expect(
      harness.flow.handleRecaptureTarget(
        targetMessage({ captureId: 'capture-2' }),
        sourceSender(),
        harness.control.controlVersion,
      ),
    ).resolves.toEqual({ ok: false, status: 'rejected' });
    expect(harness.captureScreenshotWithGuard).toHaveBeenCalledOnce();

    releaseScreenshot();
    await first;
  });

  it('abandons the capture when the phase changes between the guard and the claim', async () => {
    const armed = harness.getState();
    const capturing = makeRecordingState({
      operation: 'recapture',
      sessionId: SESSION_ID,
      recapture: recaptureContext({ phase: 'capturing' }),
    });
    // The guard reads an armed selection; by the time the conditional write
    // re-reads, another worker leg has already claimed the capture.
    mocks.getRecordingState.mockResolvedValueOnce(armed).mockResolvedValueOnce(capturing);

    await expect(
      harness.flow.handleRecaptureTarget(targetMessage(), sourceSender(), harness.control.controlVersion),
    ).resolves.toEqual({ ok: false, status: 'rejected' });
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(harness.captureScreenshotWithGuard).not.toHaveBeenCalled();
  });

  it('reports a stale capture as cancelled and leaves the stored capture alone', async () => {
    harness.captureScreenshotWithGuard.mockRejectedValue(new StaleCaptureError('control changed'));

    await expect(
      harness.flow.handleRecaptureTarget(targetMessage(), sourceSender(), harness.control.controlVersion),
    ).resolves.toEqual({ ok: false, status: 'cancelled' });
    expect(mocks.replaceStepCaptureAtomically).not.toHaveBeenCalled();
  });

  it('surfaces a repository refusal with its own code and localized copy, and settles the run as failed', async () => {
    // The repository's message is an English diagnostic; the user sees the localized copy for its code.
    mocks.replaceStepCaptureAtomically.mockRejectedValue(
      new StepRecaptureError('TARGET_CHANGED', 'The step is no longer an ordinary step.'),
    );

    silenceIntentionalErrorLogs();
    const result = await harness.flow.handleRecaptureTarget(
      targetMessage(),
      sourceSender(),
      harness.control.controlVersion,
    );

    expect(result).toEqual({ ok: false, status: 'failed', error: '此步驟已變更，請重新整理編輯器後再試一次。' });
    expect(harness.getState().recaptureResult).toMatchObject({
      status: 'failed',
      errorCode: 'TARGET_CHANGED',
    });
  });

  it('translates a raw browser failure instead of handing it to the editor', async () => {
    harness.captureScreenshotWithGuard.mockRejectedValue(
      new Error("Either the '<all_urls>' or 'activeTab' permission is required."),
    );

    silenceIntentionalErrorLogs();
    const result = await harness.flow.handleRecaptureTarget(
      targetMessage(),
      sourceSender(),
      harness.control.controlVersion,
    );

    expect(result).toEqual({
      ok: false,
      status: 'failed',
      error: 'Howbeam 已失去這個頁面的存取權限。請允許存取此網站後再試一次。',
    });
  });

  it('releases the capture slot after a failure so a retry can claim it', async () => {
    harness.captureScreenshotWithGuard.mockRejectedValueOnce(new StaleCaptureError('control changed'));

    await harness.flow.handleRecaptureTarget(
      targetMessage(),
      sourceSender(),
      harness.control.controlVersion,
    );
    // The rejected attempt left the persisted phase at 'capturing'; a retry is
    // only possible once selection is armed again, which is what the editor
    // does after a cancelled target.
    armRecapture();
    harness.control.acceptingClicks = true;

    await expect(
      harness.flow.handleRecaptureTarget(
        targetMessage({ captureId: 'capture-2' }),
        sourceSender(),
        harness.control.controlVersion,
      ),
    ).resolves.toEqual({ ok: true, status: 'replaced' });
  });
});

describe('handleSourceTabUpdated', () => {
  it('ignores updates for tabs that are not this run’s source', async () => {
    armRecapture();

    await expect(harness.flow.handleSourceTabUpdated(999, { status: 'loading' })).resolves.toBe(false);
    expect(harness.getState().operation).toBe('recapture');
  });

  it('lets the initial document finish loading while the run is still starting', async () => {
    armRecapture({ phase: 'starting' });

    await expect(
      harness.flow.handleSourceTabUpdated(SOURCE_TAB_ID, { status: 'loading' }),
    ).resolves.toBe(true);
    expect(harness.getState().recapture).toMatchObject({ phase: 'starting' });
  });

  it('fails the run when the source navigates during selection', async () => {
    armRecapture();

    await expect(
      harness.flow.handleSourceTabUpdated(SOURCE_TAB_ID, { status: 'loading' }),
    ).resolves.toBe(true);

    const state = harness.getState();
    expect(state.operation).toBeNull();
    expect(state.recaptureResult).toMatchObject({ status: 'failed', errorCode: 'SOURCE_NAVIGATED' });
  });

  it('fails the run when the source URL changes underneath the selection', async () => {
    armRecapture();

    await expect(
      harness.flow.handleSourceTabUpdated(SOURCE_TAB_ID, { url: 'https://source.example/other' }),
    ).resolves.toBe(true);
    expect(harness.getState().recaptureResult).toMatchObject({ errorCode: 'SOURCE_NAVIGATED' });
  });

  it('treats a same-URL update as a no-op that still belongs to this flow', async () => {
    armRecapture();

    await expect(
      harness.flow.handleSourceTabUpdated(SOURCE_TAB_ID, { url: SOURCE_URL }),
    ).resolves.toBe(true);
    expect(harness.getState().operation).toBe('recapture');
  });
});

describe('handleSourceTabRemoved', () => {
  it('fails the run when the source tab is closed', async () => {
    armRecapture();

    await expect(harness.flow.handleSourceTabRemoved(SOURCE_TAB_ID)).resolves.toBe(true);
    expect(harness.getState().recaptureResult).toMatchObject({
      status: 'failed',
      errorCode: 'SOURCE_TAB_CLOSED',
    });
  });

  it('ignores an unrelated tab closing', async () => {
    armRecapture();

    await expect(harness.flow.handleSourceTabRemoved(999)).resolves.toBe(false);
    expect(harness.getState().operation).toBe('recapture');
  });
});

describe('recoverInterruptedRecapture', () => {
  it('does nothing when no recapture is in flight', async () => {
    await harness.flow.recoverInterruptedRecapture();

    expect(harness.getState().operation).toBeNull();
    expect(harness.openEditor).not.toHaveBeenCalled();
  });

  it('keeps an armed selection whose source tab survived the worker restart', async () => {
    armRecapture();

    await harness.flow.recoverInterruptedRecapture();

    expect(harness.getState().recapture).toMatchObject({ phase: 'awaiting-target' });
  });

  it('releases the owner slot when the persisted source tab no longer shows the page', async () => {
    armRecapture();
    mocks.tabsGet.mockResolvedValue({
      id: SOURCE_TAB_ID,
      windowId: SOURCE_WINDOW_ID,
      url: 'https://unrelated.example/',
      status: 'complete',
    });

    await harness.flow.recoverInterruptedRecapture();

    const state = harness.getState();
    expect(state.operation).toBeNull();
    expect(state.recaptureResult).toMatchObject({ status: 'failed', errorCode: 'SOURCE_TAB_CLOSED' });
  });

  it('releases the owner slot when the persisted tab id is gone entirely', async () => {
    armRecapture();
    mocks.tabsGet.mockRejectedValue(new Error('No tab with id'));

    await harness.flow.recoverInterruptedRecapture();

    expect(harness.getState().recaptureResult).toMatchObject({ errorCode: 'SOURCE_TAB_CLOSED' });
  });

  it('reports a replacement that committed before the worker died', async () => {
    armRecapture({ phase: 'capturing' });
    mocks.getStep.mockResolvedValue(step({ lastCaptureRunId: 'recapture-1' }));

    await harness.flow.recoverInterruptedRecapture();

    const state = harness.getState();
    expect(state.recaptureResult).toMatchObject({ status: 'replaced' });
    expect(state.recaptureResult?.errorCode).toBeUndefined();
  });

  it('reports abandoned in-flight work rather than leaving the editor locked', async () => {
    armRecapture({ phase: 'capturing' });
    mocks.getStep.mockResolvedValue(step({ lastCaptureRunId: 'an-older-run' }));

    await harness.flow.recoverInterruptedRecapture();

    expect(harness.getState().recaptureResult).toMatchObject({
      status: 'failed',
      errorCode: 'WORKER_RESTARTED',
    });
  });
});

describe('cancelStepRecapture', () => {
  it('cancels an armed selection and settles the run', async () => {
    armRecapture();

    const result = await harness.flow.cancelStepRecapture(
      { type: 'CANCEL_STEP_RECAPTURE', runId: 'recapture-1' },
      editorSender(),
    );

    expect(result).toEqual({ ok: true, status: 'cancelled' });
    expect(harness.getState().recaptureResult).toMatchObject({
      status: 'cancelled',
      errorCode: 'CANCELLED',
    });
  });

  it('accepts a cancel from the source page as well as the editor', async () => {
    armRecapture();

    await expect(
      harness.flow.cancelStepRecapture(
        { type: 'CANCEL_STEP_RECAPTURE', runId: 'recapture-1' },
        sourceSender(),
      ),
    ).resolves.toEqual({ ok: true, status: 'cancelled' });
  });

  it('refuses a cancel from an untrusted sender', async () => {
    armRecapture();

    const result = await harness.flow.cancelStepRecapture(
      { type: 'CANCEL_STEP_RECAPTURE', runId: 'recapture-1' },
      editorSender('project-b'),
    );

    expect(result).toEqual({ ok: false, error: '無法使用這個補拍來源，請回到編輯器重新操作。' });
    expect(harness.getState().operation).toBe('recapture');
  });

  it('reports an already-settled run as completed instead of failing', async () => {
    harness.setState(
      makeRecordingState({
        recaptureResult: {
          runId: 'recapture-1',
          status: 'replaced',
          sessionId: SESSION_ID,
          entryId: 'step-1',
          completedAt: 2,
        },
      }),
    );

    await expect(
      harness.flow.cancelStepRecapture(
        { type: 'CANCEL_STEP_RECAPTURE', runId: 'recapture-1' },
        editorSender(),
      ),
    ).resolves.toEqual({ ok: true, status: 'already-completed' });
  });

  it('reports completion when the replacement is already committing', async () => {
    armRecapture();
    harness.control.acceptingClicks = true;
    let releaseCommit!: () => void;
    mocks.replaceStepCaptureAtomically.mockImplementation(
      () => new Promise<void>((resolve) => {
        releaseCommit = resolve;
      }),
    );

    const capture = harness.flow.handleRecaptureTarget(
      targetMessage(),
      sourceSender(),
      harness.control.controlVersion,
    );
    await flushAsyncWork();

    const cancelled = await harness.flow.cancelStepRecapture(
      { type: 'CANCEL_STEP_RECAPTURE', runId: 'recapture-1' },
      editorSender(),
    );
    expect(cancelled).toEqual({ ok: true, status: 'already-completed' });

    releaseCommit();
    await expect(capture).resolves.toEqual({ ok: true, status: 'replaced' });
    expect(harness.getState().recaptureResult).toMatchObject({ status: 'replaced' });
  });

  it('rejects a cancel for a run that is not the current one', async () => {
    armRecapture();

    await expect(
      harness.flow.cancelStepRecapture(
        { type: 'CANCEL_STEP_RECAPTURE', runId: 'some-other-run' },
        editorSender(),
      ),
    ).resolves.toEqual({ ok: false, error: '這次補拍已經結束。' });
  });
});

describe('failStepRecapture', () => {
  it('ignores a failure raised against a superseded control version', async () => {
    armRecapture();
    const stale = harness.control.controlVersion;
    harness.control.bumpVersion();

    await expect(
      harness.flow.failStepRecapture('recapture-1', 'CODE', 'message', stale),
    ).resolves.toBe(false);
    expect(harness.getState().operation).toBe('recapture');
  });
});

describe('ackStepRecaptureResult', () => {
  const settled = () =>
    makeRecordingState({
      recaptureResult: {
        runId: 'recapture-1',
        status: 'replaced',
        sessionId: SESSION_ID,
        entryId: 'step-1',
        completedAt: 2,
      },
    });

  it('clears the result the editor acknowledged', async () => {
    harness.setState(settled());

    await expect(
      harness.flow.ackStepRecaptureResult(
        { type: 'ACK_STEP_RECAPTURE_RESULT', runId: 'recapture-1', sessionId: SESSION_ID },
        editorSender(),
      ),
    ).resolves.toBe(true);
    expect(harness.getState().recaptureResult).toBeNull();
  });

  it('keeps the result when the run id or the sender does not match', async () => {
    harness.setState(settled());
    await expect(
      harness.flow.ackStepRecaptureResult(
        { type: 'ACK_STEP_RECAPTURE_RESULT', runId: 'another-run', sessionId: SESSION_ID },
        editorSender(),
      ),
    ).resolves.toBe(false);

    harness.setState(settled());
    await expect(
      harness.flow.ackStepRecaptureResult(
        { type: 'ACK_STEP_RECAPTURE_RESULT', runId: 'recapture-1', sessionId: 'project-b' },
        editorSender('project-b'),
      ),
    ).resolves.toBe(false);
    expect(harness.getState().recaptureResult).not.toBeNull();
  });
});

describe('focusStepRecaptureSource', () => {
  it('focuses the persisted source tab for the editor that owns the run', async () => {
    armRecapture();

    await expect(
      harness.flow.focusStepRecaptureSource(
        { type: 'FOCUS_STEP_RECAPTURE_SOURCE', runId: 'recapture-1' },
        editorSender(),
      ),
    ).resolves.toEqual({ ok: true });
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(SOURCE_TAB_ID, { active: true });
  });

  it('refuses when the run has ended or the sender is not its editor', async () => {
    armRecapture();
    await expect(
      harness.flow.focusStepRecaptureSource(
        { type: 'FOCUS_STEP_RECAPTURE_SOURCE', runId: 'gone' },
        editorSender(),
      ),
    ).resolves.toEqual({ ok: false, error: '這次補拍已經結束。' });

    await expect(
      harness.flow.focusStepRecaptureSource(
        { type: 'FOCUS_STEP_RECAPTURE_SOURCE', runId: 'recapture-1' },
        editorSender('project-b'),
      ),
    ).resolves.toEqual({ ok: false, error: '無法從這個頁面開始補拍，請回到 Howbeam 編輯器重新操作。' });
  });

  it('reports a source tab that can no longer be focused', async () => {
    armRecapture();
    mocks.tabsUpdate.mockRejectedValue(new Error('No tab with id'));

    await expect(
      harness.flow.focusStepRecaptureSource(
        { type: 'FOCUS_STEP_RECAPTURE_SOURCE', runId: 'recapture-1' },
        editorSender(),
      ),
    ).resolves.toEqual({ ok: false, error: '找不到補拍分頁。' });
  });
});

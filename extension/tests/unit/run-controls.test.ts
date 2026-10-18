import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlPlane } from '@/lib/recording/background/control-plane';
import { createRunControls, type RunControlDependencies } from '@/lib/recording/background/run-controls';
import { createRunState } from '@/lib/recording/background/run-state';
import { createUndoWindow } from '@/lib/recording/background/undo-window';
import type { RecordingControlMessage, RecordingControlResult } from '@/lib/runtime/messages';
import type { RuntimeMessageSenderLike } from '@/lib/runtime/background-message-validation';
import type { Step } from '@/lib/storage/models';
import type { RecordingState } from '@/lib/storage/recording-state';
import { t } from '@/lib/shared/i18n';
import { makeRecordingState } from '../setup/recording-state';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

/**
 * Run controls against the real control plane, run-state writes, undo window,
 * queues and ready gate; the browser, the step repository, the run cleanup
 * helpers and the undo store are mocked. Recording state is a live in-memory
 * cell, so each test asserts on what the control actually persisted.
 */

const mocks = await vi.hoisted(async () =>
  (await import('../setup/background-test-utils')).makeBackgroundMocks());
const cleanup = vi.hoisted(() => ({
  deleteEmptySnapshotAnchor: vi.fn(),
  deleteEmptySnapshotAnchorBestEffort: vi.fn(),
  reclaimAbandonedAutoCreatedProject: vi.fn(),
}));

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal, {
    deleteStepsForRun: mocks.deleteStepsForRun,
  }));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));
vi.mock('@/lib/recording/background/pending-undo-store', async () =>
  (await import('../setup/background-test-utils')).mockPendingUndoStoreModule(mocks));
vi.mock('@/lib/recording/background/run-cleanup', () => cleanup);

const PAGE_URL = 'https://site.example/page';
const SESSION_ID = 'project-a';
const RUN_ID = 'run-1';
const TAB_ID = 4;
const WINDOW_ID = 6;
const SNAPSHOT_CONTEXT = {
  url: PAGE_URL,
  viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
  devicePixelRatio: 2,
  timestamp: 7,
};

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
    itemCount: 1,
    groupAnchorId: 'anchor-1',
    snapshotViewport: SNAPSHOT_CONTEXT.viewport,
    snapshotDevicePixelRatio: 2,
    ...overrides,
  });
}

function step(id: string, overrides: Partial<Step> = {}): Step {
  return {
    id,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    order: 0,
    screenshotBlob: new Blob([id]),
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    devicePixelRatio: 2,
    screenshotScale: 2,
    description: id,
    url: PAGE_URL,
    timestamp: 1,
    ...overrides,
  };
}

interface Harness {
  send(type: RecordingControlMessage['type'], extra?: Partial<RecordingControlMessage>, sender?: RuntimeMessageSenderLike): Promise<RecordingControlResult>;
  shortcut(command: string): Promise<void>;
  control: ReturnType<typeof createControlPlane>;
  getState: () => RecordingState;
  setState: (state: RecordingState) => void;
  injectRecorder: ReturnType<typeof vi.fn>;
  stopRecorderInTab: ReturnType<typeof vi.fn>;
  createAndActivateSnapshotAnchor: ReturnType<typeof vi.fn>;
  openEditor: ReturnType<typeof vi.fn>;
}

let harness: Harness;

function createHarness(): Harness {
  let state = liveRun();
  mocks.getRecordingState.mockImplementation(async () => state);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    state = next;
  });

  const undoWindow = createUndoWindow();
  const control = createControlPlane({ discardPendingUndo: () => undoWindow.discard() });
  // A recorder that reports READY with the identity the gate expects, and a
  // snapshot recorder's capture context with it.
  const injectRecorder = vi.fn(async (tabId: number) => {
    control.pendingSnapshotContext = SNAPSHOT_CONTEXT;
    control.pendingRecorderReady?.signal({ runId: RUN_ID, tabId, controlVersion: control.controlVersion });
  });
  const stopRecorderInTab = vi.fn().mockResolvedValue(undefined);
  const createAndActivateSnapshotAnchor = vi.fn(async () => {
    control.acceptingClicks = true;
    return 'anchor-2';
  });
  const openEditor = vi.fn().mockResolvedValue(undefined);
  const controls = createRunControls({
    control,
    runtime: { injectRecorder, stopRecorderInTab } as unknown as RunControlDependencies['runtime'],
    runState: createRunState({ control }),
    undoWindow,
    captureFlow: { createAndActivateSnapshotAnchor } as unknown as RunControlDependencies['captureFlow'],
    editorOpen: { openEditor } as unknown as RunControlDependencies['editorOpen'],
  });

  return {
    send: (type, extra = {}, sender) => controls.handleRecordingControl({ type, runId: RUN_ID, ...extra }, sender),
    shortcut: (command) => controls.handleCommandShortcut(command),
    control,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    injectRecorder,
    stopRecorderInTab,
    createAndActivateSnapshotAnchor,
    openEditor,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSteps.mockResolvedValue([]);
  mocks.storeStep.mockResolvedValue(undefined);
  mocks.deleteStep.mockResolvedValue(undefined);
  mocks.deleteStepsForRun.mockResolvedValue(undefined);
  mocks.savePendingUndoRecord.mockResolvedValue(undefined);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
  mocks.tabsGet.mockResolvedValue({ id: TAB_ID, windowId: WINDOW_ID, url: PAGE_URL });
  cleanup.deleteEmptySnapshotAnchor.mockResolvedValue(undefined);
  cleanup.deleteEmptySnapshotAnchorBestEffort.mockResolvedValue(undefined);
  cleanup.reclaimAbandonedAutoCreatedProject.mockResolvedValue(undefined);
  harness = createHarness();
});

describe('sender trust', () => {
  it('accepts the toolbar in the recorded tab and turns down any other page', async () => {
    const toolbar = { frameId: 0, url: PAGE_URL, tab: { id: TAB_ID, url: PAGE_URL } };
    const otherTab = { frameId: 0, url: PAGE_URL, tab: { id: 9, url: PAGE_URL } };
    const subFrame = { frameId: 2, url: PAGE_URL, tab: { id: TAB_ID, url: PAGE_URL } };
    silenceIntentionalErrorLogs();

    await expect(harness.send('PAUSE_RECORDING', {}, otherTab))
      .resolves.toEqual({ ok: false, error: t().background.actionUnavailable });
    await expect(harness.send('PAUSE_RECORDING', {}, subFrame))
      .resolves.toEqual({ ok: false, error: t().background.actionUnavailable });
    expect(harness.getState().phase).toBe('recording');

    await expect(harness.send('PAUSE_RECORDING', {}, toolbar)).resolves.toEqual({ ok: true });
  });

  it('accepts an extension page without a recorded-tab check', async () => {
    const popup = { url: 'chrome-extension://extension-id/popup.html' };

    await expect(harness.send('PAUSE_RECORDING', {}, popup)).resolves.toEqual({ ok: true });
  });
});

describe('pause and resume', () => {
  it('closes the click gate while paused and reopens it on resume', async () => {
    await expect(harness.send('PAUSE_RECORDING')).resolves.toEqual({ ok: true });
    expect(harness.getState().phase).toBe('paused');
    expect(harness.control.acceptingClicks).toBe(false);

    await expect(harness.send('RESUME_RECORDING')).resolves.toEqual({ ok: true });
    expect(harness.getState().phase).toBe('recording');
    expect(harness.control.acceptingClicks).toBe(true);
  });

  it('has no pause in a snapshot run, nor for another run', async () => {
    harness.setState(snapshotRun());
    await expect(harness.send('PAUSE_RECORDING')).resolves.toEqual({ ok: false, error: t().background.cannotPause });

    harness.setState(liveRun({ runId: 'run-2' }));
    await expect(harness.send('PAUSE_RECORDING')).resolves.toEqual({ ok: false, error: t().background.cannotPause });
    expect(harness.getState().phase).toBe('recording');
  });

  it('toggles from the keyboard shortcut in a steps run only', async () => {
    await harness.shortcut('toggle-pause');
    expect(harness.getState().phase).toBe('paused');
    await harness.shortcut('toggle-pause');
    expect(harness.getState().phase).toBe('recording');

    harness.setState(snapshotRun());
    await harness.shortcut('toggle-pause');
    expect(harness.getState().phase).toBe('recording');
  });
});

describe('undo and restore', () => {
  const runSteps = () => [
    step('first'),
    step('last'),
    step('anchor', { bounds: null }),
    step('other-run', { runId: 'run-0' }),
  ];

  it('soft-deletes the run’s last item after persisting its copy', async () => {
    mocks.getSteps.mockResolvedValue(runSteps());

    const result = await harness.send('UNDO_LAST_CAPTURE');

    expect(result).toEqual({ ok: true, undoToken: expect.any(String), removedItemNumber: 2 });
    expect(mocks.deleteStep).toHaveBeenCalledWith('last');
    expect(mocks.savePendingUndoRecord.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deleteStep.mock.invocationCallOrder[0]);
    expect(mocks.savePendingUndoRecord).toHaveBeenCalledWith(expect.objectContaining({
      runId: RUN_ID,
      step: expect.objectContaining({ id: 'last' }),
      expectedItemCount: 1,
    }));
    expect(harness.getState().itemCount).toBe(1);
  });

  it('has nothing to undo before the first item', async () => {
    mocks.getSteps.mockResolvedValue([step('anchor', { bounds: null })]);
    harness.setState(liveRun({ itemCount: 0 }));

    await expect(harness.send('UNDO_LAST_CAPTURE'))
      .resolves.toEqual({ ok: false, error: t().background.nothingToUndo });
    expect(mocks.deleteStep).not.toHaveBeenCalled();
  });

  it('puts the item back when the run changes before the undo is counted', async () => {
    mocks.getSteps.mockResolvedValue(runSteps());
    mocks.deleteStep.mockImplementation(async () => {
      harness.control.bumpVersion();
    });

    await expect(harness.send('UNDO_LAST_CAPTURE'))
      .resolves.toEqual({ ok: false, error: t().background.undoStateChanged });

    expect(mocks.storeStep).toHaveBeenCalledWith(expect.objectContaining({ id: 'last' }));
    expect(mocks.clearPendingUndoRecord).toHaveBeenCalled();
    expect(harness.getState().itemCount).toBe(2);
  });

  it('restores the undone item once, with the token undo returned', async () => {
    mocks.getSteps.mockResolvedValue(runSteps());
    const undone = await harness.send('UNDO_LAST_CAPTURE');
    const undoToken = undone.ok ? undone.undoToken : undefined;

    await expect(harness.send('RESTORE_LAST_CAPTURE', { undoToken })).resolves.toEqual({ ok: true });
    expect(mocks.storeStep).toHaveBeenCalledWith(expect.objectContaining({ id: 'last' }));
    expect(harness.getState().itemCount).toBe(2);

    await expect(harness.send('RESTORE_LAST_CAPTURE', { undoToken }))
      .resolves.toEqual({ ok: false, error: t().background.cannotRestore });
    expect(mocks.storeStep).toHaveBeenCalledTimes(1);
  });

  it('refuses a restore once a newer item was counted', async () => {
    mocks.getSteps.mockResolvedValue(runSteps());
    const undone = await harness.send('UNDO_LAST_CAPTURE');
    harness.setState({ ...harness.getState(), itemCount: 2 });

    await expect(harness.send('RESTORE_LAST_CAPTURE', { undoToken: undone.ok ? undone.undoToken : undefined }))
      .resolves.toEqual({ ok: false, error: t().background.cannotRestore });
    expect(mocks.storeStep).not.toHaveBeenCalled();
  });

  it('refuses a restore with a token undo never issued', async () => {
    mocks.getSteps.mockResolvedValue(runSteps());
    await harness.send('UNDO_LAST_CAPTURE');

    await expect(harness.send('RESTORE_LAST_CAPTURE', { undoToken: 'forged' }))
      .resolves.toEqual({ ok: false, error: t().background.cannotRestore });
  });
});

describe('finish', () => {
  it('ends the run and opens the editor at its last item', async () => {
    mocks.getSteps.mockResolvedValue([
      step('first'),
      step('marker', { groupId: 'anchor-1' }),
      step('anchor-1', { bounds: null }),
    ]);

    const result = await harness.send('FINISH_RECORDING');

    expect(result).toEqual({ ok: true, finish: { sessionId: SESSION_ID, entryId: 'anchor-1', itemCount: 2 } });
    expect(harness.getState()).toMatchObject({ isRecording: false, phase: 'idle', runId: null });
    expect(harness.stopRecorderInTab).toHaveBeenCalledWith(TAB_ID);
    expect(cleanup.deleteEmptySnapshotAnchorBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID }),
    );
    expect(harness.openEditor).toHaveBeenCalledWith({ sessionId: SESSION_ID, entryId: 'anchor-1' });
  });

  it('keeps the finish and leaves a recovery notice when the editor cannot open', async () => {
    silenceIntentionalErrorLogs();
    harness.openEditor.mockRejectedValue(new Error('no window'));

    await expect(harness.send('FINISH_RECORDING')).resolves.toMatchObject({ ok: true });

    expect(harness.getState()).toMatchObject({ isRecording: false, phase: 'error' });
    expect(harness.getState().recoverableError).not.toBeNull();
  });

  it('answers a second finish while the first is still in flight', async () => {
    harness.setState(liveRun({ phase: 'finishing' }));

    await expect(harness.send('FINISH_RECORDING')).resolves.toEqual({ ok: false, error: t().background.finishing });
    expect(harness.openEditor).not.toHaveBeenCalled();
  });
});

describe('discard', () => {
  it('deletes the run’s steps, ends the run and reclaims an auto-created project', async () => {
    await expect(harness.send('DISCARD_CURRENT_RECORDING')).resolves.toEqual({ ok: true });

    expect(mocks.deleteStepsForRun).toHaveBeenCalledWith(SESSION_ID, RUN_ID);
    expect(harness.getState()).toMatchObject({ isRecording: false, phase: 'idle' });
    expect(harness.stopRecorderInTab).toHaveBeenCalledWith(TAB_ID);
    expect(cleanup.reclaimAbandonedAutoCreatedProject).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID }),
    );
  });

  it('keeps the run alive with a notice when its steps cannot be deleted', async () => {
    silenceIntentionalErrorLogs();
    mocks.deleteStepsForRun.mockRejectedValue(new Error('quota'));

    await expect(harness.send('DISCARD_CURRENT_RECORDING'))
      .resolves.toEqual({ ok: false, error: t().background.discardFailed });

    expect(harness.getState()).toMatchObject({
      isRecording: true,
      recoverableError: { code: 'DISCARD_FAILED' },
    });
    expect(harness.stopRecorderInTab).not.toHaveBeenCalled();
  });

  it('cannot discard a run that is still starting', async () => {
    harness.setState(liveRun({ phase: 'starting' }));

    await expect(harness.send('DISCARD_CURRENT_RECORDING'))
      .resolves.toEqual({ ok: false, error: t().background.cannotDiscard });
    expect(mocks.deleteStepsForRun).not.toHaveBeenCalled();
  });
});

describe('snapshot steps', () => {
  it('prepares the next snapshot and drops an anchor that got no annotation', async () => {
    harness.setState(snapshotRun());

    await expect(harness.send('PREPARE_NEXT_SNAPSHOT')).resolves.toEqual({ ok: true });

    expect(harness.getState()).toMatchObject({ phase: 'preparing-next', itemCount: 0, groupAnchorId: null });
    expect(cleanup.deleteEmptySnapshotAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ groupAnchorId: 'anchor-1' }),
    );
    expect(harness.injectRecorder).toHaveBeenCalledWith(TAB_ID, true);
  });

  it('creates the next snapshot from the recorder’s capture context', async () => {
    harness.setState(snapshotRun({ phase: 'preparing-next', itemCount: 0, groupAnchorId: null }));

    await expect(harness.send('CREATE_NEXT_SNAPSHOT')).resolves.toEqual({ ok: true });

    expect(harness.createAndActivateSnapshotAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'starting' }),
      TAB_ID,
      WINDOW_ID,
      SNAPSHOT_CONTEXT,
      harness.control.controlVersion,
    );
    expect(harness.getState().phase).toBe('recording');
    expect(harness.control.acceptingClicks).toBe(true);
  });

  it('returns to preparation with a notice when the anchor cannot be taken', async () => {
    silenceIntentionalErrorLogs();
    harness.setState(snapshotRun({ phase: 'preparing-next', itemCount: 0, groupAnchorId: null }));
    harness.createAndActivateSnapshotAnchor.mockRejectedValue(new Error('capture failed'));

    await expect(harness.send('CREATE_NEXT_SNAPSHOT'))
      .resolves.toEqual({ ok: false, error: t().background.createSnapshotFailed });

    expect(harness.getState()).toMatchObject({
      phase: 'preparing-next',
      recoverableError: { code: 'CREATE_SNAPSHOT_FAILED' },
    });
    expect(harness.control.acceptingClicks).toBe(false);
  });

  it('keeps an invalidated snapshot’s annotations when rebuilding it fails', async () => {
    silenceIntentionalErrorLogs();
    harness.setState(snapshotRun({ phase: 'invalidated', itemCount: 3 }));
    harness.createAndActivateSnapshotAnchor.mockRejectedValue(new Error('capture failed'));

    await expect(harness.send('REBUILD_INVALIDATED_SNAPSHOT'))
      .resolves.toEqual({ ok: false, error: t().background.rebuildSnapshotFailed });

    expect(harness.getState()).toMatchObject({
      phase: 'invalidated',
      itemCount: 3,
      groupAnchorId: 'anchor-1',
      recoverableError: { code: 'REBUILD_SNAPSHOT_FAILED' },
    });
  });
});

describe('mode switches', () => {
  it('switches a steps run into snapshot preparation', async () => {
    await expect(harness.send('SWITCH_TO_SNAPSHOT_MODE')).resolves.toEqual({ ok: true });

    expect(harness.getState()).toMatchObject({ mode: 'snapshot', phase: 'preparing-next', itemCount: 0 });
    expect(harness.injectRecorder).toHaveBeenCalledWith(TAB_ID, true);
  });

  it('puts a steps run back as it was when the snapshot recorder cannot be injected', async () => {
    silenceIntentionalErrorLogs();
    harness.setState(liveRun({ phase: 'paused' }));
    harness.injectRecorder.mockRejectedValueOnce(new Error('Cannot access contents of the page'));

    await expect(harness.send('SWITCH_TO_SNAPSHOT_MODE'))
      .resolves.toEqual({ ok: false, error: t().background.switchToSnapshotFailed });

    expect(harness.getState()).toMatchObject({ mode: 'steps', phase: 'paused', itemCount: 2 });
    expect(harness.control.acceptingClicks).toBe(false);
    expect(harness.injectRecorder).toHaveBeenCalledTimes(2);
  });

  it('switches a snapshot run to steps once the step recorder is ready', async () => {
    harness.setState(snapshotRun());

    await expect(harness.send('SWITCH_TO_STEPS_MODE')).resolves.toEqual({ ok: true });

    expect(harness.getState()).toMatchObject({ mode: 'steps', phase: 'recording', itemCount: 0, groupAnchorId: null });
    expect(cleanup.deleteEmptySnapshotAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ groupAnchorId: 'anchor-1' }),
    );
    expect(harness.control.acceptingClicks).toBe(true);
  });

  it('falls back to snapshot preparation when the step recorder cannot start', async () => {
    silenceIntentionalErrorLogs();
    harness.setState(snapshotRun());
    harness.injectRecorder.mockRejectedValueOnce(new Error('Cannot access contents of the page'));

    await expect(harness.send('SWITCH_TO_STEPS_MODE'))
      .resolves.toEqual({ ok: false, error: t().background.switchToStepsFailed });

    expect(harness.getState()).toMatchObject({
      mode: 'snapshot',
      phase: 'preparing-next',
      recoverableError: { code: 'SWITCH_TO_STEPS_FAILED' },
    });
    expect(harness.control.acceptingClicks).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { createControlPlane } from '@/lib/recording/background/control-plane';
import { createRecorderMessages } from '@/lib/recording/background/recorder-messages';
import { createRunState } from '@/lib/recording/background/run-state';
import { assertCaptureNotCancelled, releaseCapture } from '@/lib/recording/background/capture-registry';
import { StaleCaptureError } from '@/lib/recording/background-queues';
import type { RunEnding } from '@/lib/recording/background/run-ending';
import type { RecordingState } from '@/lib/storage/recording-state';
import { t } from '@/lib/shared/i18n';
import { makeRecordingState } from '../setup/recording-state';

/**
 * The recorder's own reports against the real control plane, ready gate and
 * run-state writes; recording state is a live in-memory cell.
 */

const mocks = await vi.hoisted(async () =>
  (await import('../setup/background-test-utils')).makeBackgroundMocks());

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));

const PAGE_URL = 'https://site.example/page';
const RUN_ID = 'run-1';
const TAB_ID = 4;
const VIEWPORT = { width: 1280, height: 720, scrollX: 0, scrollY: 0 };

function sender(overrides: { frameId?: number; tabId?: number } = {}): Browser.runtime.MessageSender {
  return {
    frameId: overrides.frameId ?? 0,
    url: PAGE_URL,
    tab: { id: overrides.tabId ?? TAB_ID, windowId: 6, url: PAGE_URL },
  } as unknown as Browser.runtime.MessageSender;
}

function liveRun(overrides: Partial<RecordingState> = {}): RecordingState {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    mode: 'steps',
    sessionId: 'project-a',
    runId: RUN_ID,
    tabId: TAB_ID,
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

let state: RecordingState;
let control: ReturnType<typeof createControlPlane>;
let stopRunWithError: ReturnType<typeof vi.fn>;
let messages: ReturnType<typeof createRecorderMessages>;

beforeEach(() => {
  vi.clearAllMocks();
  state = liveRun();
  mocks.getRecordingState.mockImplementation(async () => state);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    state = next;
  });
  control = createControlPlane({ discardPendingUndo: vi.fn() });
  stopRunWithError = vi.fn().mockResolvedValue(undefined);
  messages = createRecorderMessages({
    control,
    runState: createRunState({ control }),
    runEnding: { stopRunWithError, handleRecordedTabGone: vi.fn() } as unknown as RunEnding,
  });
});

describe('HOWBEAM_READY', () => {
  const ready = (snapshotContext?: unknown) =>
    ({ type: 'HOWBEAM_READY', runId: RUN_ID, ...(snapshotContext ? { snapshotContext } : {}) }) as never;

  it('opens the startup gate that waits for this recorder and keeps its snapshot context', async () => {
    const context = { url: PAGE_URL, viewport: VIEWPORT, devicePixelRatio: 2, timestamp: 1 };
    let delivered: unknown;
    const startup = control.withRecorderReadyGate({
      slot: 'pendingRecorderReady',
      identity: { runId: RUN_ID, tabId: TAB_ID, controlVersion: control.controlVersion },
      inject: async () => {
        await expect(messages.handleRecorderReady(ready(context), sender())).resolves.toBe(true);
      },
      notReadyError: () => new Error('not ready'),
      ready: async () => {
        delivered = control.pendingSnapshotContext;
      },
    });

    await startup;
    expect(delivered).toEqual(context);
  });

  it('accepts a re-injected recorder of a run that is already live', async () => {
    await expect(messages.handleRecorderReady(ready(), sender())).resolves.toBe(true);

    state = liveRun({ phase: 'paused' });
    control.acceptingClicks = false;
    await expect(messages.handleRecorderReady(ready(), sender())).resolves.toBe(true);
  });

  it('turns down a recorder no run is waiting for', async () => {
    control.acceptingClicks = false;

    await expect(messages.handleRecorderReady(ready(), sender())).resolves.toBe(false);
  });

  it('turns down a sub-frame, another tab and another run', async () => {
    await expect(messages.handleRecorderReady(ready(), sender({ frameId: 2 }))).resolves.toBe(false);
    await expect(messages.handleRecorderReady(ready(), sender({ tabId: 9 }))).resolves.toBe(false);
    state = liveRun({ runId: 'run-2' });
    await expect(messages.handleRecorderReady(ready(), sender())).resolves.toBe(false);
  });
});

describe('SNAPSHOT_INVALIDATED', () => {
  const invalidated = (viewport = { ...VIEWPORT, scrollY: 200 }, devicePixelRatio = 2) =>
    ({ type: 'SNAPSHOT_INVALIDATED', runId: RUN_ID, viewport, devicePixelRatio }) as never;

  it('invalidates the snapshot when the page moved under it', async () => {
    state = snapshotRun();

    await expect(messages.handleSnapshotInvalidated(invalidated(), sender())).resolves.toBe(true);

    expect(state).toMatchObject({
      phase: 'invalidated',
      recoverableError: { code: 'SNAPSHOT_VIEWPORT_CHANGED' },
    });
  });

  it('answers an already invalidated snapshot without writing again', async () => {
    state = snapshotRun({ phase: 'invalidated' });

    await expect(messages.handleSnapshotInvalidated(invalidated(), sender())).resolves.toBe(true);
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('ignores a steps run and an impossible viewport', async () => {
    await expect(messages.handleSnapshotInvalidated(invalidated(), sender())).resolves.toBe(false);

    state = snapshotRun();
    await expect(messages.handleSnapshotInvalidated(invalidated(VIEWPORT, 0), sender())).resolves.toBe(false);
    expect(state.phase).toBe('recording');
  });
});

describe('SNAPSHOT_RECORDER_FAILED', () => {
  const failed = { type: 'SNAPSHOT_RECORDER_FAILED', runId: RUN_ID } as never;

  it('ends the snapshot run with the shield notice', async () => {
    state = snapshotRun();

    await expect(messages.handleSnapshotRecorderFailure(failed, sender())).resolves.toBe(true);

    expect(stopRunWithError).toHaveBeenCalledWith(
      RUN_ID,
      t().background.shieldInterrupted,
      control.controlVersion,
      { code: 'SNAPSHOT_SHIELD_FAILED', message: t().background.shieldInterrupted },
    );
  });

  it('ignores it from a steps run', async () => {
    await expect(messages.handleSnapshotRecorderFailure(failed, sender())).resolves.toBe(false);
    expect(stopRunWithError).not.toHaveBeenCalled();
  });
});

describe('HOWBEAM_CANCEL_CAPTURE', () => {
  const cancel = { type: 'HOWBEAM_CANCEL_CAPTURE', runId: RUN_ID, captureId: 'capture-9' } as never;

  it('cancels the capture for the recorded tab’s recorder', async () => {
    await expect(messages.handleCancelCapture(cancel, sender())).resolves.toEqual({ ok: true });

    expect(() => assertCaptureNotCancelled('capture-9')).toThrow(StaleCaptureError);
    releaseCapture('capture-9');
  });

  it('turns down any other sender', async () => {
    await expect(messages.handleCancelCapture(cancel, sender({ tabId: 9 })))
      .resolves.toEqual({ ok: false, error: 'untrusted-sender' });

    expect(() => assertCaptureNotCancelled('capture-9')).not.toThrow();
  });
});

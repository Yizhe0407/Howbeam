// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepRecaptureContext } from '@/lib/storage/recording-state';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  resolveTarget: vi.fn(),
  preview: {
    show: vi.fn(),
    hide: vi.fn(),
    prepareForCapture: vi.fn(async () => {}),
    remove: vi.fn(),
  },
  keepAliveStop: vi.fn(),
  getRecordingState: vi.fn(),
  stateListeners: [] as Array<(state: unknown) => void>,
  unsubscribe: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      sendMessage: mocks.sendMessage,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));
vi.mock('@/lib/recording/snapshot-targeting', () => ({
  CLEANUP_EVENT: 'howbeam_cleanup_test-extension',
  resolveSnapshotTargetAtPoint: mocks.resolveTarget,
}));
vi.mock('@/lib/capture/step-preview', () => ({
  createStepPreview: () => mocks.preview,
}));
vi.mock('@/lib/runtime/keep-alive', () => ({
  KEEPALIVE_PORT_NAME: 'howbeam-keepalive',
  startKeepAlive: vi.fn(() => ({ stop: mocks.keepAliveStop })),
}));
vi.mock('@/lib/storage/storage', () => ({
  getRecordingState: mocks.getRecordingState,
  onRecordingStateChange: vi.fn((callback: (state: unknown) => void) => {
    mocks.stateListeners.push(callback);
    return mocks.unsubscribe;
  }),
}));
// jsdom performs no hit-testing or layout, so the gutter guards would misfire
// on the synthetic coordinates used here. Their logic has dedicated tests.
vi.mock('@/lib/recording/recording-guards', () => ({
  isInScrollbarGutter: () => false,
  isInScrollableElementGutter: () => false,
  isPointInAnyScrollGutter: () => false,
}));
vi.mock('@/lib/capture/selector/element-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/capture/selector/element-availability')>()),
  deepElementFromPoint: () => null,
  getComposedParent: () => null,
}));

import { installRecaptureRecorder } from '@/lib/recording/recapture-recorder';
import { itemAt } from '../setup/item-at';

const RUN_ID = 'run-1';

function context(): StepRecaptureContext {
  return {
    runId: RUN_ID,
    sessionId: 'session-1',
    target: { kind: 'single', stepId: 'step-1' },
    entryId: 'entry-1',
    phase: 'awaiting-target',
    sourceTabId: 2,
    sourceWindowId: 3,
    sourceUrl: 'https://example.com/',
    sourceTabCreated: false,
    startedAt: Date.now(),
  };
}

function recaptureState(phase: string, runId = RUN_ID): unknown {
  return { operation: 'recapture', recapture: { runId, phase } };
}

function emitState(state: unknown): void {
  for (const listener of mocks.stateListeners) listener(state);
}

const TARGET = {
  rect: { x: 10, y: 20, width: 100, height: 40 },
  identity: 'button#save',
  text: 'Save',
  tagName: 'button',
};

class TestPointerEvent extends MouseEvent {
  readonly isPrimary = true;
  constructor(type: string, init: MouseEventInit = {}) {
    super(type, { bubbles: true, cancelable: true, ...init });
  }
}

function pointerDown(x = 50, y = 40): TestPointerEvent {
  const event = new TestPointerEvent('pointerdown', { button: 0, clientX: x, clientY: y });
  document.body.dispatchEvent(event);
  return event;
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function targetMessages() {
  return mocks.sendMessage.mock.calls.filter(([message]) => message?.type === 'HOWBEAM_RECAPTURE_TARGET');
}

async function install(): Promise<void> {
  await installRecaptureRecorder(context());
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'capture-1' });
  mocks.stateListeners.length = 0;
  mocks.sendMessage.mockReset().mockImplementation(async (message: { type: string }) => {
    if (message.type === 'HOWBEAM_RECAPTURE_READY') return true;
    if (message.type === 'HOWBEAM_RECAPTURE_TARGET') return { ok: true, status: 'replaced' };
    if (message.type === 'CANCEL_STEP_RECAPTURE') return { ok: true, status: 'cancelled' };
    return true;
  });
  mocks.resolveTarget.mockReset().mockResolvedValue(TARGET);
  mocks.getRecordingState.mockReset().mockResolvedValue(recaptureState('awaiting-target'));
  mocks.preview.show.mockReset();
  mocks.preview.hide.mockReset();
  mocks.preview.prepareForCapture.mockReset().mockResolvedValue(undefined);
  mocks.preview.remove.mockReset();
  mocks.keepAliveStop.mockReset();
  mocks.unsubscribe.mockReset();
});

afterEach(() => {
  // Tear down any recorder a test left installed so listeners never leak.
  emitState({ operation: null, recapture: null });
  document.querySelectorAll('[data-howbeam-recording-toolbar]').forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

describe('installRecaptureRecorder', () => {
  it('announces readiness, mounts the toolbar, and arms target selection', async () => {
    await install();

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'HOWBEAM_RECAPTURE_READY', runId: RUN_ID }),
    );
    expect(document.querySelector('[data-howbeam-recording-toolbar]')).not.toBeNull();

    pointerDown();
    await flush();
    expect(targetMessages()).toHaveLength(1);
    expect(itemAt(targetMessages(), 0)[0]).toMatchObject({ runId: RUN_ID, rect: TARGET.rect });
    expect(mocks.preview.prepareForCapture).toHaveBeenCalledTimes(1);
  });

  it('tears down immediately when the background refuses readiness', async () => {
    mocks.sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === 'HOWBEAM_RECAPTURE_READY' ? false : true,
    );

    await install();

    expect(document.querySelector('[data-howbeam-recording-toolbar]')).toBeNull();
    expect(mocks.preview.remove).toHaveBeenCalled();
    expect(mocks.keepAliveStop).toHaveBeenCalled();
  });

  it('swallows clicks while a capture is in flight', async () => {
    let settle!: (value: unknown) => void;
    mocks.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'HOWBEAM_RECAPTURE_READY') return true;
      return new Promise((resolve) => {
        settle = resolve;
      });
    });
    await install();

    pointerDown();
    await flush();
    expect(targetMessages()).toHaveLength(1);

    const second = pointerDown();
    await flush();
    expect(second.defaultPrevented).toBe(true);
    expect(targetMessages()).toHaveLength(1);
    expect(mocks.resolveTarget).toHaveBeenCalledTimes(1);
    settle({ ok: true, status: 'replaced' });
  });

  it('re-arms immediately when the background rejects the selected target', async () => {
    mocks.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'HOWBEAM_RECAPTURE_READY') return true;
      return { ok: false, status: 'rejected' };
    });
    await install();

    pointerDown();
    await flush();
    expect(mocks.preview.show).toHaveBeenCalledWith(TARGET.rect);

    pointerDown();
    await flush();
    expect(targetMessages()).toHaveLength(2);
  });

  it('resets a stuck busy flag when the background re-enters awaiting-target', async () => {
    await install();

    pointerDown();
    await flush();
    expect(targetMessages()).toHaveLength(1);

    // The background owns 'failed' and 'cancelled' outcomes: it moves to
    // capturing, fails internally, and re-arms target selection.
    emitState(recaptureState('capturing'));
    emitState(recaptureState('awaiting-target'));

    pointerDown();
    await flush();
    expect(targetMessages()).toHaveLength(2);
  });

  it('keeps the busy flag through a repeated awaiting-target notification', async () => {
    let settle!: (value: unknown) => void;
    mocks.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'HOWBEAM_RECAPTURE_READY') return true;
      return new Promise((resolve) => {
        settle = resolve;
      });
    });
    await install();

    pointerDown();
    await flush();
    expect(targetMessages()).toHaveLength(1);

    // A storage echo of the same phase is not a transition; clearing busy here
    // would let a second click race the in-flight capture.
    emitState(recaptureState('awaiting-target'));

    pointerDown();
    await flush();
    expect(targetMessages()).toHaveLength(1);
    settle({ ok: true, status: 'replaced' });
  });

  it('cleans up when the recording state moves to another operation', async () => {
    await install();

    emitState({ operation: null, recapture: null });

    expect(document.querySelector('[data-howbeam-recording-toolbar]')).toBeNull();
    expect(mocks.preview.remove).toHaveBeenCalled();
    expect(mocks.keepAliveStop).toHaveBeenCalled();
    expect(mocks.unsubscribe).toHaveBeenCalled();

    pointerDown();
    await flush();
    expect(targetMessages()).toHaveLength(0);
  });

  it('cancels the workflow from the Escape key', async () => {
    await install();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await flush();

    expect(mocks.sendMessage).toHaveBeenCalledWith({ type: 'CANCEL_STEP_RECAPTURE', runId: RUN_ID });
  });
});

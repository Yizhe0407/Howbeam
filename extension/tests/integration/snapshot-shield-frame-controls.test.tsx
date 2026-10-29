// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';
import {
  SNAPSHOT_SHIELD_INIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_TOOLBAR_STATE,
  type SnapshotShieldFrameMessage,
} from '@/lib/recording/snapshot-shield-protocol';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  storageGet: vi.fn(async (key: string) => ({
    [key]: { token: 'test-token', createdAt: Date.now() },
  })),
  storageRemove: vi.fn(async () => undefined),
}));

vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: mocks.render }),
}));
vi.mock('@/lib/recording/recording-toolbar', () => ({ default: () => null }));
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { id: 'test-extension' },
    storage: {
      local: { get: mocks.storageGet, remove: mocks.storageRemove },
      // The shield follows the stored language preference, like every page.
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('snapshot shield frame controls', () => {
  it('releases timed-out captures and settles failed toolbar commands', async () => {
    silenceIntentionalErrorLogs();
    vi.useFakeTimers();
    // The URL only carries the public frame key; the secret init token is
    // served from (mocked) extension storage and consumed on read.
    window.history.replaceState({}, '', '/snapshot-shield.html?frame=frame-1');
    const port = {
      onmessage: null as ((event: MessageEvent<SnapshotShieldFrameMessage>) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage: vi.fn(),
      start: vi.fn(),
    };

    await import('@/entrypoints/snapshot-shield/main');
    // Init may arrive before the storage read resolves; the shield buffers it
    // and replays it once the expected token is known.
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { type: SNAPSHOT_SHIELD_INIT, token: 'test-token' },
        ports: [port as unknown as MessagePort],
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.storageRemove).toHaveBeenCalledOnce();
    expect(port.start).toHaveBeenCalledOnce();

    port.onmessage?.({
      data: {
        type: SNAPSHOT_SHIELD_TOOLBAR_STATE,
        token: 'test-token',
        state: {
          runId: 'run-1',
          mode: 'snapshot',
          phase: 'recording',
          itemCount: 0,
          runItemCount: 0,
          error: null,
        },
      },
    } as MessageEvent<SnapshotShieldFrameMessage>);

    const toolbar = mocks.render.mock.lastCall?.[0] as {
      props: { onCommand(action: string): Promise<unknown> };
    };

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 30 }));
    await vi.advanceTimersByTimeAsync(16);
    const pointerMoves = () => port.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === SNAPSHOT_SHIELD_POINTER_MOVE);
    expect(pointerMoves()).toHaveLength(1);

    port.onmessage?.({
      data: {
        type: SNAPSHOT_SHIELD_PREVIEW,
        token: 'test-token',
        requestId: 1,
        rect: { x: 10, y: 15, width: 120, height: 60 },
      },
    } as MessageEvent<SnapshotShieldFrameMessage>);
    // An answered probe on an unchanged point is not re-sent.
    await vi.advanceTimersByTimeAsync(16);
    expect(pointerMoves()).toHaveLength(1);

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 70 }));
    await vi.advanceTimersByTimeAsync(16);
    expect(pointerMoves()).toHaveLength(2);
    expect(pointerMoves()[1]).toMatchObject({ clientX: 60, clientY: 70 });

    // An unanswered probe is abandoned after the hover timeout and retried.
    await vi.advanceTimersByTimeAsync(4_016);
    expect(pointerMoves()).toHaveLength(3);

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 40,
      clientY: 50,
    });
    Object.defineProperty(pointerDown, 'isPrimary', { value: true });
    document.body.dispatchEvent(pointerDown);
    const firstCaptureCount = port.postMessage.mock.calls.filter(
      ([message]) => message.type === SNAPSHOT_SHIELD_POINTER_DOWN,
    ).length;
    expect(firstCaptureCount).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const secondPointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 45,
      clientY: 55,
    });
    Object.defineProperty(secondPointerDown, 'isPrimary', { value: true });
    document.body.dispatchEvent(secondPointerDown);
    expect(port.postMessage.mock.calls.filter(
      ([message]) => message.type === SNAPSHOT_SHIELD_POINTER_DOWN,
    )).toHaveLength(2);

    const timedOut = toolbar.props.onCommand('PAUSE_RECORDING');
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(timedOut).resolves.toEqual(expect.objectContaining({ ok: false }));

    port.postMessage.mockImplementationOnce(() => {
      throw new Error('port closed');
    });
    const failed = toolbar.props.onCommand('PAUSE_RECORDING');
    await expect(failed).resolves.toEqual(expect.objectContaining({ ok: false }));
  });
});

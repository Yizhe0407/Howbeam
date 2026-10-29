// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_INIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_TOOLBAR_STATE,
  type SnapshotShieldFrameMessage,
} from '@/lib/recording/snapshot-shield-protocol';

const mocks = vi.hoisted(() => ({
  storageGet: vi.fn(async (key: string) => ({
    [key]: { token: 'test-token', createdAt: Date.now() },
  })),
}));

vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: vi.fn() }),
}));
vi.mock('@/lib/recording/recording-toolbar', () => ({ default: () => null }));
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { id: 'test-extension' },
    storage: {
      local: { get: mocks.storageGet, remove: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function press(clientX: number, clientY: number) {
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX, clientY });
  Object.defineProperty(event, 'isPrimary', { value: true });
  document.body.dispatchEvent(event);
}

describe('snapshot shield click queue', () => {
  it('keeps clicks made before the shield is ready or while an annotation is processing, in order', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/snapshot-shield.html?frame=frame-q');
    const port = {
      onmessage: null as ((event: MessageEvent<SnapshotShieldFrameMessage>) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage: vi.fn(),
      start: vi.fn(),
    };
    await import('@/entrypoints/snapshot-shield/main');
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: { type: SNAPSHOT_SHIELD_INIT, token: 'test-token' },
      ports: [port as unknown as MessagePort],
    }));
    await vi.advanceTimersByTimeAsync(0);
    const pointerDowns = () => port.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === SNAPSHOT_SHIELD_POINTER_DOWN);
    const toolbarState = (phase: string) => port.onmessage?.({
      data: {
        type: SNAPSHOT_SHIELD_TOOLBAR_STATE,
        token: 'test-token',
        state: { runId: 'run-1', mode: 'snapshot', phase, itemCount: 0, runItemCount: 0, error: null },
      },
    } as MessageEvent<SnapshotShieldFrameMessage>);

    // Before any recording state, and while the run is still starting.
    press(10, 10);
    toolbarState('starting');
    press(20, 20);
    expect(pointerDowns()).toHaveLength(0);

    toolbarState('recording');
    expect(pointerDowns()).toEqual([expect.objectContaining({ clientX: 10, clientY: 10 })]);

    // A click while that annotation is still processing waits its turn.
    press(30, 30);
    expect(pointerDowns()).toHaveLength(1);
    port.onmessage?.({
      data: {
        type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
        token: 'test-token',
        captureId: pointerDowns()[0].captureId,
        selection: null,
      },
    } as MessageEvent<SnapshotShieldFrameMessage>);
    expect(pointerDowns().map((message) => [message.clientX, message.clientY])).toEqual([[10, 10], [20, 20]]);
    port.onmessage?.({
      data: {
        type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
        token: 'test-token',
        captureId: pointerDowns()[1].captureId,
        selection: null,
      },
    } as MessageEvent<SnapshotShieldFrameMessage>);
    expect(pointerDowns().map((message) => message.clientX)).toEqual([10, 20, 30]);

    // A snapshot that stops taking annotations drops whatever is still queued.
    press(40, 40);
    toolbarState('invalidated');
    toolbarState('recording');
    expect(pointerDowns()).toHaveLength(3);
  });
});

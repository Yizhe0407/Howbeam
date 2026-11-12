import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorderConnections, RecorderUnreachableError } from '@/lib/recording/background/recorder-connections';
import {
  RecorderConnectionLostError,
  createKeepAlivePortHandler,
  startKeepAlive,
  type KeepAlivePortLike,
} from '@/lib/runtime/keep-alive';

function serverPort(tabId: number, frameId = 0) {
  return {
    name: 'howbeam-keepalive',
    sender: { tab: { id: tabId }, frameId },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
  };
}

afterEach(() => vi.useRealTimers());

describe('recorder connections', () => {
  it('pushes to the tab’s recorder and resolves with its reply', async () => {
    const connections = createRecorderConnections();
    const port = serverPort(4);
    connections.connected(port);

    const answer = connections.request(4, { type: 'HOWBEAM_SNAPSHOT_ACTIVE', runId: 'run-1' });
    await Promise.resolve();
    const push = port.postMessage.mock.calls[0]![0] as { type: string; id: number; message: unknown };
    expect(push).toMatchObject({ type: 'push', message: { type: 'HOWBEAM_SNAPSHOT_ACTIVE', runId: 'run-1' } });

    connections.replied(port, { type: 'reply', id: push.id, value: true });
    await expect(answer).resolves.toBe(true);
  });

  it('fails a waiting push the moment its recorder disconnects', async () => {
    const connections = createRecorderConnections();
    const port = serverPort(4);
    connections.connected(port);

    const answer = connections.request(4, { type: 'HOWBEAM_SNAPSHOT_ACTIVE' });
    await Promise.resolve();
    connections.disconnected(port);

    await expect(answer).rejects.toBeInstanceOf(RecorderUnreachableError);
  });

  it('waits briefly for a recorder that is still connecting, then gives up', async () => {
    vi.useFakeTimers();
    const connections = createRecorderConnections();
    const late = connections.notify(5, { type: 'HOWBEAM_CAPTURE_TAKEN' });
    const port = serverPort(5);
    connections.connected(port);
    await late;
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'push',
      id: null,
      message: { type: 'HOWBEAM_CAPTURE_TAKEN' },
    });

    const never = connections.notify(6, { type: 'HOWBEAM_CAPTURE_TAKEN' });
    const failed = expect(never).rejects.toBeInstanceOf(RecorderUnreachableError);
    await vi.advanceTimersByTimeAsync(2_000);
    await failed;
  });

  it('ignores child-frame ports and replies from another port', async () => {
    const connections = createRecorderConnections();
    connections.connected(serverPort(4, 3));
    expect(connections.notifyIfConnected(4, { type: 'HOWBEAM_STOP' })).toBe(false);

    const top = serverPort(4);
    const other = serverPort(7);
    connections.connected(top);
    connections.connected(other);
    const answer = connections.request(4, {});
    await Promise.resolve();
    const { id } = top.postMessage.mock.calls[0]![0] as { id: number };
    connections.replied(other, { type: 'reply', id, value: 'forged' });
    connections.replied(top, { type: 'reply', id, value: 'real' });
    await expect(answer).resolves.toBe('real');
  });
});

describe('the recorder side of the connection', () => {
  function clientPort() {
    let onMessage: ((message: unknown) => void) | undefined;
    const port = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (listener: (message: unknown) => void) => (onMessage = listener) },
      onDisconnect: { addListener: () => {} },
    } satisfies KeepAlivePortLike;
    return { port, emit: (message: unknown) => onMessage?.(message) };
  }

  it('hands pushes to the recorder and answers the ones that ask', async () => {
    const { port, emit } = clientPort();
    const onPush = vi.fn((message: unknown) => ((message as { type: string }).type === 'ACTIVATE' ? true : undefined));
    const handle = startKeepAlive({ connect: () => port }, { name: 'howbeam-keepalive', intervalMs: 60_000, onPush });

    emit({ type: 'push', id: null, message: { type: 'HOWBEAM_STOP' } });
    emit({ type: 'push', id: 9, message: { type: 'ACTIVATE' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(onPush).toHaveBeenCalledWith({ type: 'HOWBEAM_STOP' });
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'reply', id: 9, value: true });
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});

describe('requests over the connection', () => {
  function clientPort() {
    let onMessage: ((message: unknown) => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    const port = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (listener: (message: unknown) => void) => (onMessage = listener) },
      onDisconnect: { addListener: (listener: () => void) => (onDisconnect = listener) },
    } satisfies KeepAlivePortLike;
    return { port, emit: (message: unknown) => onMessage?.(message), drop: () => onDisconnect?.() };
  }

  it('resolves a request with the background’s response', async () => {
    const { port, emit } = clientPort();
    const handle = startKeepAlive({ connect: () => port }, { name: 'howbeam-keepalive', intervalMs: 60_000 });

    const answer = handle.request({ type: 'HOWBEAM_CLICK' });
    const sent = port.postMessage.mock.calls.at(-1)![0] as { type: string; id: number };
    expect(sent).toMatchObject({ type: 'request', message: { type: 'HOWBEAM_CLICK' } });
    emit({ type: 'response', id: sent.id, value: { ok: true } });

    await expect(answer).resolves.toEqual({ ok: true });
    handle.stop();
  });

  it('fails a request the moment the connection drops, instead of waiting', async () => {
    const { port, drop } = clientPort();
    const handle = startKeepAlive({ connect: () => port }, { name: 'howbeam-keepalive', intervalMs: 60_000 });

    const answer = handle.request({ type: 'STOP_RECORDING' });
    drop();

    await expect(answer).rejects.toBeInstanceOf(RecorderConnectionLostError);
    handle.stop();
  });

  it('answers every request on the background side, with nothing when no handler is set', async () => {
    const port = { ...serverPort(4), onMessage: { addListener: vi.fn() } };
    createKeepAlivePortHandler<{ tab?: { id?: number }; frameId?: number }, object>({
      getRecordingState: async () => ({}),
      isTrustedKeepAliveSender: () => true,
      acknowledgeDisconnect: () => {},
    })(port);
    const listener = port.onMessage.addListener.mock.calls[0]![0] as (message: unknown) => void;

    listener({ type: 'request', id: 5, message: { type: 'HOWBEAM_READY' } });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'response', id: 5, value: undefined }),
    );
  });
});

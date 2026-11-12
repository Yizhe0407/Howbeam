import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEEPALIVE_PORT_NAME,
  KEEPALIVE_REJECTED_MESSAGE_TYPE,
  createKeepAlivePortHandler,
  startKeepAlive,
  type KeepAlivePortLike,
} from '@/lib/runtime/keep-alive';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

function port(): KeepAlivePortLike & {
  disconnect: ReturnType<typeof vi.fn>;
  emitDisconnect(): void;
  emitMessage(message: unknown): void;
} {
  let listener: (() => void) | undefined;
  let messageListener: ((message: unknown) => void) | undefined;
  const result = {
    postMessage: vi.fn(),
    disconnect: vi.fn(() => listener?.()),
    onMessage: {
      addListener: (next: (message: unknown) => void) => {
        messageListener = next;
      },
    },
    onDisconnect: {
      addListener: (next: () => void) => {
        listener = next;
      },
    },
    emitDisconnect: () => listener?.(),
    emitMessage: (message: unknown) => messageListener?.(message),
  };
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startKeepAlive', () => {
  it('backs off after connect failures instead of recursively spinning', () => {
    silenceIntentionalErrorLogs();
    vi.useFakeTimers();
    const first = port();
    const connect = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('extension reloading');
      })
      .mockImplementationOnce(() => first);
    const handle = startKeepAlive({ connect }, { name: 'test', intervalMs: 100, initialReconnectDelayMs: 10 });

    expect(connect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(9);
    expect(connect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('reconnects a disconnected port with a delay and never uses a stale port', () => {
    vi.useFakeTimers();
    const first = port();
    const second = port();
    const connect = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const handle = startKeepAlive({ connect }, { name: 'test', intervalMs: 100, initialReconnectDelayMs: 20 });

    first.emitDisconnect();
    vi.advanceTimersByTime(19);
    expect(connect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(first.postMessage).not.toHaveBeenCalled();
    expect(second.postMessage).toHaveBeenCalledWith({ type: 'heartbeat' });
    handle.stop();
  });

  it('backs off repeated short-lived connections until a heartbeat succeeds', () => {
    vi.useFakeTimers();
    const first = port();
    const second = port();
    const third = port();
    const fourth = port();
    const connect = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third)
      .mockReturnValueOnce(fourth);
    const handle = startKeepAlive({ connect }, { name: 'test', intervalMs: 100, initialReconnectDelayMs: 10 });

    first.emitDisconnect();
    vi.advanceTimersByTime(10);
    second.emitDisconnect();
    vi.advanceTimersByTime(19);
    expect(connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(100);
    expect(third.postMessage).toHaveBeenCalledWith({ type: 'heartbeat' });
    third.emitDisconnect();
    vi.advanceTimersByTime(9);
    expect(connect).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(4);
    handle.stop();
  });

  it('reconnects when a heartbeat throws and stop cancels future retries', () => {
    silenceIntentionalErrorLogs();
    vi.useFakeTimers();
    const first = port();
    const firstPost = vi.spyOn(first, 'postMessage');
    firstPost.mockImplementation(() => {
      throw new Error('disconnected');
    });
    const second = port();
    const connect = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const handle = startKeepAlive({ connect }, { name: 'test', intervalMs: 10, initialReconnectDelayMs: 5 });

    vi.advanceTimersByTime(10);
    expect(first.disconnect).toHaveBeenCalledOnce();
    handle.stop();
    vi.advanceTimersByTime(100);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('stops for good and notifies onRejected when the background rejects the port', () => {
    vi.useFakeTimers();
    const first = port();
    const connect = vi.fn().mockReturnValue(first);
    const onRejected = vi.fn();
    startKeepAlive({ connect }, { name: 'test', intervalMs: 100, initialReconnectDelayMs: 10, onRejected });

    first.emitMessage({ type: 'unrelated' });
    expect(onRejected).not.toHaveBeenCalled();

    first.emitMessage({ type: KEEPALIVE_REJECTED_MESSAGE_TYPE });
    expect(onRejected).toHaveBeenCalledOnce();
    expect(first.disconnect).toHaveBeenCalledOnce();

    // The background's follow-up disconnect and any amount of time must not
    // schedule another connection for an authoritatively rejected client.
    first.emitDisconnect();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('gives up after consecutive failed connection cycles without a heartbeat', () => {
    silenceIntentionalErrorLogs();
    vi.useFakeTimers();
    const first = port();
    const second = port();
    const third = port();
    const connect = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third);
    const onRejected = vi.fn();
    startKeepAlive(
      { connect },
      {
        name: 'test',
        intervalMs: 100,
        initialReconnectDelayMs: 10,
        maxConsecutiveFailures: 2,
        onRejected,
      },
    );

    first.emitDisconnect();
    vi.advanceTimersByTime(10);
    second.emitDisconnect();
    vi.advanceTimersByTime(20);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(onRejected).not.toHaveBeenCalled();

    third.emitDisconnect();
    expect(onRejected).toHaveBeenCalledOnce();
    expect(third.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('suspend closes the port cleanly and neither heartbeats nor reconnects while suspended', () => {
    vi.useFakeTimers();
    const first = port();
    const connect = vi.fn().mockReturnValue(first);
    const handle = startKeepAlive({ connect }, { name: 'test', intervalMs: 100, initialReconnectDelayMs: 10 });

    handle.suspend();
    expect(first.disconnect).toHaveBeenCalledOnce();
    // The browser-side disconnect of the handed-back port must not be read as
    // a failure that schedules a reconnect into a frozen document.
    first.emitDisconnect();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledOnce();
    expect(first.postMessage).not.toHaveBeenCalled();
    handle.stop();
  });

  it('resume reconnects immediately with fresh backoff and heartbeats again', () => {
    vi.useFakeTimers();
    const first = port();
    const second = port();
    const connect = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const handle = startKeepAlive(
      { connect },
      { name: 'test', intervalMs: 100, initialReconnectDelayMs: 10, maxConsecutiveFailures: 2 },
    );

    // Rack up a failed cycle so a suspend/resume can prove the counter reset.
    first.emitDisconnect();
    handle.suspend();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledOnce();

    handle.resume();
    expect(connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(second.postMessage).toHaveBeenCalledWith({ type: 'heartbeat' });
    // Resuming twice must not open a second port.
    handle.resume();
    expect(connect).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('suspend and resume are no-ops after stop', () => {
    vi.useFakeTimers();
    const first = port();
    const connect = vi.fn().mockReturnValue(first);
    const handle = startKeepAlive({ connect }, { name: 'test', intervalMs: 100, initialReconnectDelayMs: 10 });

    handle.stop();
    expect(first.disconnect).toHaveBeenCalledOnce();
    handle.suspend();
    handle.resume();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledOnce();
  });
});

describe('createKeepAlivePortHandler', () => {
  interface ServerPortOverrides {
    name?: string;
    sender?: { tabId?: number };
  }

  function serverPort(overrides: ServerPortOverrides = {}) {
    let onMessage: ((message: unknown) => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    return {
      name: overrides.name ?? KEEPALIVE_PORT_NAME,
      sender: overrides.sender,
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => {
          onMessage = listener;
        }),
      },
      onDisconnect: {
        addListener: vi.fn((listener: () => void) => {
          onDisconnect = listener;
        }),
      },
      emitMessage: (message: unknown) => onMessage?.(message),
      emitDisconnect: () => onDisconnect?.(),
    };
  }

  function makeHandler(
    options: {
      trusted?: boolean;
      stateError?: Error;
    } = {},
  ) {
    const acknowledgeDisconnect = vi.fn();
    const handler = createKeepAlivePortHandler<{ tabId?: number }, { live: boolean }>({
      getRecordingState: options.stateError
        ? () => Promise.reject(options.stateError)
        : () => Promise.resolve({ live: true }),
      isTrustedKeepAliveSender: () => options.trusted === true,
      acknowledgeDisconnect,
    });
    return { handler, acknowledgeDisconnect };
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it('ignores ports that do not carry the keep-alive name', async () => {
    const { handler } = makeHandler({ trusted: false });
    const port = serverPort({ name: 'other-port' });

    handler(port);
    await flush();

    expect(port.onMessage.addListener).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.disconnect).not.toHaveBeenCalled();
  });

  it('keeps a trusted port connected across heartbeats', async () => {
    const { handler } = makeHandler({ trusted: true });
    const port = serverPort({ sender: { tabId: 4 } });

    handler(port);
    await flush();
    port.emitMessage({ type: 'heartbeat' });
    await flush();

    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.disconnect).not.toHaveBeenCalled();
  });

  it('posts the authoritative rejection before disconnecting an untrusted port', async () => {
    const { handler } = makeHandler({ trusted: false });
    const port = serverPort();

    handler(port);
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith({ type: KEEPALIVE_REJECTED_MESSAGE_TYPE });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects a port that sends anything but a heartbeat', async () => {
    const { handler } = makeHandler({ trusted: true });
    const port = serverPort();

    handler(port);
    await flush();
    port.emitMessage({ type: 'exfiltrate' });

    expect(port.postMessage).toHaveBeenCalledWith({ type: KEEPALIVE_REJECTED_MESSAGE_TYPE });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('drops the port without the rejection message when reading state fails', async () => {
    silenceIntentionalErrorLogs();
    const { handler } = makeHandler({ stateError: new Error('storage gone') });
    const port = serverPort();

    handler(port);
    await flush();

    // A state read failure says nothing about the sender: no rejection, so a
    // healthy recorder is free to reconnect.
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('acknowledges the runtime disconnect and stops answering afterwards', async () => {
    const { handler, acknowledgeDisconnect } = makeHandler({ trusted: false });
    const port = serverPort();

    handler(port);
    port.emitDisconnect();
    await flush();

    expect(acknowledgeDisconnect).toHaveBeenCalledOnce();
    // Authorization resolved after the disconnect: no post into a dead port.
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.disconnect).not.toHaveBeenCalled();
  });
});

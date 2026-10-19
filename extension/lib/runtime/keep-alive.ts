export const KEEPALIVE_PORT_NAME = 'howbeam-keepalive';

/** 不同於單純斷線，此訊息確認擷取工作已不存在。 */
export const KEEPALIVE_REJECTED_MESSAGE_TYPE = 'howbeam-keepalive-rejected';

function isKeepAliveRejectionMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === KEEPALIVE_REJECTED_MESSAGE_TYPE
  );
}

function isKeepAliveHeartbeat(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'heartbeat'
  );
}

export interface KeepAlivePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface KeepAliveServerPortLike<TSender = unknown> extends KeepAlivePortLike {
  name: string;
  sender?: TSender;
}

export interface KeepAlivePortHandlerDeps<TSender, TState> {
  getRecordingState(): Promise<TState>;
  /** 將 port 來源綁定至目前的擷取工作。 */
  isTrustedKeepAliveSender(sender: TSender | undefined, state: TState): boolean;
  /** 讀取 runtime.lastError，避免 bfcache 斷線產生 Chrome 警告。 */
  acknowledgeDisconnect(): void;
}

/** 驗證 keep-alive port，並明確拒絕孤立 client，避免無限喚醒 worker。 */
export function createKeepAlivePortHandler<TSender, TState>(
  deps: KeepAlivePortHandlerDeps<TSender, TState>,
): (port: KeepAliveServerPortLike<TSender>) => void {
  return (port) => {
    if (port.name !== KEEPALIVE_PORT_NAME) return;
    let disconnected = false;
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      try {
        port.disconnect();
      } catch {
        // The sender may already have disappeared during authorization.
      }
    };
    const reject = () => {
      if (disconnected) return;
      try {
        port.postMessage({ type: KEEPALIVE_REJECTED_MESSAGE_TYPE });
      } catch {
        // The port may already be gone; the client's give-up cap still applies.
      }
      disconnect();
    };
    const authorize = () => {
      void deps.getRecordingState().then((state) => {
        if (!disconnected && !deps.isTrustedKeepAliveSender(port.sender, state)) reject();
      }).catch((error) => {
        // Reading state failed, which says nothing about the sender: drop the
        // port without the rejection message so a healthy recorder reconnects.
        console.error('[howbeam] failed to authorize keep-alive port', error);
        disconnect();
      });
    };
    port.onDisconnect.addListener(() => {
      disconnected = true;
      deps.acknowledgeDisconnect();
    });
    port.onMessage.addListener((message) => {
      if (!isKeepAliveHeartbeat(message)) {
        reject();
        return;
      }
      authorize();
    });
    authorize();
  };
}

export interface KeepAliveRuntimeLike {
  connect(options: { name: string }): KeepAlivePortLike;
}

export interface KeepAliveOptions {
  name: string;
  intervalMs: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** 放棄前可容許的連線失敗週期數。 */
  maxConsecutiveFailures?: number;
  /** 遭拒或耗盡重試後呼叫；此時 handle 已停止。 */
  onRejected?: () => void;
}

export interface KeepAliveHandle {
  stop(): void;
  /** bfcache 凍結文件前交還 port，且不計為失敗。 */
  suspend(): void;
  /** suspend 後重連並重設 backoff，因 bfcache 無法反映 worker 狀態。 */
  resume(): void;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;

/** 以受保護 port、有限指數 backoff 與孤立拒絕維持操作。 */
export function startKeepAlive(
  runtime: KeepAliveRuntimeLike,
  options: KeepAliveOptions,
): KeepAliveHandle {
  const initialReconnectDelayMs = Math.max(1, options.initialReconnectDelayMs ?? 250);
  const maxReconnectDelayMs = Math.max(initialReconnectDelayMs, options.maxReconnectDelayMs ?? 10_000);
  const intervalMs = Math.max(1, options.intervalMs);
  const maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES);

  let stopped = false;
  let suspended = false;
  let port: KeepAlivePortLike | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const giveUp = () => {
    if (stopped) return;
    stop();
    try {
      options.onRejected?.();
    } catch (error) {
      console.error('[howbeam] keep-alive rejection handler failed', error);
    }
  };

  const scheduleReconnect = () => {
    if (stopped || suspended || reconnectTimer !== null) return;
    if (reconnectAttempt >= maxConsecutiveFailures) {
      console.warn('[howbeam] keep-alive gave up after repeated failed reconnects');
      giveUp();
      return;
    }
    const delay = Math.min(
      maxReconnectDelayMs,
      initialReconnectDelayMs * 2 ** Math.min(reconnectAttempt, 10),
    );
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const disconnectCurrent = (expectedPort: KeepAlivePortLike) => {
    if (port !== expectedPort) return;
    port = null;
    clearHeartbeat();
    if (!stopped) scheduleReconnect();
  };

  const connect = () => {
    if (stopped || suspended || port !== null) return;
    let nextPort: KeepAlivePortLike;
    try {
      nextPort = runtime.connect({ name: options.name });
    } catch (error) {
      console.warn('[howbeam] keep-alive connection failed; retrying', error);
      scheduleReconnect();
      return;
    }

    port = nextPort;
    nextPort.onDisconnect.addListener(() => disconnectCurrent(nextPort));
    nextPort.onMessage.addListener((message) => {
      if (stopped || port !== nextPort || !isKeepAliveRejectionMessage(message)) return;
      giveUp();
    });

    const heartbeat = () => {
      if (stopped || port !== nextPort) return;
      try {
        nextPort.postMessage({ type: 'heartbeat' });
        reconnectAttempt = 0;
      } catch (error) {
        console.warn('[howbeam] keep-alive heartbeat failed; reconnecting', error);
        try {
          nextPort.disconnect();
        } catch {
          // The runtime may already have invalidated the port.
        }
        disconnectCurrent(nextPort);
      }
    };
    heartbeatTimer = setInterval(heartbeat, intervalMs);
  };

  const closeCurrentPort = () => {
    const current = port;
    port = null;
    if (current) {
      try {
        current.disconnect();
      } catch {
        // The runtime may already have disconnected this port.
      }
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearHeartbeat();
    clearReconnect();
    closeCurrentPort();
  };

  const suspend = () => {
    if (stopped || suspended) return;
    suspended = true;
    clearHeartbeat();
    clearReconnect();
    // A clean hand-back is not a failure; the next resume starts fresh.
    reconnectAttempt = 0;
    closeCurrentPort();
  };

  const resume = () => {
    if (stopped || !suspended) return;
    suspended = false;
    reconnectAttempt = 0;
    connect();
  };

  connect();
  return { stop, suspend, resume };
}

import type { KeepAliveServerPortLike, RecorderPush, RecorderReply } from '../../runtime/keep-alive';

interface SenderLike {
  tab?: { id?: number };
  frameId?: number;
}

type RecorderPort = KeepAliveServerPortLike<SenderLike>;

/** How long a push waits for a recorder that is still connecting (it connects before saying ready). */
const CONNECT_WAIT_MS = 2_000;

export class RecorderUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderUnreachableError';
  }
}

/**
 * The background's side of each recorded tab's connection: the top-frame
 * recorder's long-lived port, which already keeps the worker alive. Pushes to
 * the recorder go over it, and when it closes every push still waiting for an
 * answer fails at once instead of timing out.
 */
export function createRecorderConnections() {
  const byTab = new Map<number, RecorderPort>();
  const waiting = new Map<number, { port: RecorderPort; resolve(value: unknown): void; reject(error: Error): void }>();
  const connectWaiters = new Map<number, Set<(port: RecorderPort) => void>>();
  let nextId = 1;

  const tabOf = (port: RecorderPort): number | null => {
    const tabId = port.sender?.tab?.id;
    return port.sender?.frameId === 0 && tabId != null ? tabId : null;
  };

  function connected(port: RecorderPort): void {
    const tabId = tabOf(port);
    if (tabId === null) return;
    byTab.set(tabId, port);
    for (const resolve of connectWaiters.get(tabId) ?? []) resolve(port);
    connectWaiters.delete(tabId);
  }

  function disconnected(port: RecorderPort): void {
    const tabId = tabOf(port);
    if (tabId !== null && byTab.get(tabId) === port) byTab.delete(tabId);
    for (const [id, entry] of waiting) {
      if (entry.port !== port) continue;
      waiting.delete(id);
      entry.reject(new RecorderUnreachableError('The recorder disconnected before answering.'));
    }
  }

  function replied(port: RecorderPort, reply: RecorderReply): void {
    const entry = waiting.get(reply.id);
    if (!entry || entry.port !== port) return;
    waiting.delete(reply.id);
    entry.resolve(reply.value);
  }

  function connectionFor(tabId: number): Promise<RecorderPort> {
    const current = byTab.get(tabId);
    if (current) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const waiters = connectWaiters.get(tabId) ?? new Set();
      const onConnect = (port: RecorderPort) => {
        clearTimeout(timer);
        resolve(port);
      };
      const timer = setTimeout(() => {
        waiters.delete(onConnect);
        reject(new RecorderUnreachableError(`No recorder is connected in tab ${tabId}.`));
      }, CONNECT_WAIT_MS);
      waiters.add(onConnect);
      connectWaiters.set(tabId, waiters);
    });
  }

  function post(port: RecorderPort, push: RecorderPush): void {
    try {
      port.postMessage(push);
    } catch (error) {
      disconnected(port);
      throw new RecorderUnreachableError(`The recorder connection failed: ${String(error)}`);
    }
  }

  return {
    connected,
    disconnected,
    replied,
    /** Pushes a message to the tab's recorder and resolves with its answer. */
    async request(tabId: number, message: unknown): Promise<unknown> {
      const port = await connectionFor(tabId);
      const id = nextId++;
      const answer = new Promise<unknown>((resolve, reject) => waiting.set(id, { port, resolve, reject }));
      post(port, { type: 'push', id, message });
      return answer;
    },
    /** Pushes a message the recorder does not answer. Resolves once it is sent. */
    async notify(tabId: number, message: unknown): Promise<void> {
      post(await connectionFor(tabId), { type: 'push', id: null, message });
    },
    /** Pushes to every connected recorder (the run state: a recorder whose run ended must hear it too). */
    broadcast(message: unknown): void {
      for (const port of [...byTab.values()]) {
        try {
          post(port, { type: 'push', id: null, message });
        } catch {
          // That recorder is gone; the others still hear it.
        }
      }
    },
    /** Pushes to one connection (the state a recorder gets as it connects). */
    notifyPort(port: RecorderPort, message: unknown): void {
      try {
        post(port, { type: 'push', id: null, message });
      } catch {
        // It disconnected already.
      }
    },
    /** Pushes to the tab's recorder only if one is connected right now. */
    notifyIfConnected(tabId: number, message: unknown): boolean {
      const port = byTab.get(tabId);
      if (!port) return false;
      try {
        post(port, { type: 'push', id: null, message });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type RecorderConnections = ReturnType<typeof createRecorderConnections>;

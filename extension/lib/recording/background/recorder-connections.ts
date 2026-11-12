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
  /** Every connected recorder, by tab and frame (frame 0 is the top frame). */
  const frames = new Map<number, Map<number, RecorderPort>>();
  const portFor = (tabId: number, frameId: number) => frames.get(tabId)?.get(frameId);
  const waiting = new Map<number, { port: RecorderPort; resolve(value: unknown): void; reject(error: Error): void }>();
  const connectWaiters = new Map<number, Set<(port: RecorderPort) => void>>();
  let nextId = 1;

  const addressOf = (port: RecorderPort): { tabId: number; frameId: number } | null => {
    const tabId = port.sender?.tab?.id;
    const frameId = port.sender?.frameId;
    return tabId != null && frameId != null ? { tabId, frameId } : null;
  };

  function connected(port: RecorderPort): void {
    const address = addressOf(port);
    if (!address) return;
    const tabFrames = frames.get(address.tabId) ?? new Map<number, RecorderPort>();
    tabFrames.set(address.frameId, port);
    frames.set(address.tabId, tabFrames);
    if (address.frameId !== 0) return;
    for (const resolve of connectWaiters.get(address.tabId) ?? []) resolve(port);
    connectWaiters.delete(address.tabId);
  }

  function disconnected(port: RecorderPort): void {
    const address = addressOf(port);
    const tabFrames = address ? frames.get(address.tabId) : undefined;
    if (address && tabFrames?.get(address.frameId) === port) {
      tabFrames.delete(address.frameId);
      if (tabFrames.size === 0) frames.delete(address.tabId);
    }
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

  /** The tab's top-frame recorder, waiting briefly for one that is still connecting. */
  function connectionFor(tabId: number): Promise<RecorderPort> {
    const current = portFor(tabId, 0);
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
      for (const port of [...frames.values()].flatMap((tabFrames) => [...tabFrames.values()])) {
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
    /** Pushes to every recorder in the tab, top frame and child frames. */
    notifyTab(tabId: number, message: unknown): void {
      for (const port of [...(frames.get(tabId)?.values() ?? [])]) {
        try {
          post(port, { type: 'push', id: null, message });
        } catch {
          // That frame is gone; the others still hear it.
        }
      }
    },
    /** Pushes to one frame's recorder, if it is connected. */
    notifyFrame(tabId: number, frameId: number, message: unknown): boolean {
      const port = portFor(tabId, frameId);
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

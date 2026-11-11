import type { RecordingState } from '../../storage/recording-state';
import { fromRecordingState, idleState, toRecordingState, type RunState } from './state';

/** Where the run state lives between worker restarts. Only the background writes it. */
export interface RunStore {
  load(): Promise<RecordingState>;
  save(state: RecordingState): Promise<void>;
}

/** The in-flight operation was superseded by a newer control (stop, finish, a new start…). */
export class SupersededError extends Error {
  constructor() {
    super('The operation was superseded.');
    this.name = 'SupersededError';
  }
}

export function isSuperseded(error: unknown): boolean {
  return error instanceof SupersededError;
}

/** Awaits `promise`, or rejects with SupersededError as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SupersededError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SupersededError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export interface OperationContext {
  /** Aborts when a newer control supersedes this operation. */
  signal: AbortSignal;
  /** The state as of now; reading it never waits. */
  state(): RunState;
  /** Replaces the state and persists it before resolving. Throws SupersededError if superseded. */
  commit(next: RunState | ((current: RunState) => RunState)): Promise<RunState>;
  /** `abortable(promise, signal)`. */
  until<T>(promise: Promise<T>): Promise<T>;
}

/**
 * The single owner of the run state. Operations run one at a time; each sees
 * the state in memory and commits changes, which are written through to the
 * store. A control that changes what is running calls `claim()` first:
 * every operation queued or in flight before it is superseded at its next
 * await, so the new control never waits behind abandoned work.
 */
export function createRunActor(store: RunStore) {
  let state: RunState = idleState();
  let controller = new AbortController();
  let chain: Promise<unknown> = Promise.resolve();

  const loaded = store.load().then(
    (stored) => {
      state = fromRecordingState(stored);
    },
    (error: unknown) => {
      console.error('[howbeam] failed to read the recording state; starting idle', error);
    },
  );

  async function write(next: RunState): Promise<void> {
    state = next;
    await store.save(toRecordingState(next));
  }

  function context(signal: AbortSignal): OperationContext {
    return {
      signal,
      state: () => state,
      async commit(next) {
        if (signal.aborted) throw new SupersededError();
        const value = typeof next === 'function' ? next(state) : next;
        await write(value);
        return value;
      },
      until: (promise) => abortable(promise, signal),
    };
  }

  return {
    /** Resolves once the stored state has been read. */
    ready: () => loaded,

    state: () => state,

    /**
     * Supersedes every operation queued or running, and returns the signal
     * the next operations run under. Synchronous, so it takes effect before
     * the caller's first await.
     */
    claim(): AbortSignal {
      controller.abort();
      controller = new AbortController();
      return controller.signal;
    },

    /**
     * Runs `operation` after every operation queued before it. It runs under
     * the signal current when it was queued: a claim in between supersedes it
     * before it starts.
     */
    run<T>(operation: (ctx: OperationContext) => Promise<T>): Promise<T> {
      const signal = controller.signal;
      const task = async () => {
        await loaded;
        return operation(context(signal));
      };
      const result = chain.then(task, task);
      chain = result.then(() => undefined, () => undefined);
      return result;
    },

    /** Resolves when everything queued so far has finished. */
    settled(): Promise<void> {
      return chain.then(() => undefined);
    },
  };
}

export type RunActor = ReturnType<typeof createRunActor>;

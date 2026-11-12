type Callback = (lock: { name: string } | null) => unknown;

/** An exclusive-only LockManager: the Web Locks semantics the app relies on (ifAvailable, queueing, abort). */
export function createFakeLockManager(): LockManager {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const grant = (name: string, callback: Callback) => {
    held.add(name);
    return Promise.resolve(callback({ name })).finally(() => {
      held.delete(name);
      queues.get(name)?.shift()?.();
    });
  };
  const request = (name: string, optionsOrCallback: object | Callback, maybeCallback?: Callback) => {
    const options = (typeof optionsOrCallback === 'function' ? {} : optionsOrCallback) as {
      ifAvailable?: boolean;
      signal?: AbortSignal;
    };
    const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as Callback;
    if (!held.has(name)) return grant(name, callback);
    if (options.ifAvailable) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      const turn = () => {
        if (options.signal?.aborted) return queues.get(name)?.shift()?.();
        grant(name, callback).then(resolve, reject);
      };
      options.signal?.addEventListener('abort', () => {
        queues.set(
          name,
          (queues.get(name) ?? []).filter((queued) => queued !== turn),
        );
        reject(new DOMException('aborted', 'AbortError'));
      });
      queues.set(name, [...(queues.get(name) ?? []), turn]);
    });
  };
  return { request, query: async () => ({ held: [], pending: [] }) } as unknown as LockManager;
}

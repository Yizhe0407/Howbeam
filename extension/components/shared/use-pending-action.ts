import { useCallback, useRef, useState } from 'react';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';

/**
 * Ref-gated single-flight action runner: state updates are async, so a ref
 * (not just `pendingKey`) is needed to synchronously block overlapping calls
 * fired in the same event turn. `runExclusive` resolves `undefined` when
 * another action already holds the gate; callers still catch their own failures.
 * `shownKey` is `pendingKey` once the action proves slow: what to render as
 * busy, so a quick action changes nothing on screen.
 */
export function usePendingAction<K = string>() {
  const [pendingKey, setPendingKey] = useState<K | null>(null);
  const inFlight = useRef(false);
  const shown = useDeferredBusy(pendingKey !== null);
  const lastKey = useRef<K | null>(null);
  if (pendingKey !== null) lastKey.current = pendingKey;

  const runExclusive = useCallback(async <T,>(key: K, action: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPendingKey(key);
    try {
      return await action();
    } finally {
      inFlight.current = false;
      setPendingKey(null);
    }
  }, []);

  return { pendingKey, shownKey: shown ? lastKey.current : null, runExclusive };
}

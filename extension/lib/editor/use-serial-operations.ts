import { useCallback, useRef, useState } from 'react';

export interface RunningOperation {
  /** Progress copy, or null for an operation that shows its own progress. */
  label: string | null;
}

/**
 * Runs the editor's data operations one at a time, in the order they were asked
 * for. One asked for while another runs waits its turn instead of being refused,
 * so no click is ever dropped; each reads the Project afresh when its turn comes.
 * `running` is the operation holding the turn, or null once none is left.
 */
export function useSerialOperations() {
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const queued = useRef(0);
  const [running, setRunning] = useState<RunningOperation | null>(null);

  const run = useCallback(<T,>(label: string | null, operation: () => Promise<T>): Promise<T> => {
    queued.current += 1;
    const result = tail.current.then(() => {
      setRunning({ label });
      return operation();
    });
    const settle = () => {
      queued.current -= 1;
      if (queued.current === 0) setRunning(null);
    };
    tail.current = result.then(settle, settle);
    return result;
  }, []);

  /** Resolves once every operation asked for so far has finished. */
  const idle = useCallback((): Promise<void> => tail.current.then(() => undefined), []);

  return { run, idle, running };
}

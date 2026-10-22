// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSerialOperations } from '@/lib/editor/use-serial-operations';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useSerialOperations', () => {
  it('runs operations one at a time, in the order they were asked for', async () => {
    const { result } = renderHook(() => useSerialOperations());
    const first = deferred();
    const order: string[] = [];

    let done!: Promise<unknown>;
    act(() => {
      void result.current.run('first', async () => {
        order.push('first started');
        await first.promise;
        order.push('first finished');
      });
      done = result.current.run('second', async () => {
        order.push('second started');
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(order).toEqual(['first started']);
    expect(result.current.running).toEqual({ label: 'first' });

    await act(async () => {
      first.resolve();
      await done;
    });
    expect(order).toEqual(['first started', 'first finished', 'second started']);
  });

  it('keeps going after a failed operation and passes each result to its own caller', async () => {
    const { result } = renderHook(() => useSerialOperations());

    let failed!: Promise<unknown>;
    let next!: Promise<number>;
    act(() => {
      failed = result.current.run(null, () => Promise.reject(new Error('boom')));
      next = result.current.run(null, async () => 42);
    });

    await act(async () => {
      await expect(failed).rejects.toThrow('boom');
      await expect(next).resolves.toBe(42);
    });
  });

  it('reports nothing running once the queue is empty, and when it became idle', async () => {
    const { result } = renderHook(() => useSerialOperations());
    const work = deferred();

    act(() => {
      void result.current.run('only', () => work.promise);
    });
    let idle = false;
    void result.current.idle().then(() => {
      idle = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(idle).toBe(false);

    await act(async () => {
      work.resolve();
      await result.current.idle();
    });
    expect(idle).toBe(true);
    expect(result.current.running).toBeNull();
  });
});

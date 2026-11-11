// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { tabs: { getCurrent: vi.fn(), update: vi.fn() } } }));

import { useEditorLock } from '@/lib/editor/editor-lock';

type Callback = (lock: { name: string } | null) => unknown;

/** An exclusive-only LockManager: enough of the Web Locks semantics the editor relies on. */
function fakeLocks() {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const grant = (name: string, callback: Callback) => {
    held.add(name);
    return Promise.resolve(callback({ name })).finally(() => {
      held.delete(name);
      queues.get(name)?.shift()?.();
    });
  };
  return {
    request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: Callback) {
      if (!held.has(name)) return grant(name, callback);
      if (options.ifAvailable) return Promise.resolve(callback(null));
      return new Promise((resolve, reject) => {
        const turn = () => {
          if (options.signal?.aborted) return queues.get(name)?.shift()?.();
          grant(name, callback).then(resolve, reject);
        };
        options.signal?.addEventListener('abort', () => {
          queues.set(name, (queues.get(name) ?? []).filter((queued) => queued !== turn));
          reject(new DOMException('aborted', 'AbortError'));
        });
        queues.set(name, [...(queues.get(name) ?? []), turn]);
      });
    },
  };
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal('navigator', { ...navigator, locks: fakeLocks() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('editor lock', () => {
  it('lets one tab edit a Project and hands it to the waiting tab once that one leaves', async () => {
    const first = renderHook(() => useEditorLock('project-1'));
    await settle();
    expect(first.result.current.state).toBe('held');

    const second = renderHook(() => useEditorLock('project-1'));
    await settle();
    expect(second.result.current.state).toBe('elsewhere');

    first.unmount();
    await settle();
    expect(second.result.current.state).toBe('held');
  });

  it('does not stand in the way of another Project', async () => {
    renderHook(() => useEditorLock('project-1'));
    const other = renderHook(() => useEditorLock('project-2'));
    await settle();
    expect(other.result.current.state).toBe('held');
  });

  it('edits freely without Web Locks or a Project', () => {
    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    expect(renderHook(() => useEditorLock('project-1')).result.current.state).toBe('held');
    expect(renderHook(() => useEditorLock(null)).result.current.state).toBe('held');
  });
});

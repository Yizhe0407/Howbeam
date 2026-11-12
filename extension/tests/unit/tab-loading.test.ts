import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const updatedListeners = new Set<Listener>();
  const removedListeners = new Set<Listener>();
  return {
    tabsGet: vi.fn(),
    updatedListeners,
    removedListeners,
    addUpdated: vi.fn((listener: Listener) => updatedListeners.add(listener)),
    removeUpdated: vi.fn((listener: Listener) => updatedListeners.delete(listener)),
    addRemoved: vi.fn((listener: Listener) => removedListeners.add(listener)),
    removeRemoved: vi.fn((listener: Listener) => removedListeners.delete(listener)),
    emitUpdated(...args: any[]) {
      for (const listener of [...updatedListeners]) listener(...args);
    },
    emitRemoved(...args: any[]) {
      for (const listener of [...removedListeners]) listener(...args);
    },
  };
});

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: {
      get: mocks.tabsGet,
      onUpdated: {
        addListener: mocks.addUpdated,
        removeListener: mocks.removeUpdated,
      },
      onRemoved: {
        addListener: mocks.addRemoved,
        removeListener: mocks.removeRemoved,
      },
    },
  },
}));

import { waitForTabComplete } from '@/lib/runtime/tab-loading';

beforeEach(() => {
  mocks.tabsGet.mockReset();
  mocks.updatedListeners.clear();
  mocks.removedListeners.clear();
  mocks.addUpdated.mockClear();
  mocks.removeUpdated.mockClear();
  mocks.addRemoved.mockClear();
  mocks.removeRemoved.mockClear();
});

describe('waitForTabComplete', () => {
  it('returns immediately when the first status read is already complete', async () => {
    const completeTab = { id: 7, status: 'complete' };
    mocks.tabsGet.mockResolvedValue(completeTab);

    await expect(waitForTabComplete(7)).resolves.toBe(completeTab);

    expect(mocks.tabsGet).toHaveBeenCalledTimes(1);
    expect(mocks.addUpdated).not.toHaveBeenCalled();
  });

  it('rechecks after subscribing so completion between the first read and subscription is not lost', async () => {
    const loadingTab = { id: 7, status: 'loading' };
    const completeTab = { id: 7, status: 'complete' };
    mocks.tabsGet.mockResolvedValueOnce(loadingTab).mockResolvedValueOnce(completeTab);

    await expect(waitForTabComplete(7)).resolves.toBe(completeTab);

    expect(mocks.tabsGet).toHaveBeenCalledTimes(2);
    expect(mocks.updatedListeners).toHaveLength(0);
    expect(mocks.removedListeners).toHaveLength(0);
    expect(mocks.removeUpdated).toHaveBeenCalledTimes(1);
    expect(mocks.removeRemoved).toHaveBeenCalledTimes(1);
  });

  it('settles only once and cleans up when an update event wins the recheck race', async () => {
    let resolveRecheck!: (tab: unknown) => void;
    const recheck = new Promise((resolve) => {
      resolveRecheck = resolve;
    });
    const completeTab = { id: 7, status: 'complete' };
    mocks.tabsGet.mockResolvedValueOnce({ id: 7, status: 'loading' }).mockReturnValueOnce(recheck);

    const result = waitForTabComplete(7);
    await vi.waitFor(() => expect(mocks.updatedListeners.size).toBe(1));
    mocks.emitUpdated(7, { status: 'complete' }, completeTab);

    await expect(result).resolves.toBe(completeTab);
    resolveRecheck({ id: 7, status: 'complete' });
    await Promise.resolve();

    expect(mocks.removeUpdated).toHaveBeenCalledTimes(1);
    expect(mocks.removeRemoved).toHaveBeenCalledTimes(1);
    expect(mocks.updatedListeners).toHaveLength(0);
    expect(mocks.removedListeners).toHaveLength(0);
  });

  it('rejects on timeout and removes both listeners', async () => {
    vi.useFakeTimers();
    try {
      mocks.tabsGet.mockResolvedValueOnce({ id: 7, status: 'loading' }).mockReturnValueOnce(new Promise(() => {}));

      const result = waitForTabComplete(7, 25);
      const rejection = expect(result).rejects.toThrow('Timed out while loading the source page.');
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.updatedListeners).toHaveLength(1);
      expect(mocks.removedListeners).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(mocks.updatedListeners).toHaveLength(0);
      expect(mocks.removedListeners).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with the recheck error when the tab disappears between reads', async () => {
    mocks.tabsGet
      .mockResolvedValueOnce({ id: 7, status: 'loading' })
      .mockRejectedValueOnce(new Error('No tab with id: 7.'));

    await expect(waitForTabComplete(7)).rejects.toThrow('No tab with id: 7.');
    expect(mocks.updatedListeners).toHaveLength(0);
    expect(mocks.removedListeners).toHaveLength(0);
  });

  it('rejects and cleans up when the tab is removed while loading', async () => {
    mocks.tabsGet.mockResolvedValueOnce({ id: 7, status: 'loading' }).mockReturnValueOnce(new Promise(() => {}));

    const result = waitForTabComplete(7);
    await vi.waitFor(() => expect(mocks.removedListeners.size).toBe(1));
    mocks.emitRemoved(7);

    await expect(result).rejects.toThrow('The source tab was closed while loading.');
    expect(mocks.updatedListeners).toHaveLength(0);
    expect(mocks.removedListeners).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  const listeners = new Set<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>();
  const local = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items);
    }),
    remove: vi.fn(async (key: string) => {
      delete values[key];
    }),
  };
  return {
    values,
    listeners,
    local,
    addListener: vi.fn((listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
      listeners.delete(listener);
    }),
  };
});

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: mocks.local,
      onChanged: {
        addListener: mocks.addListener,
        removeListener: mocks.removeListener,
      },
    },
  },
}));

import {
  ACTIVE_PROJECT_ID_KEY,
  clearActiveProjectId,
  getActiveProjectId,
  setActiveProjectId,
} from '@/lib/storage/storage';
import { RECORDING_STATE_KEY } from '@/lib/storage/recording-state';
import { itemAt } from '../setup/item-at';

beforeEach(() => {
  for (const key of Object.keys(mocks.values)) delete mocks.values[key];
  mocks.local.get.mockClear();
  mocks.local.set.mockClear();
  mocks.local.remove.mockClear();
  mocks.addListener.mockClear();
  mocks.removeListener.mockClear();
  mocks.listeners.clear();
});

describe('active Project storage', () => {
  it('stores UI selection under an independent key without touching RecordingState', async () => {
    await setActiveProjectId('project-a');

    expect(ACTIVE_PROJECT_ID_KEY).not.toBe(RECORDING_STATE_KEY);
    expect(mocks.local.set).toHaveBeenCalledWith({ [ACTIVE_PROJECT_ID_KEY]: 'project-a' });
    expect(mocks.values[RECORDING_STATE_KEY]).toBeUndefined();
    await expect(getActiveProjectId()).resolves.toBe('project-a');
  });

  it('compare-and-clears only the expected selection', async () => {
    mocks.values[ACTIVE_PROJECT_ID_KEY] = 'project-b';

    await expect(clearActiveProjectId('project-a')).resolves.toBe(false);
    expect(mocks.local.remove).not.toHaveBeenCalled();
    expect(mocks.values[ACTIVE_PROJECT_ID_KEY]).toBe('project-b');

    await expect(clearActiveProjectId('project-b')).resolves.toBe(true);
    expect(mocks.local.remove).toHaveBeenCalledWith(ACTIVE_PROJECT_ID_KEY);
    expect(mocks.values[ACTIVE_PROJECT_ID_KEY]).toBeUndefined();
  });

  it('serializes a clear followed by a newer select so the newer selection survives', async () => {
    mocks.values[ACTIVE_PROJECT_ID_KEY] = 'project-a';
    let releaseRead!: () => void;
    const blockedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    mocks.local.get.mockImplementationOnce(async (key: string) => {
      await blockedRead;
      return { [key]: mocks.values[key] };
    });

    const clearing = clearActiveProjectId('project-a');
    const selecting = setActiveProjectId('project-b');
    releaseRead();
    await Promise.all([clearing, selecting]);

    expect(mocks.values[ACTIVE_PROJECT_ID_KEY]).toBe('project-b');
    expect(mocks.local.remove.mock.invocationCallOrder[0]).toBeLessThan(
      itemAt(mocks.local.set.mock.invocationCallOrder, 0),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (items: Record<string, unknown>) => void Object.assign(values, items),
        remove: async (key: string) => void delete values[key],
      },
    },
  },
}));

import {
  claimPendingStart,
  discardPendingStart,
  parkPendingStart,
  PENDING_START_TTL_MS,
} from '@/lib/runtime/pending-start';

describe('pending start', () => {
  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
  });

  it('hands the parked start to exactly one claimant', async () => {
    await parkPendingStart({ mode: 'steps', tabId: 7, projectId: null }, 1000);
    expect(await claimPendingStart(1500)).toEqual({ mode: 'steps', tabId: 7, projectId: null, createdAt: 1000 });
    expect(await claimPendingStart(1500)).toBeNull();
  });

  it('ignores and clears a start parked too long ago', async () => {
    await parkPendingStart({ mode: 'steps', tabId: 7, projectId: null }, 1000);
    expect(await claimPendingStart(1000 + PENDING_START_TTL_MS + 1)).toBeNull();
    expect(await claimPendingStart(1500)).toBeNull();
  });

  it('carries the target project through the park', async () => {
    await parkPendingStart({ mode: 'steps', tabId: 7, projectId: 'project-1' }, 1000);
    expect(await claimPendingStart(1500)).toMatchObject({ projectId: 'project-1' });
  });

  it('can be discarded after a declined prompt', async () => {
    await parkPendingStart({ mode: 'snapshot', tabId: 3, projectId: 'project-1' }, 1000);
    await discardPendingStart();
    expect(await claimPendingStart(1000)).toBeNull();
  });
});

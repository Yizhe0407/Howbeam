import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/storage/storage', () => ({
  getRecordingState: vi.fn(),
  setRecordingState: vi.fn(),
}));

import { createControlPlane } from '@/lib/recording/background/control-plane';

const identity = { runId: 'run-1', tabId: 7, controlVersion: 1 };

describe('control plane recorder startup', () => {
  it('exposes the startup in flight until its ready body has finished', async () => {
    const control = createControlPlane({ discardPendingUndo: vi.fn() });
    let finishReady!: () => void;
    const startup = control.withRecorderReadyGate({
      slot: 'pendingRecorderReady',
      identity,
      inject: async () => undefined,
      notReadyError: () => new Error('not ready'),
      ready: () => new Promise<void>((resolve) => {
        finishReady = () => {
          control.acceptingClicks = true;
          resolve();
        };
      }),
    });
    expect(control.startupSettled).not.toBeNull();

    let settled = false;
    void control.startupSettled!.then(() => {
      settled = true;
    });
    control.pendingRecorderReady!.signal(identity);
    await vi.waitFor(() => expect(finishReady).toBeTypeOf('function'));
    expect(settled).toBe(false);

    finishReady();
    await startup;
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(control.acceptingClicks).toBe(true);
    expect(control.startupSettled).toBeNull();
  });

  it('settles without throwing when the startup fails', async () => {
    const control = createControlPlane({ discardPendingUndo: vi.fn() });
    const startup = control.withRecorderReadyGate({
      slot: 'pendingRecorderReady',
      identity,
      inject: async () => {
        throw new Error('injection failed');
      },
      notReadyError: () => new Error('not ready'),
      ready: async () => undefined,
    });
    const settled = control.startupSettled!;
    control.pendingRecorderReady!.signal(identity);
    await expect(startup).rejects.toThrow('injection failed');
    await expect(settled).resolves.toBeUndefined();
  });
});

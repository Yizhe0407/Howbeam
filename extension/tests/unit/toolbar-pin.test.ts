// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

type ChangeListener = (change: { isOnToolbar?: boolean }) => void;

const fake = vi.hoisted(() => ({ browser: {} as Record<string, unknown> }));
vi.mock('wxt/browser', () => ({ browser: fake.browser }));

import { readToolbarPin, watchToolbarPin } from '@/lib/runtime/toolbar-action';

function installAction(action: Record<string, unknown>, key: 'action' | 'browserAction' = 'action') {
  for (const name of Object.keys(fake.browser)) delete fake.browser[name];
  fake.browser[key] = action;
}

function changeEvent() {
  const listeners = new Set<ChangeListener>();
  return {
    listeners,
    addListener: (listener: ChangeListener) => listeners.add(listener),
    removeListener: (listener: ChangeListener) => listeners.delete(listener),
    emit: (change: { isOnToolbar?: boolean }) => listeners.forEach((listener) => listener(change)),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('readToolbarPin', () => {
  it('reports the browser pin setting', async () => {
    installAction({ getUserSettings: vi.fn().mockResolvedValue({ isOnToolbar: true }) });
    await expect(readToolbarPin()).resolves.toBe('pinned');

    installAction({ getUserSettings: vi.fn().mockResolvedValue({ isOnToolbar: false }) });
    await expect(readToolbarPin()).resolves.toBe('unpinned');
  });

  it('reads Firefox MV2 browserAction when there is no action', async () => {
    installAction({ getUserSettings: vi.fn().mockResolvedValue({ isOnToolbar: true }) }, 'browserAction');
    await expect(readToolbarPin()).resolves.toBe('pinned');
  });

  it('is unknown when the browser cannot report it', async () => {
    installAction({});
    await expect(readToolbarPin()).resolves.toBe('unknown');

    installAction({ getUserSettings: vi.fn().mockRejectedValue(new Error('unsupported')) });
    await expect(readToolbarPin()).resolves.toBe('unknown');

    installAction({ getUserSettings: vi.fn().mockResolvedValue({}) });
    await expect(readToolbarPin()).resolves.toBe('unknown');
  });
});

describe('watchToolbarPin', () => {
  it('follows the change event and stops on unsubscribe', async () => {
    const event = changeEvent();
    installAction({ getUserSettings: vi.fn().mockResolvedValue({ isOnToolbar: false }), onUserSettingsChanged: event });
    const onChange = vi.fn();

    const stop = watchToolbarPin(onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('unpinned'));

    event.emit({ isOnToolbar: true });
    expect(onChange).toHaveBeenLastCalledWith('pinned');
    event.emit({});
    expect(onChange).toHaveBeenCalledTimes(2);

    stop();
    expect(event.listeners.size).toBe(0);
  });

  it('lets a change event win over an initial read still in flight', async () => {
    const event = changeEvent();
    let answer!: (settings: { isOnToolbar: boolean }) => void;
    installAction({
      getUserSettings: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      onUserSettingsChanged: event,
    });
    const onChange = vi.fn();

    watchToolbarPin(onChange);
    event.emit({ isOnToolbar: true });
    answer({ isOnToolbar: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(onChange.mock.calls).toEqual([['pinned']]);
  });

  it('re-reads on window focus where the browser has no change event', async () => {
    const getUserSettings = vi.fn().mockResolvedValue({ isOnToolbar: false });
    installAction({ getUserSettings });
    const onChange = vi.fn();

    const stop = watchToolbarPin(onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('unpinned'));

    getUserSettings.mockResolvedValue({ isOnToolbar: true });
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('pinned'));

    stop();
    window.dispatchEvent(new Event('focus'));
    expect(getUserSettings).toHaveBeenCalledTimes(2);
  });
});

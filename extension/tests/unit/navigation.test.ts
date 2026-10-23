import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tabsUpdate: vi.fn(),
  windowsUpdate: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: { update: mocks.tabsUpdate },
    windows: { update: mocks.windowsUpdate },
  },
}));

import { focusTab, getEditorSessionIdFromUrl } from '@/lib/runtime/navigation';
import { itemAt } from '../setup/item-at';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
});

describe('getEditorSessionIdFromUrl', () => {
  it('reads the explicit Project session from an editor URL', () => {
    expect(
      getEditorSessionIdFromUrl('chrome-extension://extension-id/editor.html?entryId=step&sessionId=project-a'),
    ).toBe('project-a');
  });

  it('returns null for absent, empty, or malformed session URLs', () => {
    expect(getEditorSessionIdFromUrl('chrome-extension://extension-id/editor.html')).toBeNull();
    expect(getEditorSessionIdFromUrl('chrome-extension://extension-id/editor.html?sessionId=')).toBeNull();
    expect(getEditorSessionIdFromUrl('not a url')).toBeNull();
  });
});

describe('focusTab', () => {
  it('activates the tab, then focuses its window', async () => {
    await focusTab(7, 2);

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(7, { active: true });
    expect(mocks.windowsUpdate).toHaveBeenCalledExactlyOnceWith(2, { focused: true });
    // Tab activation must precede the window focus so a failed focus still
    // leaves the tab selected in its window.
    expect(mocks.tabsUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      itemAt(mocks.windowsUpdate.mock.invocationCallOrder, 0),
    );
  });

  it('skips the window focus when no windowId is known', async () => {
    await focusTab(7);
    await focusTab(7, null);

    expect(mocks.tabsUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.windowsUpdate).not.toHaveBeenCalled();
  });

  it('focuses window 0 rather than treating it as absent', async () => {
    await focusTab(7, 0);

    expect(mocks.windowsUpdate).toHaveBeenCalledExactlyOnceWith(0, { focused: true });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionGet: vi.fn(),
  sessionSet: vi.fn(),
  sessionRemove: vi.fn(),
  tabsCreate: vi.fn(),
  tabsUpdate: vi.fn(),
  windowsUpdate: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { getURL: (path: string) => `chrome-extension://extension-id${path}` },
    storage: { session: { get: mocks.sessionGet, set: mocks.sessionSet, remove: mocks.sessionRemove } },
    tabs: { create: mocks.tabsCreate, update: mocks.tabsUpdate },
    windows: { update: mocks.windowsUpdate },
  },
}));

import {
  findExtensionPage,
  forgetClosedExtensionPage,
  openLibraryPage,
  registerExtensionPage,
  showExtensionPage,
} from '@/lib/recording/background/extension-page-tabs';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const EDITOR_KEY = 'howbeam:extensionPageTab:editor';
const LIBRARY_KEY = 'howbeam:extensionPageTab:library';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionGet.mockResolvedValue({});
  mocks.sessionSet.mockResolvedValue(undefined);
  mocks.sessionRemove.mockResolvedValue(undefined);
  mocks.tabsCreate.mockResolvedValue({ id: 99 });
  mocks.tabsUpdate.mockResolvedValue(undefined);
  mocks.windowsUpdate.mockResolvedValue(undefined);
});

function editorSender(overrides: Record<string, unknown> = {}) {
  return {
    frameId: 0,
    url: 'chrome-extension://extension-id/editor.html?sessionId=project-a',
    tab: { id: 12, windowId: 4, url: 'chrome-extension://extension-id/editor.html?sessionId=project-a' },
    ...overrides,
  };
}

describe('registerExtensionPage', () => {
  it('derives the page kind from the authenticated sender URL, not a payload', async () => {
    await expect(registerExtensionPage(editorSender())).resolves.toBe(true);

    expect(mocks.sessionSet).toHaveBeenCalledExactlyOnceWith({
      [EDITOR_KEY]: { tabId: 12, windowId: 4 },
    });
  });

  it('registers the library page under its own key', async () => {
    const url = 'chrome-extension://extension-id/library.html';
    await registerExtensionPage({ frameId: 0, url, tab: { id: 5, windowId: 1, url } });

    expect(mocks.sessionSet).toHaveBeenCalledExactlyOnceWith({
      [LIBRARY_KEY]: { tabId: 5, windowId: 1 },
    });
  });

  it.each([
    ['a child frame of an editor tab', editorSender({ frameId: 3 })],
    [
      'a page merely embedded in an editor tab',
      editorSender({ url: 'https://evil.test/embedded' }),
    ],
    [
      'an extension page that is not a registered surface',
      {
        frameId: 0,
        url: 'chrome-extension://extension-id/popup.html',
        tab: { id: 12, windowId: 4, url: 'chrome-extension://extension-id/popup.html' },
      },
    ],
    ['a sender with no tab', { frameId: 0, url: 'chrome-extension://extension-id/editor.html' }],
  ])('refuses %s', async (_label, sender) => {
    await expect(registerExtensionPage(sender)).resolves.toBe(false);

    expect(mocks.sessionSet).not.toHaveBeenCalled();
  });
});

describe('findExtensionPage', () => {
  it('reads back a registered tab', async () => {
    mocks.sessionGet.mockResolvedValue({ [EDITOR_KEY]: { tabId: 12, windowId: 4 } });

    await expect(findExtensionPage('editor')).resolves.toEqual({ tabId: 12, windowId: 4 });
  });

  it('reports no page for an empty or malformed record', async () => {
    await expect(findExtensionPage('editor')).resolves.toBeNull();

    mocks.sessionGet.mockResolvedValue({ [EDITOR_KEY]: { tabId: 'twelve' } });
    await expect(findExtensionPage('editor')).resolves.toBeNull();
  });

  it('keeps a record whose windowId is unusable, dropping only the window', async () => {
    mocks.sessionGet.mockResolvedValue({ [EDITOR_KEY]: { tabId: 12, windowId: -1 } });

    await expect(findExtensionPage('editor')).resolves.toEqual({ tabId: 12, windowId: null });
  });
});

describe('forgetClosedExtensionPage', () => {
  it('removes every record naming the closed tab', async () => {
    mocks.sessionGet.mockResolvedValue({
      [EDITOR_KEY]: { tabId: 12, windowId: 4 },
      [LIBRARY_KEY]: { tabId: 13, windowId: 4 },
    });

    await forgetClosedExtensionPage(12);

    expect(mocks.sessionRemove).toHaveBeenCalledExactlyOnceWith([EDITOR_KEY]);
  });

  it('writes nothing when the closed tab was never an extension page', async () => {
    mocks.sessionGet.mockResolvedValue({ [EDITOR_KEY]: { tabId: 12, windowId: 4 } });

    await forgetClosedExtensionPage(77);

    expect(mocks.sessionRemove).not.toHaveBeenCalled();
  });
});

describe('showExtensionPage', () => {
  it('navigates and focuses when the caller asked for a new URL', async () => {
    await showExtensionPage('editor', { tabId: 12, windowId: 4 }, { url: 'about:editor', navigate: true });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, { url: 'about:editor', active: true });
    expect(mocks.windowsUpdate).toHaveBeenCalledExactlyOnceWith(4, { focused: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('only activates when the page already shows what was asked for', async () => {
    await showExtensionPage('editor', { tabId: 12, windowId: 4 }, { url: 'about:editor', navigate: false });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(12, { active: true });
  });

  it('drops a stale record and opens a fresh tab when the update is rejected', async () => {
    silenceIntentionalErrorLogs();
    mocks.tabsUpdate.mockRejectedValue(new Error('No tab with id: 12.'));

    await showExtensionPage('editor', { tabId: 12, windowId: 4 }, { url: 'about:editor', navigate: false });

    expect(mocks.sessionRemove).toHaveBeenCalledExactlyOnceWith(EDITOR_KEY);
    expect(mocks.tabsCreate).toHaveBeenCalledExactlyOnceWith({ url: 'about:editor', active: true });
    expect(mocks.windowsUpdate).not.toHaveBeenCalled();
  });

  it('keeps the reused tab when only the window focus fails', async () => {
    // A closed window must not be read as a stale record and spawn a duplicate page.
    mocks.windowsUpdate.mockRejectedValue(new Error('No window with id: 4.'));

    await expect(
      showExtensionPage('editor', { tabId: 12, windowId: 4 }, { url: 'about:editor', navigate: false }),
    ).rejects.toThrow('No window with id: 4.');

    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.sessionRemove).not.toHaveBeenCalled();
  });
});

describe('openLibraryPage', () => {
  it('focuses the registered library tab instead of opening a duplicate', async () => {
    mocks.sessionGet.mockResolvedValue({ [LIBRARY_KEY]: { tabId: 5, windowId: 1 } });

    await expect(openLibraryPage()).resolves.toEqual({ ok: true });

    expect(mocks.tabsUpdate).toHaveBeenCalledExactlyOnceWith(5, { active: true });
    expect(mocks.windowsUpdate).toHaveBeenCalledExactlyOnceWith(1, { focused: true });
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('opens one library tab when none has registered', async () => {
    await expect(openLibraryPage()).resolves.toEqual({ ok: true });

    expect(mocks.tabsCreate).toHaveBeenCalledExactlyOnceWith({
      url: 'chrome-extension://extension-id/library.html',
      active: true,
    });
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
  });
});

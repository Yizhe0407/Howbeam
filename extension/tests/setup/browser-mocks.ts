import { vi, type Mock } from 'vitest';

/**
 * Shared `wxt/browser` mock factories. Each factory returns the `browser`
 * object for a `vi.mock('wxt/browser', ...)` factory; tests wire only the
 * handles they assert on and every unnamed API falls back to a fresh vi.fn().
 * Handles must come from `vi.hoisted` because `vi.mock` factories are hoisted
 * above the test file body.
 */

type RuntimeOnMessageListener = (message: unknown, sender: unknown, sendResponse: (value?: unknown) => void) => unknown;

/**
 * Emulates Chrome's runtime.onMessage dispatch: a listener returning `true`
 * answers asynchronously via sendResponse; anything else resolves to
 * undefined (closed channel). A returned Promise is NOT treated as a
 * response — Chrome's promise-reply support (144) was reverted
 * (crbug.com/40753031), so tests must exercise the callback contract.
 */
export function dispatchRuntimeMessage(
  listener: RuntimeOnMessageListener,
  message: unknown,
  sender: unknown,
): Promise<unknown> | undefined {
  let respond!: (value?: unknown) => void;
  const response = new Promise<unknown>((resolve) => {
    respond = resolve;
  });
  return listener(message, sender, respond) === true ? response : undefined;
}

export interface ExtensionPageRuntimeHandles {
  sendMessage?: Mock;
  /** Captures the page's runtime.onMessage listener, already wrapped so
   * `await handles.messageListener(message, sender)` yields the value the page
   * passed to sendResponse. */
  onMessage?: (listener: (message: unknown, sender: unknown) => unknown) => void;
  /** Extension host used by getURL; defaults to `extension-id`. */
  extensionHost?: string;
}

/**
 * The runtime surface every extension page needs: the request channel to the
 * background (page registration, OPEN_LIBRARY, …) plus the onMessage listener
 * the editor answers the single-tab handoff on.
 */
export function makeExtensionPageRuntimeMock(handles: ExtensionPageRuntimeHandles = {}) {
  const host = handles.extensionHost ?? 'extension-id';
  return {
    getURL: vi.fn((path: string) => `chrome-extension://${host}${path}`),
    sendMessage: handles.sendMessage ?? vi.fn().mockResolvedValue(undefined),
    onMessage: {
      addListener: (listener: RuntimeOnMessageListener) => {
        handles.onMessage?.((message, sender) => dispatchRuntimeMessage(listener, message, sender));
      },
      removeListener: vi.fn(),
    },
  };
}

export interface BackgroundBrowserMockHandles {
  /** Captures the background's runtime.onMessage listener for direct dispatch.
   * The captured function already wraps the raw listener in
   * dispatchRuntimeMessage, so `await mocks.messageListener(msg, sender)`
   * yields the value the background passed to sendResponse. */
  onMessage?: (listener: (message: unknown, sender: unknown) => unknown) => void;
  onTabActivated?: (listener: (info: { tabId: number; windowId: number }) => void) => void;
  onTabUpdated?: (
    listener: (
      tabId: number,
      changeInfo: { status?: string; url?: string },
      tab: { id?: number; url?: string; active?: boolean },
    ) => void,
  ) => void;
  onWindowFocusChanged?: (listener: (windowId: number) => void) => void;
  /** Captures the background's tabs.onRemoved listener. */
  onTabRemoved?: (listener: (tabId: number) => void) => void;
  permissionsContains?: Mock;
  permissionsRequest?: Mock;
  tabsCreate?: Mock;
  tabsGet?: Mock;
  tabsQuery?: Mock;
  tabsRemove?: Mock;
  tabsSendMessage?: Mock;
  tabsUpdate?: Mock;
  windowsUpdate?: Mock;
  /** Captures the background's permissions.onAdded listener. */
  onPermissionsAdded?: (listener: (permissions: { origins?: string[] }) => void) => void;
  /** browser.storage.local, where the pending start and Project selection live. */
  localGet?: Mock;
  localSet?: Mock;
  localRemove?: Mock;
  executeScript?: Mock;
  insertCSS?: Mock;
  /** browser.storage.session, where the extension-page tab registry lives.
   * Defaults to an empty registry, i.e. no page has announced itself. */
  sessionGet?: Mock;
  sessionSet?: Mock;
  sessionRemove?: Mock;
  /** Captures the background's runtime.onConnect listener (recorder connections). */
  onConnect?: (listener: (port: unknown) => void) => void;
  /** Captures the background's runtime.onInstalled listener. */
  onInstalled?: (listener: (details: { reason: string }) => void) => void;
  /** Captures storage.onChanged listeners (recording-state subscribers). */
  onStorageChanged?: (listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void) => void;
  actionSetIcon?: Mock;
}

/** MV3 service-worker surface used by entrypoints/background.ts under test. */
export function makeBackgroundBrowserMock(handles: BackgroundBrowserMockHandles = {}) {
  return {
    runtime: {
      getURL: (path: string) => `chrome-extension://extension-id${path}`,
      onMessage: {
        addListener: (listener: RuntimeOnMessageListener) => {
          handles.onMessage?.((message, sender) => dispatchRuntimeMessage(listener, message, sender));
        },
      },
      onConnect: { addListener: handles.onConnect ?? vi.fn() },
      onInstalled: { addListener: handles.onInstalled ?? vi.fn() },
      sendMessage: vi.fn(),
    },
    action: { setIcon: handles.actionSetIcon ?? vi.fn().mockResolvedValue(undefined) },
    commands: { onCommand: { addListener: vi.fn() } },
    permissions: {
      contains: handles.permissionsContains ?? vi.fn(),
      request: handles.permissionsRequest ?? vi.fn(),
      onAdded: { addListener: handles.onPermissionsAdded ?? vi.fn() },
    },
    tabs: {
      captureVisibleTab: vi.fn(),
      create: handles.tabsCreate ?? vi.fn(),
      get: handles.tabsGet ?? vi.fn(),
      onActivated: { addListener: handles.onTabActivated ?? vi.fn() },
      onRemoved: { addListener: handles.onTabRemoved ?? vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: handles.onTabUpdated ?? vi.fn(), removeListener: vi.fn() },
      query: handles.tabsQuery ?? vi.fn(),
      remove: handles.tabsRemove ?? vi.fn(),
      sendMessage: handles.tabsSendMessage ?? vi.fn(),
      update: handles.tabsUpdate ?? vi.fn(),
    },
    windows: {
      onFocusChanged: { addListener: handles.onWindowFocusChanged ?? vi.fn() },
      update: handles.windowsUpdate ?? vi.fn(),
    },
    storage: {
      local: {
        get: handles.localGet ?? vi.fn().mockResolvedValue({}),
        set: handles.localSet ?? vi.fn().mockResolvedValue(undefined),
        remove: handles.localRemove ?? vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: handles.sessionGet ?? vi.fn().mockResolvedValue({}),
        set: handles.sessionSet ?? vi.fn().mockResolvedValue(undefined),
        remove: handles.sessionRemove ?? vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: handles.onStorageChanged ?? vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: handles.executeScript ?? vi.fn(),
      insertCSS: handles.insertCSS ?? vi.fn(),
      removeCSS: vi.fn(),
    },
  };
}

export interface PopupBrowserMockHandles {
  sendMessage?: Mock;
  tabsQuery?: Mock;
  permissionsContains?: Mock;
  permissionsRequest?: Mock;
  storageGet?: Mock;
  storageSet?: Mock;
  storageRemove?: Mock;
}

/** Popup-page surface used by the RecordControls integration tests. */
export function makePopupBrowserMock(handles: PopupBrowserMockHandles = {}) {
  return {
    runtime: {
      getURL: (path: string) => `chrome-extension://frame${path}`,
      sendMessage: handles.sendMessage ?? vi.fn(),
    },
    tabs: { query: handles.tabsQuery ?? vi.fn() },
    permissions: {
      contains: handles.permissionsContains ?? vi.fn().mockResolvedValue(true),
      request: handles.permissionsRequest ?? vi.fn(),
    },
    storage: {
      local: {
        get: handles.storageGet ?? vi.fn().mockResolvedValue({}),
        set: handles.storageSet ?? vi.fn(),
        remove: handles.storageRemove ?? vi.fn(),
      },
    },
  };
}

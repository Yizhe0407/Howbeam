import { vi } from 'vitest';
import type { BackgroundBrowserMockHandles } from './browser-mocks';

/**
 * Shared mock-fn table for the background service-worker suites. vi.mock
 * factories must stay file-local (vitest hoists them per test file), so each
 * suite wires its own factories to a table produced here:
 *
 *   const mocks = await vi.hoisted(async () =>
 *     (await import('../setup/background-test-utils')).makeBackgroundMocks());
 *
 * The table is a superset; suites use the slice they care about.
 */
export function makeBackgroundMocks() {
  return {
    messageListener: null as null | ((message: unknown, sender: unknown) => unknown),
    tabActivatedListener: null as null | ((info: { tabId: number; windowId: number }) => void),
    tabUpdatedListener: null as
      | null
      | ((tabId: number, changeInfo: { status?: string; url?: string }, tab: { id?: number; url?: string; active?: boolean }) => void),
    windowFocusListener: null as null | ((windowId: number) => void),
    tabRemovedListener: null as null | ((tabId: number) => void),
    getProject: vi.fn(),
    getStep: vi.fn(),
    getSteps: vi.fn(),
    replaceStepCaptureAtomically: vi.fn(),
    /** Every row the background stores, one call per row. */
    storeStep: vi.fn(),
    deleteStep: vi.fn(),
    deleteStepsForRun: vi.fn(),
    discardPristineProject: vi.fn(),
    getRecordingState: vi.fn(),
    setRecordingState: vi.fn(),
    permissionsContains: vi.fn(),
    permissionsRequest: vi.fn(),
    tabsQuery: vi.fn(),
    tabsCreate: vi.fn(),
    tabsGet: vi.fn(),
    tabsUpdate: vi.fn(),
    tabsRemove: vi.fn(),
    tabsSendMessage: vi.fn(),
    windowsUpdate: vi.fn(),
    // browser.storage.session holds the extension-page tab registry. The
    // implementations are passed to vi.fn so vi.clearAllMocks keeps them:
    // suites that never open a page then need no registry setup at all.
    sessionGet: vi.fn(async (_keys?: string | string[]): Promise<Record<string, unknown>> => ({})),
    sessionSet: vi.fn(async (): Promise<void> => undefined),
    sessionRemove: vi.fn(async (): Promise<void> => undefined),
    executeScript: vi.fn(),
    insertCSS: vi.fn(),
    savePendingUndoRecord: vi.fn(),
    readPendingUndoRecord: vi.fn(),
    clearPendingUndoRecord: vi.fn(),
  };
}

export type BackgroundMocks = ReturnType<typeof makeBackgroundMocks>;

/**
 * Canonical vi.mock factory bodies for the background suites — the factory
 * body runs lazily on first module resolution, so each suite reduces to one
 * line per mocked module, e.g.:
 *
 *   vi.mock('wxt/browser', async () =>
 *     (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
 */

/** Factory body for vi.mock('wxt/browser'): the full background surface wired
 * to the shared mock table. Wiring is a superset — suites that never touch an
 * API simply leave its mock untouched. `extraHandles` may override any entry. */
export async function mockWxtBrowserModule(
  mocks: BackgroundMocks,
  extraHandles: BackgroundBrowserMockHandles = {},
) {
  const { makeBackgroundBrowserMock } = await import('./browser-mocks');
  return {
    browser: makeBackgroundBrowserMock({
      onMessage: (listener) => {
        mocks.messageListener = listener;
      },
      onTabActivated: (listener) => {
        mocks.tabActivatedListener = listener;
      },
      onTabUpdated: (listener) => {
        mocks.tabUpdatedListener = listener;
      },
      onWindowFocusChanged: (listener) => {
        mocks.windowFocusListener = listener;
      },
      onTabRemoved: (listener) => {
        mocks.tabRemovedListener = listener;
      },
      permissionsContains: mocks.permissionsContains,
      permissionsRequest: mocks.permissionsRequest,
      tabsCreate: mocks.tabsCreate,
      tabsGet: mocks.tabsGet,
      tabsQuery: mocks.tabsQuery,
      tabsRemove: mocks.tabsRemove,
      tabsSendMessage: mocks.tabsSendMessage,
      tabsUpdate: mocks.tabsUpdate,
      windowsUpdate: mocks.windowsUpdate,
      sessionGet: mocks.sessionGet,
      sessionSet: mocks.sessionSet,
      sessionRemove: mocks.sessionRemove,
      executeScript: mocks.executeScript,
      insertCSS: mocks.insertCSS,
      ...extraHandles,
    }),
  };
}

export async function mockStepRepositoryModule(
  mocks: BackgroundMocks,
  importOriginal: () => Promise<typeof import('@/lib/storage/step-repository')>,
  overrides: Partial<Record<keyof typeof import('@/lib/storage/step-repository'), unknown>> = {},
) {
  const actual = await importOriginal();
  return {
    ...actual,
    getStep: mocks.getStep,
    getSteps: mocks.getSteps,
    addStepsAfter: async (steps: readonly unknown[]) => {
      for (const step of steps) await mocks.storeStep(step);
    },
    deleteStep: mocks.deleteStep,
    replaceStepCaptureAtomically: mocks.replaceStepCaptureAtomically,
    ...overrides,
  };
}

export async function mockProjectRepositoryModule(
  mocks: BackgroundMocks,
  importOriginal: () => Promise<typeof import('@/lib/storage/project-repository')>,
  overrides: Partial<Record<keyof typeof import('@/lib/storage/project-repository'), unknown>> = {},
) {
  return { ...(await importOriginal()), getProject: mocks.getProject, ...overrides };
}

/** Factory body for vi.mock('@/lib/storage/storage'): recording state only. */
export async function mockStorageModule(
  mocks: BackgroundMocks,
  importOriginal: () => Promise<typeof import('@/lib/storage/storage')>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    getRecordingState: mocks.getRecordingState,
    setRecordingState: mocks.setRecordingState,
  };
}

/** Factory body for vi.mock('@/lib/recording/background/pending-undo-store'). */
export function mockPendingUndoStoreModule(mocks: BackgroundMocks) {
  return {
    savePendingUndoRecord: mocks.savePendingUndoRecord,
    readPendingUndoRecord: mocks.readPendingUndoRecord,
    clearPendingUndoRecord: mocks.clearPendingUndoRecord,
  };
}

/**
 * (Re)imports the background entrypoint so each test starts a fresh
 * service-worker instance against the mocks configured in the calling file.
 */
export async function importBackground(): Promise<void> {
  vi.resetModules();
  vi.stubGlobal('defineBackground', (setup: () => unknown) => setup());
  await import('@/entrypoints/background');
}

/** Drains chained microtask work (mocked async storage/tabs round trips). */
export async function flushAsyncWork(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

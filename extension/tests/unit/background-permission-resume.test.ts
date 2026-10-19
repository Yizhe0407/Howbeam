import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingState } from '@/lib/storage/recording-state';
import { ACTIVE_PROJECT_ID_KEY } from '@/lib/storage/storage';
import { makeRecordingState } from '../setup/recording-state';
import { flushAsyncWork, importBackground } from '../setup/background-test-utils';

const PENDING_START_KEY = 'howbeam:pending-start:v1';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());
const extra = vi.hoisted(() => ({
  permissionsAddedListener: null as null | ((permissions: { origins?: string[] }) => void),
  createProject: vi.fn(),
  local: new Map<string, unknown>(),
}));

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks, {
    onPermissionsAdded: (listener) => {
      extra.permissionsAddedListener = listener;
    },
    // In-memory storage.local: the pending start and the Project selection both live there.
    localGet: vi.fn(async (key: string) => (extra.local.has(key) ? { [key]: extra.local.get(key) } : {})),
    localSet: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) extra.local.set(key, value);
    }),
    localRemove: vi.fn(async (key: string) => void extra.local.delete(key)),
  }));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/project-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockProjectRepositoryModule(mocks, importOriginal, {
    createProject: extra.createProject,
    discardPristineProject: mocks.discardPristineProject,
  }));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));
vi.mock('@/lib/recording/background/pending-undo-store', async () =>
  (await import('../setup/background-test-utils')).mockPendingUndoStoreModule(mocks));

const ALL_URLS_GRANT = { origins: ['<all_urls>'] };
const PENDING_TAB = { id: 7, windowId: 1, active: true, url: 'https://example.com/start' };
const PROJECT_ROW = (id: string) => ({ id, title: id, entryCount: 0, stepCount: 0 });

let storedState: RecordingState;

function parkPending(projectId: string | null, mode: 'steps' | 'snapshot' = 'steps'): void {
  extra.local.set(PENDING_START_KEY, { mode, tabId: 7, projectId, createdAt: Date.now() });
}

/** Fires the grant the way the browser does once the user accepts the dialog. */
async function grantAllUrls(permissions: { origins?: string[] } = ALL_URLS_GRANT): Promise<void> {
  extra.permissionsAddedListener?.(permissions);
  await flushAsyncWork(200);
}

/** The first state the resumed start persisted for a run, i.e. which Project it claimed. */
function startedRunState(): RecordingState | undefined {
  return mocks.setRecordingState.mock.calls
    .map(([state]) => state as RecordingState)
    .find((state) => state.isRecording && state.phase === 'starting');
}

beforeEach(() => {
  vi.clearAllMocks();
  extra.permissionsAddedListener = null;
  extra.local.clear();
  storedState = makeRecordingState();
  mocks.getRecordingState.mockImplementation(async () => storedState);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    storedState = next;
  });
  mocks.permissionsContains.mockResolvedValue(true);
  mocks.getSteps.mockResolvedValue([]);
  mocks.getProject.mockImplementation(async (id: string) => PROJECT_ROW(id));
  mocks.discardPristineProject.mockResolvedValue(true);
  extra.createProject.mockResolvedValue(PROJECT_ROW('project-new'));
  mocks.tabsGet.mockResolvedValue(PENDING_TAB);
  mocks.tabsQuery.mockResolvedValue([PENDING_TAB]);
  mocks.tabsUpdate.mockResolvedValue(PENDING_TAB);
  mocks.windowsUpdate.mockResolvedValue({});
  mocks.tabsSendMessage.mockResolvedValue(undefined);
  mocks.executeScript.mockResolvedValue([]);
  mocks.readPendingUndoRecord.mockResolvedValue(null);
  mocks.clearPendingUndoRecord.mockResolvedValue(undefined);
  extra.local.set(ACTIVE_PROJECT_ID_KEY, 'project-previous');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('start resumed after the cross-tab permission grant', () => {
  it('appends to the project parked with the start instead of creating one', async () => {
    parkPending('project-old');
    await importBackground();

    await grantAllUrls();

    expect(extra.createProject).not.toHaveBeenCalled();
    expect(startedRunState()).toMatchObject({ sessionId: 'project-old', tabId: 7, mode: 'steps' });
    // An existing project must never be flagged reclaimable by the run's end.
    expect(startedRunState()?.autoCreatedProjectId).toBeNull();
    expect(extra.local.get(ACTIVE_PROJECT_ID_KEY)).toBe('project-old');
    expect(extra.local.has(PENDING_START_KEY)).toBe(false);
  });

  it('records into a fresh reclaimable project when none was chosen', async () => {
    parkPending(null, 'snapshot');
    await importBackground();

    await grantAllUrls();

    expect(extra.createProject).toHaveBeenCalledOnce();
    expect(startedRunState()).toMatchObject({ sessionId: 'project-new', mode: 'snapshot', autoCreatedProjectId: 'project-new' });
    expect(extra.local.get(ACTIVE_PROJECT_ID_KEY)).toBe('project-new');
  });

  it('restores the previous selection and keeps the project when the resumed start fails', async () => {
    parkPending('project-old');
    mocks.tabsGet.mockResolvedValue({ ...PENDING_TAB, url: 'chrome://extensions' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await importBackground();

    await grantAllUrls();

    expect(startedRunState()).toBeUndefined();
    expect(mocks.discardPristineProject).not.toHaveBeenCalled();
    expect(extra.local.get(ACTIVE_PROJECT_ID_KEY)).toBe('project-previous');
  });

  it('reclaims the fresh project when a start without a chosen project fails', async () => {
    parkPending(null);
    mocks.tabsGet.mockResolvedValue({ ...PENDING_TAB, url: 'chrome://extensions' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await importBackground();

    await grantAllUrls();

    expect(mocks.discardPristineProject).toHaveBeenCalledExactlyOnceWith('project-new');
    expect(extra.local.get(ACTIVE_PROJECT_ID_KEY)).toBe('project-previous');
  });

  it('does not start when the parked project was deleted meanwhile', async () => {
    parkPending('project-gone');
    mocks.getProject.mockResolvedValue(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await importBackground();

    await grantAllUrls();

    expect(startedRunState()).toBeUndefined();
    expect(extra.createProject).not.toHaveBeenCalled();
    expect(extra.local.get(ACTIVE_PROJECT_ID_KEY)).toBe('project-previous');
    expect(error).toHaveBeenCalledWith(
      '[howbeam] failed to resume the start after the permission grant',
      expect.any(Error),
    );
  });

  it('stays idle when nothing was parked', async () => {
    await importBackground();

    await grantAllUrls();

    expect(startedRunState()).toBeUndefined();
    expect(extra.createProject).not.toHaveBeenCalled();
  });

  it('ignores grants that are not the cross-tab permission', async () => {
    parkPending('project-old');
    await importBackground();

    await grantAllUrls({ origins: ['https://example.com/*'] });

    expect(startedRunState()).toBeUndefined();
    // Still parked: only the real grant may claim it.
    expect(extra.local.has(PENDING_START_KEY)).toBe(true);
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackgroundMessage,
  PreflightProjectContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  StartRecordingResult,
} from '@/lib/runtime/messages';
import type { RecordingState } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { type Step } from '@/lib/storage/models';

const mocks = await vi.hoisted(async () => (await import('../setup/background-test-utils')).makeBackgroundMocks());

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
// This suite keeps step persistence real: only the read APIs are stubbed, so an unexpected write during a preflight path fails loudly instead of being silently absorbed by a mock.
vi.mock('@/lib/storage/step-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/step-repository')>();
  return {
    ...actual,
    getStep: mocks.getStep,
    getSteps: mocks.getSteps,
  };
});

vi.mock('@/lib/storage/project-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/project-repository')>()),
  getProject: mocks.getProject,
}));

vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));

const idleState = makeRecordingState();

const editorUrl = 'chrome-extension://extension-id/editor.html';

function editorSender(frameSession: string, tabSession = frameSession) {
  return {
    frameId: 0,
    url: `${editorUrl}?sessionId=${encodeURIComponent(frameSession)}&entryId=step-1`,
    tab: {
      id: 7,
      windowId: 3,
      url: `${editorUrl}?entryId=step-1&sessionId=${encodeURIComponent(tabSession)}`,
    },
  };
}

function ordinaryStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: 'project-a',
    order: 0,
    screenshotBlob: new Blob(['image']),
    bounds: { x: 1, y: 2, width: 30, height: 40 },
    devicePixelRatio: 2,
    screenshotScale: 2,
    description: 'Persisted step',
    url: 'https://persisted.example/path?fresh=1#target',
    timestamp: 1,
    ...overrides,
  };
}

async function send<T>(message: BackgroundMessage, sender: unknown = editorSender('project-a')): Promise<T> {
  if (!mocks.messageListener) throw new Error('Background message listener was not registered.');
  return await mocks.messageListener(message, sender) as T;
}

function expectNoPermissionOrOperationSideEffects(): void {
  expect(mocks.getRecordingState).not.toHaveBeenCalled();
  expect(mocks.permissionsContains).not.toHaveBeenCalled();
  expect(mocks.permissionsRequest).not.toHaveBeenCalled();
  expect(mocks.tabsQuery).not.toHaveBeenCalled();
  expect(mocks.tabsCreate).not.toHaveBeenCalled();
  expect(mocks.tabsUpdate).not.toHaveBeenCalled();
  expect(mocks.tabsRemove).not.toHaveBeenCalled();
  expect(mocks.executeScript).not.toHaveBeenCalled();
  expect(mocks.insertCSS).not.toHaveBeenCalled();
  expect(mocks.setRecordingState).not.toHaveBeenCalled();
}

function activeRecordingState(): RecordingState {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    sessionId: 'project-a',
    tabId: 4,
    runId: 'run-1',
  });
}

beforeAll(async () => {
  // This suite deliberately drives the background through rejection paths without indexedDB/scripting; the resulting log lines are expected defensive logging, kept out of the test run output for the whole worker-isolated file.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('defineBackground', (setup: () => unknown) => setup());
  mocks.getRecordingState.mockResolvedValue(idleState);
  await import('@/entrypoints/background');
  await Promise.resolve();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRecordingState.mockResolvedValue(idleState);
  mocks.getProject.mockResolvedValue({ id: 'project-a', title: 'Project A' });
  mocks.getStep.mockResolvedValue(ordinaryStep());
  mocks.getSteps.mockResolvedValue([ordinaryStep()]);
});



describe('background runtime boundary', () => {
  it.each<unknown>([
    null,
    [],
    { type: 'START_RECORDING', sessionId: '', mode: 'steps' },
    { type: 'HOWBEAM_CLICK', runId: 'run-1' },
  ])('ignores malformed messages before any privileged work %#', async (message) => {
    const result = await mocks.messageListener?.(message, editorSender('project-a'));

    expect(result).toBeUndefined();
    expectNoPermissionOrOperationSideEffects();
    expect(mocks.tabsQuery).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'web content script',
      sender: { frameId: 0, url: 'https://example.com/', tab: { id: 4, url: 'https://example.com/' } },
    },
    {
      name: 'foreign extension page',
      sender: { url: 'chrome-extension://foreign-extension/popup.html' },
    },
    {
      name: 'extension child frame',
      sender: {
        frameId: 1,
        url: 'chrome-extension://extension-id/editor.html',
        tab: { id: 4, url: 'chrome-extension://extension-id/editor.html' },
      },
    },
  ])('rejects START_RECORDING from an untrusted $name', async ({ sender }) => {
    const result = await mocks.messageListener?.({
      type: 'START_RECORDING',
      sessionId: 'project-a',
      mode: 'steps',
    }, sender);

    expect(result).toBeUndefined();
    expectNoPermissionOrOperationSideEffects();
    expect(mocks.tabsQuery).not.toHaveBeenCalled();
  });

  it('accepts toolbar controls from the active recorder top frame', async () => {
    mocks.getRecordingState.mockResolvedValue(activeRecordingState());

    const result = await send<{ ok: boolean }>(
      { type: 'PAUSE_RECORDING', runId: 'run-1' },
      {
        frameId: 0,
        url: 'https://example.com/',
        tab: { id: 4, url: 'https://example.com/' },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', phase: 'paused' }),
    );
  });

  it('rejects toolbar controls from a different tab before mutation', async () => {
    mocks.getRecordingState.mockResolvedValue(activeRecordingState());

    const result = await send<{ ok: boolean }>(
      { type: 'PAUSE_RECORDING', runId: 'run-1' },
      {
        frameId: 0,
        url: 'https://example.com/',
        tab: { id: 5, url: 'https://example.com/' },
      },
    );

    expect(result).toMatchObject({ ok: false });
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('continuation recording start', () => {
  it('refuses a continuation whose editor does not own the named Project', async () => {
    const result = await send<StartRecordingResult>({
      type: 'START_RECORDING',
      sessionId: 'project-b',
      mode: 'steps',
      continuation: {},
    }, editorSender('project-a'));

    expect(result).toMatchObject({ ok: false });
    expect(mocks.permissionsContains).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('refuses a continuation before opening any tab when the source host is not granted', async () => {
    mocks.permissionsContains.mockResolvedValue(false);

    const result = await send<StartRecordingResult>({
      type: 'START_RECORDING',
      sessionId: 'project-a',
      mode: 'steps',
      continuation: {},
    });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.permissionsContains).toHaveBeenCalledWith({ origins: ['https://persisted.example/*'] });
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('records into the Project\'s own source page rather than the active tab', async () => {
    const sourceTab = {
      id: 11,
      windowId: 5,
      url: 'https://persisted.example/path?fresh=1#target',
      status: 'complete',
    };
    mocks.permissionsContains.mockResolvedValue(true);
    mocks.tabsQuery.mockResolvedValue([sourceTab]);
    mocks.tabsGet.mockResolvedValue(sourceTab);
    // Ends the run at injection: everything under test happens before it.
    mocks.executeScript.mockRejectedValue(new Error('scripting is unavailable in tests'));

    await send<StartRecordingResult>({
      type: 'START_RECORDING',
      sessionId: 'project-a',
      mode: 'steps',
      continuation: {},
    });

    // The only tabs.query is the exact-URL source lookup: an editor-initiated run must never fall back to whatever tab is currently active.
    expect(mocks.tabsQuery).toHaveBeenCalledTimes(1);
    expect(mocks.tabsQuery).toHaveBeenCalledWith({});
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(11, { active: true });
    expect(mocks.setRecordingState).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'recording', sessionId: 'project-a', tabId: 11 }),
    );
  });
});

describe('continuation from a source page that no longer loads', () => {
  const SOURCE_URL = 'https://persisted.example/path?fresh=1#target';

  it('closes the tab it opened and reports a dedicated code instead of a failed recording', async () => {
    mocks.permissionsContains.mockResolvedValue(true);
    mocks.tabsQuery.mockResolvedValue([]);
    mocks.tabsCreate.mockResolvedValue({ id: 12, windowId: 5, url: SOURCE_URL, status: 'loading' });
    // Chrome keeps the failed URL in tab.url; only scripting reveals the error page.
    mocks.tabsGet.mockResolvedValue({ id: 12, windowId: 5, url: SOURCE_URL, status: 'complete' });
    mocks.tabsRemove.mockResolvedValue(undefined);
    mocks.executeScript.mockRejectedValue(new Error('Frame with ID 0 is showing error page'));

    const result = await send<StartRecordingResult>({
      type: 'START_RECORDING',
      sessionId: 'project-a',
      mode: 'steps',
      continuation: {},
    });

    expect(result).toEqual({
      ok: false,
      code: 'SOURCE_PAGE_UNREACHABLE',
      error: '無法載入原本的頁面，未開始錄製。請確認網路連線，或改在其他頁面接續錄製。',
    });
    expect(mocks.tabsRemove).toHaveBeenCalledWith(12);
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });

  it('recognizes a tab already showing chrome-error:// and leaves a reused tab open', async () => {
    const errorTab = { id: 11, windowId: 5, url: SOURCE_URL, status: 'complete' };
    mocks.permissionsContains.mockResolvedValue(true);
    mocks.tabsQuery.mockResolvedValue([errorTab]);
    mocks.tabsGet.mockResolvedValue({ ...errorTab, url: 'chrome-error://chromewebdata/' });

    const result = await send<StartRecordingResult>({
      type: 'START_RECORDING',
      sessionId: 'project-a',
      mode: 'steps',
      continuation: {},
    });

    expect(result).toMatchObject({ ok: false, code: 'SOURCE_PAGE_UNREACHABLE' });
    expect(mocks.tabsRemove).not.toHaveBeenCalled();
    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('background source-permission preflight', () => {
  it('rejects a forged editor/session before reading a recapture target', async () => {
    const result = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'project-b',
      target: { kind: 'single', stepId: 'step-1' },
    }, editorSender('project-a'));

    expect(result).toMatchObject({ ok: false, code: 'INVALID_EDITOR' });
    expect(mocks.getStep).not.toHaveBeenCalled();
    expectNoPermissionOrOperationSideEffects();
  });

  it('rejects a missing or structurally changed recapture target', async () => {
    mocks.getStep.mockResolvedValueOnce(undefined);
    const missing = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'project-a',
      target: { kind: 'single', stepId: 'step-1' },
    });

    mocks.getStep.mockResolvedValueOnce(ordinaryStep({ screenshotBlob: undefined }));
    const changed = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'project-a',
      target: { kind: 'single', stepId: 'step-1' },
    });

    expect(missing).toMatchObject({ ok: false, code: 'TARGET_NOT_FOUND' });
    expect(changed).toMatchObject({ ok: false, code: 'TARGET_CHANGED' });
    expectNoPermissionOrOperationSideEffects();
  });

  it('rejects a restricted persisted recapture URL', async () => {
    mocks.getStep.mockResolvedValue(ordinaryStep({ url: 'https://chromewebstore.google.com/detail/test' }));
    const result = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'project-a',
      target: { kind: 'single', stepId: 'step-1' },
    });

    expect(result).toMatchObject({ ok: false, code: 'RESTRICTED_SOURCE' });
    expectNoPermissionOrOperationSideEffects();
  });

  it('resolves continuation authority from the Project\'s last persisted step', async () => {
    mocks.getSteps.mockResolvedValue([
      ordinaryStep({ id: 'step-1', order: 0, url: 'https://first.example/start' }),
      ordinaryStep({ id: 'step-2', order: 1, url: 'https://persisted.example/path?fresh=1#target' }),
    ]);

    const result = await send<PreflightProjectContinuationSourcePermissionResult>({
      type: 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION',
      sessionId: 'project-a',
      sourceUrl: 'https://stale-ui.example/wrong',
    } as BackgroundMessage);

    expect(result).toEqual({
      ok: true,
      sourceUrl: 'https://persisted.example/path?fresh=1#target',
      sourceOrigin: 'https://persisted.example',
      permissionPattern: 'https://persisted.example/*',
    });
    expectNoPermissionOrOperationSideEffects();
  });

  it('rejects continuation for a forged editor, an empty Project, or a restricted source', async () => {
    const forged = await send<PreflightProjectContinuationSourcePermissionResult>({
      type: 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION',
      sessionId: 'project-b',
    }, editorSender('project-a'));

    mocks.getSteps.mockResolvedValueOnce([]);
    const empty = await send<PreflightProjectContinuationSourcePermissionResult>({
      type: 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION',
      sessionId: 'project-a',
    });

    mocks.getSteps.mockResolvedValueOnce([ordinaryStep({ url: 'chrome://settings' })]);
    const restricted = await send<PreflightProjectContinuationSourcePermissionResult>({
      type: 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION',
      sessionId: 'project-a',
    });

    expect(forged).toMatchObject({ ok: false, code: 'INVALID_EDITOR' });
    expect(empty).toMatchObject({ ok: false, code: 'SOURCE_NOT_FOUND' });
    expect(restricted).toMatchObject({ ok: false, code: 'RESTRICTED_SOURCE' });
    expectNoPermissionOrOperationSideEffects();
  });

  it('uses only persisted recapture authority and ignores a UI-provided URL', async () => {
    const result = await send<PreflightStepRecaptureSourcePermissionResult>({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'project-a',
      target: { kind: 'single', stepId: 'step-1' },
      sourceUrl: 'https://stale-ui.example/wrong',
    } as BackgroundMessage);

    expect(result).toEqual({
      ok: true,
      sourceUrl: 'https://persisted.example/path?fresh=1#target',
      sourceOrigin: 'https://persisted.example',
      permissionPattern: 'https://persisted.example/*',
    });
    expectNoPermissionOrOperationSideEffects();
  });
});

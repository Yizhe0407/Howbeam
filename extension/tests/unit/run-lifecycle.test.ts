import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { createControlPlane } from '@/lib/recording/background/control-plane';
import { createRunLifecycle, type RunLifecycleDependencies } from '@/lib/recording/background/run-lifecycle';
import { createRunState } from '@/lib/recording/background/run-state';
import type { Step } from '@/lib/storage/models';
import type { RecordingState } from '@/lib/storage/recording-state';
import type { StartRecordingMessage } from '@/lib/runtime/messages';
import { t } from '@/lib/shared/i18n';
import { makeRecordingState } from '../setup/recording-state';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

/**
 * Start, stop, reset and restart recovery against the real control plane,
 * queues, ready gate and run-state writes. The browser, repositories, cleanup
 * helpers and the run's ending are mocked; recording state is a live cell.
 */

const mocks = await vi.hoisted(async () =>
  (await import('../setup/background-test-utils')).makeBackgroundMocks());
const repositories = vi.hoisted(() => ({
  getProject: vi.fn(),
}));
const cleanup = vi.hoisted(() => ({
  deleteEmptySnapshotAnchor: vi.fn(),
  deleteEmptySnapshotAnchorBestEffort: vi.fn(),
  reclaimAbandonedAutoCreatedProject: vi.fn(),
}));

vi.mock('wxt/browser', async () =>
  (await import('../setup/background-test-utils')).mockWxtBrowserModule(mocks));
vi.mock('@/lib/storage/step-repository', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStepRepositoryModule(mocks, importOriginal));
vi.mock('@/lib/storage/storage', async (importOriginal) =>
  (await import('../setup/background-test-utils')).mockStorageModule(mocks, importOriginal));
vi.mock('@/lib/storage/project-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/project-repository')>()),
  getProject: repositories.getProject,
}));
vi.mock('@/lib/recording/background/run-cleanup', () => cleanup);

const PAGE_URL = 'https://site.example/page';
const SESSION_ID = 'project-a';
const TAB_ID = 4;
const WINDOW_ID = 6;
const SNAPSHOT_CONTEXT = {
  url: PAGE_URL,
  viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
  devicePixelRatio: 2,
  timestamp: 7,
};

function liveRun(overrides: Partial<RecordingState> = {}): RecordingState {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    phase: 'recording',
    mode: 'steps',
    sessionId: SESSION_ID,
    runId: 'run-1',
    tabId: TAB_ID,
    ...overrides,
  });
}

const start = (overrides: Partial<StartRecordingMessage> = {}): StartRecordingMessage => ({
  type: 'START_RECORDING',
  sessionId: SESSION_ID,
  mode: 'steps',
  ...overrides,
});

let state: RecordingState;
let control: ReturnType<typeof createControlPlane>;
let injectRecorder: ReturnType<typeof vi.fn>;
let stopRecorderInTab: ReturnType<typeof vi.fn>;
let createAndActivateSnapshotAnchor: ReturnType<typeof vi.fn>;
let stopRunWithError: ReturnType<typeof vi.fn>;
let handleRecordedTabGone: ReturnType<typeof vi.fn>;
let isStartingRecapture: ReturnType<typeof vi.fn>;
let lifecycle: ReturnType<typeof createRunLifecycle>;

beforeEach(() => {
  vi.clearAllMocks();
  state = makeRecordingState();
  mocks.getRecordingState.mockImplementation(async () => state);
  mocks.setRecordingState.mockImplementation(async (next: RecordingState) => {
    state = next;
  });
  mocks.tabsQuery.mockResolvedValue([{ id: TAB_ID, windowId: WINDOW_ID, url: PAGE_URL }]);
  mocks.tabsGet.mockResolvedValue({ id: TAB_ID, windowId: WINDOW_ID, url: PAGE_URL });
  mocks.permissionsContains.mockResolvedValue(true);
  mocks.getStep.mockResolvedValue(undefined);
  repositories.getProject.mockResolvedValue({ id: SESSION_ID, title: 'Guide', contentRevision: 3 });
  cleanup.deleteEmptySnapshotAnchorBestEffort.mockResolvedValue(undefined);
  cleanup.reclaimAbandonedAutoCreatedProject.mockResolvedValue(undefined);

  control = createControlPlane({ discardPendingUndo: vi.fn() });
  // A recorder that answers READY for the run the gate is waiting on.
  injectRecorder = vi.fn(async (tabId: number) => {
    control.pendingSnapshotContext = SNAPSHOT_CONTEXT;
    control.pendingRecorderReady?.signal({ runId: state.runId!, tabId, controlVersion: control.controlVersion });
  });
  stopRecorderInTab = vi.fn().mockResolvedValue(undefined);
  createAndActivateSnapshotAnchor = vi.fn().mockResolvedValue('anchor-1');
  stopRunWithError = vi.fn().mockResolvedValue(undefined);
  handleRecordedTabGone = vi.fn().mockResolvedValue(undefined);
  isStartingRecapture = vi.fn(() => false);
  lifecycle = createRunLifecycle({
    control,
    runtime: { injectRecorder, stopRecorderInTab } as unknown as RunLifecycleDependencies['runtime'],
    runState: createRunState({ control }),
    captureFlow: {
      createAndActivateSnapshotAnchor,
      withdrawAnchorThenDelete: vi.fn(),
    } as unknown as RunLifecycleDependencies['captureFlow'],
    recaptureFlow: { isStartingRecapture } as unknown as RunLifecycleDependencies['recaptureFlow'],
    runEnding: { stopRunWithError, handleRecordedTabGone } as unknown as RunLifecycleDependencies['runEnding'],
  });
});

const popup = {} as Browser.runtime.MessageSender;

describe('startRecording', () => {
  it('starts a steps run in the active tab once its recorder is ready', async () => {
    const result = await lifecycle.startRecording(start(), popup);

    expect(result).toEqual({ ok: true, sessionId: SESSION_ID, runId: expect.any(String) });
    expect(state).toMatchObject({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      mode: 'steps',
      tabId: TAB_ID,
      itemCount: 0,
      targetProjectTitle: 'Guide',
    });
    expect(injectRecorder).toHaveBeenCalledWith(TAB_ID, true);
    expect(control.acceptingClicks).toBe(true);
  });

  it('takes a snapshot run’s base image from the recorder’s capture context', async () => {
    await expect(lifecycle.startRecording(start({ mode: 'snapshot' }), popup)).resolves.toMatchObject({ ok: true });

    expect(createAndActivateSnapshotAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'starting', mode: 'snapshot' }),
      TAB_ID,
      WINDOW_ID,
      SNAPSHOT_CONTEXT,
      control.controlVersion,
    );
    expect(state.phase).toBe('recording');
  });

  it('remembers an auto-created project so an empty run can reclaim it', async () => {
    await lifecycle.startRecording(start({ autoCreatedProject: true }), popup);

    expect(state).toMatchObject({ autoCreatedProjectId: SESSION_ID, targetProjectTitle: null });
  });

  it('refuses while another operation owns the recorder', async () => {
    state = liveRun({ sessionId: 'project-b' });
    await expect(lifecycle.startRecording(start(), popup))
      .resolves.toEqual({ ok: false, error: t().recaptureFlow.activeOperation });

    state = makeRecordingState();
    isStartingRecapture.mockReturnValue(true);
    await expect(lifecycle.startRecording(start(), popup))
      .resolves.toEqual({ ok: false, error: t().recaptureFlow.activeOperation });
    expect(injectRecorder).not.toHaveBeenCalled();
  });

  it('refuses a project that no longer exists', async () => {
    repositories.getProject.mockResolvedValue(undefined);

    await expect(lifecycle.startRecording(start(), popup))
      .resolves.toEqual({ ok: false, error: t().background.recordTargetMissing });
  });

  it('records why it cannot start on a browser page', async () => {
    mocks.tabsQuery.mockResolvedValue([{ id: TAB_ID, windowId: WINDOW_ID, url: 'chrome://settings' }]);

    await expect(lifecycle.startRecording(start(), popup))
      .resolves.toEqual({ ok: false, error: t().background.restrictedBrowserPage });
    expect(state).toMatchObject({ phase: 'error', recoverableError: { code: 'RESTRICTED_PAGE' } });
  });

  it('records why it cannot start without a tab', async () => {
    mocks.tabsQuery.mockResolvedValue([]);

    await expect(lifecycle.startRecording(start(), popup))
      .resolves.toEqual({ ok: false, error: t().background.noActiveTab });
    expect(state.recoverableError?.code).toBe('NO_ACTIVE_TAB');
  });

  it('ends the run when the recorder cannot be injected', async () => {
    silenceIntentionalErrorLogs();
    injectRecorder.mockRejectedValue(new Error('Cannot access contents of the page'));

    await lifecycle.startRecording(start(), popup);

    expect(stopRunWithError).toHaveBeenCalledWith(state.runId, t().background.injectFailed, control.controlVersion);
    expect(control.acceptingClicks).toBe(false);
  });
});

describe('stopRecording', () => {
  it('ends the run, keeps its notice, and cleans up after the run stopped', async () => {
    state = liveRun({ error: 'shown', recoverableError: { code: 'CAPTURE_FAILED', message: 'shown' } });

    await lifecycle.stopRecording();

    expect(state).toMatchObject({ isRecording: false, phase: 'idle', runId: null, error: 'shown' });
    expect(cleanup.deleteEmptySnapshotAnchorBestEffort).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
    expect(stopRecorderInTab).toHaveBeenCalledWith(TAB_ID);
    expect(cleanup.reclaimAbandonedAutoCreatedProject).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
  });

  it('does nothing without a live recording', async () => {
    await lifecycle.stopRecording();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
  });
});

describe('recoverInterruptedRecording', () => {
  const anchor = (overrides: Partial<Step> = {}): Step => ({
    id: 'anchor-1',
    sessionId: SESSION_ID,
    order: 0,
    screenshotBlob: new Blob(['base']),
    bounds: null,
    devicePixelRatio: 2,
    description: '',
    url: PAGE_URL,
    timestamp: 1,
    groupId: 'anchor-1',
    ...overrides,
  });

  it('leaves an intact run alone', async () => {
    state = liveRun();

    await lifecycle.recoverInterruptedRecording();

    expect(mocks.setRecordingState).not.toHaveBeenCalled();
    expect(stopRunWithError).not.toHaveBeenCalled();
  });

  it('hands a run whose tab is gone to the tab-gone path', async () => {
    state = liveRun();
    mocks.tabsGet.mockRejectedValue(new Error('No tab with id: 4.'));

    await lifecycle.recoverInterruptedRecording();

    expect(handleRecordedTabGone).toHaveBeenCalledWith(TAB_ID);
  });

  it('keeps a steps run waiting on a page it cannot record', async () => {
    state = liveRun();
    mocks.tabsGet.mockResolvedValue({ id: TAB_ID, url: 'chrome://extensions' });

    await lifecycle.recoverInterruptedRecording();

    expect(state).toMatchObject({ isRecording: true, recoverableError: { code: 'RECORDING_WAITING_RESTRICTED_PAGE' } });
  });

  it('ends a snapshot run whose base image is gone', async () => {
    state = liveRun({ mode: 'snapshot', groupAnchorId: 'anchor-1' });
    mocks.getStep.mockResolvedValue(anchor({ screenshotBlob: undefined }));

    await lifecycle.recoverInterruptedRecording();

    expect(stopRunWithError).toHaveBeenCalledWith(
      'run-1',
      expect.any(String),
      control.controlVersion,
      expect.objectContaining({ code: 'SNAPSHOT_ANCHOR_MISSING' }),
    );
  });

  it('ends a snapshot run whose tab now shows another page', async () => {
    state = liveRun({ mode: 'snapshot', groupAnchorId: 'anchor-1' });
    mocks.getStep.mockResolvedValue(anchor({ url: 'https://site.example/elsewhere' }));

    await lifecycle.recoverInterruptedRecording();

    expect(stopRunWithError).toHaveBeenCalledWith(
      'run-1',
      expect.any(String),
      control.controlVersion,
      expect.objectContaining({ code: 'RECORDED_TAB_CLOSED' }),
    );
  });
});

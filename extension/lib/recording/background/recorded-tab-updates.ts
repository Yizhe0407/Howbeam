import { browser, type Browser } from 'wxt/browser';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import { getRecordingTabUpdateAction } from '../recording-guards';
import { describeBrowserError, isErrorPageError, isMissingTabError } from '../../runtime/browser-errors';
import { getRecordingState } from '../../storage/storage';
import type { RecordingState, RecoverableRecordingError } from '../../storage/recording-state';
import { t } from '@/lib/shared/i18n';
import {
  clearRecordingWait,
  isRecordingWaitError,
  isWaitingForSiteAccess,
  markRecordingWait,
  recordingWaitError,
  unrecordableReason,
  type RecordingWaitReason,
} from './recording-wait';
import type { ControlPlane } from './control-plane';
import type { RecorderRuntime } from './recorder-runtime';
import type { RunState } from './run-state';
import type { FollowMode } from './follow-mode';
import type { RecaptureFlow } from './recapture-flow';

export interface RecordedTabUpdateDependencies {
  control: ControlPlane;
  runtime: RecorderRuntime;
  runState: RunState;
  followMode: FollowMode;
  recaptureFlow: RecaptureFlow;
  stopRunWithError(
    runId: string,
    error: string,
    expectedControlVersion: number,
    recoverableError?: RecoverableRecordingError,
  ): Promise<void>;
}

/** What a navigation in the recorded tab means for the live run: re-inject the
 * recorder, wait out a page it cannot run on, or end a snapshot whose document
 * is gone. The tab listener stays wired in the background entrypoint. */
export function createRecordedTabUpdates(deps: RecordedTabUpdateDependencies) {
  const { control, runtime: recorderRuntime, followMode, recaptureFlow, stopRunWithError } = deps;
  const { updateRunState, setRunError } = deps.runState;

  const activeRunInTab = (
    state: RecordingState,
    tabId: number,
  ): { state: RecordingState; runId: string } | null => {
    if (
      !state.isRecording ||
      state.operation !== 'recording' ||
      state.tabId !== tabId ||
      !state.runId
    ) {
      return null;
    }
    return { state, runId: state.runId };
  };

  /** Puts the run on hold in a page the recorder cannot run on; it resumes
   * when the tab (or a tab it follows into) shows a recordable page again. */
  const markRunWaiting = (runId: string, reason: RecordingWaitReason, expectedControlVersion: number) =>
    updateRunState(runId, (current) => markRecordingWait(current, reason), expectedControlVersion);

  /** Lifts a hold once the recorder runs again; a write only when one is set,
   * so ordinary in-run navigations cost no state churn. */
  const clearRunWaiting = (runId: string, expectedControlVersion: number) =>
    control.writeStateIf(
      expectedControlVersion,
      (current) =>
        current.isRecording &&
        current.operation === 'recording' &&
        current.runId === runId &&
        isRecordingWaitError(current.recoverableError),
      clearRecordingWait,
    );

  /** 重新注入所有可存取 frame；注入失敗的結束方式由呼叫端決定。 */
  const reinjectRecorder = async (
    tabId: number,
    failureLog: string,
  ): Promise<'injected' | 'tab-closed' | 'error-page' | 'failed'> => {
    try {
      await recorderRuntime.injectRecorder(tabId, true);
      return 'injected';
    } catch (err) {
      // Tab closure is owned by handleRecordedTabGone (fed by tabs.onRemoved),
      // which may hand the run to another tab: never end the run from here.
      if (isMissingTabError(err)) return 'tab-closed';
      console.error(failureLog, describeBrowserError(err), err);
      return isErrorPageError(err) ? 'error-page' : 'failed';
    }
  };

  /** The <all_urls> grant arrived while a run waits for site access in its
   * tab: that page may be recordable now, so the run resumes there. */
  async function resumeRunWaitingForSiteAccess(): Promise<void> {
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      !state.isRecording ||
      state.operation !== 'recording' ||
      !state.runId ||
      state.tabId == null ||
      !isWaitingForSiteAccess(state)
    ) {
      return;
    }
    const { runId, tabId } = state;
    let url: string | undefined;
    try {
      url = (await browser.tabs.get(tabId)).url;
    } catch {
      return; // Gone: tabs.onRemoved owns what happens to the run.
    }
    const waitReason = await unrecordableReason(url);
    if (waitReason) {
      await markRunWaiting(runId, waitReason, expectedControlVersion);
      return;
    }
    // Cleared before injecting so the fresh toolbar never flashes the old notice.
    await clearRunWaiting(runId, expectedControlVersion);
    const resumed = await reinjectRecorder(tabId, '[howbeam] failed to resume the recorder after the permission grant:');
    if (resumed === 'error-page') await markRunWaiting(runId, 'page-failed', expectedControlVersion);
  }

  async function handleTabUpdated(
    tabId: number,
    changeInfo: Browser.tabs.OnUpdatedInfo,
    tab: Browser.tabs.Tab,
  ): Promise<void> {
    if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete' && !changeInfo.url) return;
    // A recapture source tab is the recapture flow's to handle.
    if (await recaptureFlow.handleSourceTabUpdated(tabId, changeInfo)) return;
    const expectedControlVersion = control.controlVersion;
    const current = await getRecordingState();
    if (expectedControlVersion !== control.controlVersion) return;
    const active = activeRunInTab(current, tabId);
    if (!active) {
      // Another tab finished loading a web page while the user is on it (a
      // blank tab they typed a URL into): the run may follow it now.
      if (changeInfo.status === 'complete' && tab.active && isRecordableTabUrl(tab.url)) {
        followMode.scheduleFollowForLoadedTab(tabId, current);
      }
      return;
    }
    const { state, runId } = active;

    if (state.mode === 'snapshot' && state.phase === 'preparing-next') {
      if (changeInfo.status !== 'complete') return;
      const waitReason = await unrecordableReason(tab.url);
      if (waitReason) {
        await setRunError(
          runId,
          waitReason === 'site-access' ? recordingWaitError(waitReason).message : t().background.snapshotUnavailableHere,
        );
        return;
      }
      const restored = await reinjectRecorder(
        tabId,
        '[howbeam] failed to restore snapshot preparation toolbar after navigation:',
      );
      if (restored === 'failed' || restored === 'error-page') {
        await setRunError(runId, t().background.controlsUnavailableHere);
      }
      return;
    }

    const updateAction = getRecordingTabUpdateAction(state.mode, changeInfo);
    // A snapshot's coordinates belong to one immutable document: fail closed as
    // soon as it navigates, never re-inject just because a loading page completes.
    if (updateAction === 'stop-snapshot') {
      await stopRunWithError(runId, t().background.stoppedSnapshotPageChanged, expectedControlVersion);
      return;
    }
    if (updateAction !== 'reinject') return;

    // A steps run waits out a page it cannot record (a browser page, a site
    // without access, a failed load) exactly like follow mode waits out an
    // ineligible tab: nothing is lost, and the next recordable page resumes it.
    const waitReason = await unrecordableReason(tab.url);
    if (waitReason) {
      await markRunWaiting(runId, waitReason, expectedControlVersion);
      return;
    }
    // Cleared before injecting so the fresh toolbar never flashes the old notice.
    await clearRunWaiting(runId, expectedControlVersion);
    const reinjected = await reinjectRecorder(
      tabId,
      '[howbeam] failed to re-inject recorder after navigation:',
    );
    if (reinjected === 'error-page') {
      await markRunWaiting(runId, 'page-failed', expectedControlVersion);
    } else if (reinjected === 'failed') {
      await stopRunWithError(
        runId,
        t().background.stoppedRecorderUnavailable,
        expectedControlVersion,
      );
    }
  }

  return { handleTabUpdated, resumeRunWaitingForSiteAccess };
}

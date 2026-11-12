import type { Browser } from 'wxt/browser';
import { isErrorPageError, isMissingTabError } from '../../runtime/browser-errors';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import { getRecordingTabUpdateAction } from '../recording-guards';
import { isSuperseded, type OperationContext, type RunActor } from './actor';
import type { Lifecycle } from './lifecycle';
import type { RunPorts } from './ports';
import { WAIT_NOTICES, type Recording, type WaitReason } from './state';
import { liveRecording, movedToTab, notice, waitLifted, waiting, withNotice, withRecording } from './transitions';

/**
 * How long a newly activated tab must stay active before a run follows it:
 * flicking through tabs must not inject the recorder into every one passed.
 */
export const FOLLOW_DEBOUNCE_MS = 300;

type InjectOutcome = 'injected' | 'tab-closed' | 'error-page' | 'failed';

/**
 * What a navigation in the recorded tab means for the run, and following the
 * user into another tab. A steps run, or a snapshot run still choosing its
 * page, moves to the tab the user goes to (with the all-sites grant); a
 * captured snapshot never moves, since its coordinates belong to one document.
 */
export function createNavigation(deps: { actor: RunActor; ports: RunPorts; lifecycle: Lifecycle }) {
  const { actor, ports, lifecycle } = deps;
  let followTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tabs the run lived in before, most recent last: where it goes back to when a tab closes. Memory only. */
  let trail: { runId: string; tabIds: number[] } | null = null;
  /** The tab a run is moving out of while the move is in flight; its recorder stays trusted. */
  let followOrigin: number | null = null;

  /**
   * Why a tab URL cannot host the recorder, or null when it can. Without
   * access to a site the browser reports no URL at all; with the all-sites
   * grant a missing URL can only be a browser page.
   */
  async function unrecordableReason(url: string | undefined): Promise<WaitReason | null> {
    if (isRecordableTabUrl(url)) return null;
    if (url === undefined && !(await ports.permissions.hasAllSites())) return 'site-access';
    return 'restricted-page';
  }

  async function inject(tabId: number, failureLog: string): Promise<InjectOutcome> {
    try {
      await ports.recorder.inject(tabId);
      return 'injected';
    } catch (error) {
      // A closed tab is tabs.onRemoved's to handle: it may hand the run to another tab.
      if (isMissingTabError(error)) return 'tab-closed';
      console.error(failureLog, error);
      return isErrorPageError(error) ? 'error-page' : 'failed';
    }
  }

  async function commitLive(
    ctx: OperationContext,
    runId: string,
    change: (recording: Recording) => Recording,
  ): Promise<void> {
    const live = liveRecording(ctx.state(), runId);
    if (live) await ctx.commit((state) => withRecording(state, change(live)));
  }

  function canFollow(recording: Recording): boolean {
    if (recording.mode === 'steps') return recording.phase === 'recording' || recording.phase === 'paused';
    return recording.phase === 'preparing-next';
  }

  async function recordableTab(tabId: number): Promise<Browser.tabs.Tab | null> {
    try {
      const tab = await ports.tabs.get(tabId);
      return isRecordableTabUrl(tab.url) ? tab : null;
    } catch {
      return null;
    }
  }

  function remember(runId: string, tabId: number): void {
    const tabIds = trail?.runId === runId ? trail.tabIds.filter((id) => id !== tabId) : [];
    tabIds.push(tabId);
    trail = { runId, tabIds };
  }

  function forget(tabId: number): void {
    if (trail) trail = { ...trail, tabIds: trail.tabIds.filter((id) => id !== tabId) };
  }

  /**
   * Moves the run into `tabId`. The new tab is published before injecting, so
   * the new recorder's READY and keep-alive match it; until the move settles
   * the old tab stays trusted too. A failed injection hands the run back to
   * the old tab, on hold.
   */
  async function moveRun(ctx: OperationContext, recording: Recording, tabId: number): Promise<'moved' | 'failed'> {
    const previousTabId = recording.tabId;
    followOrigin = previousTabId;
    try {
      await ctx.commit((state) => withRecording(state, movedToTab(recording, tabId)));
      try {
        await ctx.until(ports.recorder.inject(tabId));
        return 'moved';
      } catch (error) {
        if (isSuperseded(error)) throw error;
        console.warn('[howbeam] failed to move the recording into another tab', error);
      }
      await commitLive(ctx, recording.runId, (live) => waiting(movedToTab(live, previousTabId), 'follow-failed'));
      return 'failed';
    } finally {
      if (followOrigin === previousTabId) followOrigin = null;
    }
  }

  async function followTo(ctx: OperationContext, tabId: number): Promise<void> {
    const recording = ctx.state().operation;
    if (recording.kind !== 'recording' || recording.tabId === tabId || !canFollow(recording)) return;
    if (!(await ports.permissions.hasAllSites())) return;
    const tab = await recordableTab(tabId);
    // Still the active tab of its window after the debounce, and a web page (never an extension page).
    if (!tab?.active) return;
    if ((await moveRun(ctx, recording, tabId)) !== 'moved') return;
    remember(recording.runId, recording.tabId);
    forget(tabId);
    await ports.recorder.stop(recording.tabId);
  }

  /** A tab was activated (or its window focused): follow it once it stays in front. */
  function scheduleFollow(tabId: number): void {
    if (followTimer != null) clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      followTimer = null;
      void actor
        .run((ctx) => followTo(ctx, tabId))
        .catch((error) => {
          if (!isSuperseded(error)) console.error('[howbeam] failed to follow the activated tab', error);
        });
    }, FOLLOW_DEBOUNCE_MS);
  }

  /**
   * Another tab loaded a web page: a blank tab the user typed a URL into is
   * followed once it loads, but only as the active tab of the focused window.
   */
  function followLoadedTab(tabId: number, recording: Recording): void {
    if (!canFollow(recording) || recording.tabId === tabId) return;
    void ports.tabs
      .activeInFocusedWindow()
      .then((focused) => {
        if (focused?.id === tabId) scheduleFollow(tabId);
      })
      .catch((error) => {
        console.warn('[howbeam] failed to inspect the focused window', error);
      });
  }

  /**
   * The recorded tab closed: the run goes on where the user is now, or back
   * in the tab it came from; 'nowhere' when neither can host it.
   */
  async function continueAfterTabClosed(ctx: OperationContext, recording: Recording): Promise<'moved' | 'nowhere'> {
    forget(recording.tabId);
    if (!canFollow(recording) || !(await ports.permissions.hasAllSites())) return 'nowhere';
    const focused = await ports.tabs.activeInFocusedWindow().catch(() => undefined);
    const previous = trail?.runId === recording.runId ? [...trail.tabIds].reverse() : [];
    const candidates = [focused?.id, ...previous].filter(
      (id, index, all): id is number => id != null && id !== recording.tabId && all.indexOf(id) === index,
    );
    for (const candidate of candidates) {
      if (!(await recordableTab(candidate))) continue;
      const live = liveRecording(ctx.state(), recording.runId);
      if (!live) return 'nowhere';
      if ((await moveRun(ctx, live, candidate)) === 'moved') {
        forget(candidate);
        return 'moved';
      }
    }
    return 'nowhere';
  }

  async function onRecordedTabUpdated(
    ctx: OperationContext,
    recording: Recording,
    changeInfo: Browser.tabs.OnUpdatedInfo,
    tab: Browser.tabs.Tab,
  ): Promise<void> {
    const { runId, tabId } = recording;
    if (recording.mode === 'snapshot' && recording.phase === 'preparing-next') {
      if (changeInfo.status !== 'complete') return;
      const reason = await unrecordableReason(tab.url);
      if (reason) {
        const copy = reason === 'site-access' ? WAIT_NOTICES['site-access'].copy : 'background.snapshotUnavailableHere';
        await commitLive(ctx, runId, (live) => withNotice(live, notice('CAPTURE_FAILED', copy)));
        return;
      }
      const restored = await inject(
        tabId,
        '[howbeam] failed to restore snapshot preparation toolbar after navigation:',
      );
      if (restored === 'failed' || restored === 'error-page') {
        await commitLive(ctx, runId, (live) =>
          withNotice(live, notice('CAPTURE_FAILED', 'background.controlsUnavailableHere')),
        );
      }
      return;
    }

    const action = getRecordingTabUpdateAction(recording.mode, changeInfo);
    // A captured snapshot belongs to one document: it ends as soon as the page navigates.
    if (action === 'stop-snapshot') {
      await lifecycle.endWithError(
        ctx,
        recording,
        notice('RECORDING_STOPPED', 'background.stoppedSnapshotPageChanged'),
      );
      return;
    }
    if (action !== 'reinject') return;

    // A steps run waits out a page it cannot record; the next recordable page resumes it.
    const reason = await unrecordableReason(tab.url);
    if (reason) {
      await commitLive(ctx, runId, (live) => waiting(live, reason));
      return;
    }
    // Lifted before injecting, so the new toolbar never flashes the old notice.
    await commitLive(ctx, runId, waitLifted);
    const outcome = await inject(tabId, '[howbeam] failed to re-inject recorder after navigation:');
    if (outcome === 'error-page') {
      await commitLive(ctx, runId, (live) => waiting(live, 'page-failed'));
    } else if (outcome === 'failed') {
      const live = liveRecording(ctx.state(), runId);
      if (live)
        await lifecycle.endWithError(ctx, live, notice('RECORDING_STOPPED', 'background.stoppedRecorderUnavailable'));
    }
  }

  /** tabs.onUpdated, for every tab but a recapture's source tab. */
  async function handleTabUpdated(
    tabId: number,
    changeInfo: Browser.tabs.OnUpdatedInfo,
    tab: Browser.tabs.Tab,
  ): Promise<void> {
    if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete' && !changeInfo.url) return;
    await actor.ready();
    await actor
      .run(async (ctx) => {
        const recording = ctx.state().operation;
        if (recording.kind !== 'recording') return;
        if (recording.tabId !== tabId) {
          if (changeInfo.status === 'complete' && tab.active && isRecordableTabUrl(tab.url))
            followLoadedTab(tabId, recording);
          return;
        }
        await onRecordedTabUpdated(ctx, recording, changeInfo, tab);
      })
      .catch((error) => {
        if (!isSuperseded(error)) throw error;
      });
  }

  /** The all-sites grant arrived: a run waiting for site access may record its page now. */
  async function resumeAfterSiteAccess(): Promise<void> {
    await actor.ready();
    await actor
      .run(async (ctx) => {
        const recording = ctx.state().operation;
        if (recording.kind !== 'recording' || recording.wait !== 'site-access') return;
        let url: string | undefined;
        try {
          url = (await ports.tabs.get(recording.tabId)).url;
        } catch {
          return; // Gone: tabs.onRemoved handles the run.
        }
        const reason = await unrecordableReason(url);
        if (reason) {
          await commitLive(ctx, recording.runId, (live) => waiting(live, reason));
          return;
        }
        await commitLive(ctx, recording.runId, waitLifted);
        const outcome = await inject(
          recording.tabId,
          '[howbeam] failed to resume the recorder after the permission grant:',
        );
        if (outcome === 'error-page') await commitLive(ctx, recording.runId, (live) => waiting(live, 'page-failed'));
      })
      .catch((error) => {
        if (!isSuperseded(error)) throw error;
      });
  }

  return {
    unrecordableReason,
    scheduleFollow,
    continueAfterTabClosed,
    handleTabUpdated,
    resumeAfterSiteAccess,
    followOriginTabId: () => followOrigin,
  };
}

export type Navigation = ReturnType<typeof createNavigation>;

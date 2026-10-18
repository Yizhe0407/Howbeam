import { browser, type Browser } from 'wxt/browser';
import { queueLifecycle } from '../background-queues';
import { getRecordingState } from '../../storage/storage';
import type { RecordingState } from '../../storage/recording-state';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import { describeBrowserError } from '../../runtime/browser-errors';
import { clearRecordingWait, markRecordingWait } from './recording-wait';
import type { ControlPlane } from './control-plane';
import type { RecorderRuntime } from './recorder-runtime';

/** How long a newly activated tab must stay active before a live steps run
 * follows it. Flicking through several tabs (Ctrl+Tab, tab strip scrubbing)
 * must not inject the recorder into every tab passed on the way. */
const FOLLOW_ACTIVATION_DEBOUNCE_MS = 300;

/**
 * Follow-the-user recording: while a steps run is live, activating a different
 * eligible tab moves the run there instead of dropping clicks. The same goes
 * for a snapshot run that is only waiting to capture: nothing is frozen or
 * recorded yet, so choosing the page to capture is exactly what the user is
 * doing. Once a snapshot is captured it never follows (its coordinates are tied
 * to that one frozen document); without the
 * <all_urls> grant the run keeps its single-tab behavior; an ineligible tab
 * (restricted/extension page) moves nothing until an eligible tab is activated
 * — or, for a blank tab the user then types a URL into, until that page loads.
 * Closing the tab the run lives in hands the run on (to the now-active tab, or
 * back to a tab it came from) instead of ending it whenever the run could
 * have followed there anyway.
 * Tab listeners are wired in the background entrypoint — this module owns the
 * debounce and the move.
 */
export function createFollowMode(deps: { control: ControlPlane; runtime: RecorderRuntime }) {
  const { control, runtime } = deps;
  let followDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounces tab activations, then serializes the actual move through the
   * lifecycle queue so it can never interleave with START/STOP or another move. */
  function scheduleRecordingFollow(tabId: number): void {
    if (followDebounceTimer != null) clearTimeout(followDebounceTimer);
    followDebounceTimer = setTimeout(() => {
      followDebounceTimer = null;
      void queueLifecycle(() => followRecordingToTab(tabId)).catch((error) => {
        console.error('[stepmark] failed to follow the activated tab', describeBrowserError(error), error);
      });
    }, FOLLOW_ACTIVATION_DEBOUNCE_MS);
  }

  /** A steps run that is live, or a snapshot run still waiting for its capture. */
  function canFollow(state: Pick<RecordingState, 'mode' | 'phase'>): boolean {
    if (state.mode === 'steps') return state.phase === 'recording' || state.phase === 'paused';
    return state.mode === 'snapshot' && state.phase === 'preparing-next';
  }

  /** Tabs this run lived in before its current one, most recent last: where a
   * run goes back to when the tab it followed into closes and the now-active
   * tab cannot host it. Worker memory only — after a restart the active tab is
   * the sole hand-off candidate. */
  let trail: { runId: string; tabIds: number[] } | null = null;

  function rememberPreviousTab(runId: string, tabId: number): void {
    const tabIds = trail?.runId === runId ? trail.tabIds.filter((id) => id !== tabId) : [];
    tabIds.push(tabId);
    trail = { runId, tabIds };
  }

  function forgetTab(tabId: number): void {
    if (trail) trail = { ...trail, tabIds: trail.tabIds.filter((id) => id !== tabId) };
  }

  /** The tab, when it still exists and is a page the recorder may run on. */
  async function getRecordableTab(tabId: number): Promise<Browser.tabs.Tab | null> {
    try {
      const tab = await browser.tabs.get(tabId);
      return isRecordableTabUrl(tab.url) ? tab : null;
    } catch {
      return null; // Already gone.
    }
  }

  /**
   * Moves a live run from `previousTabId` into `tabId`. Publishes the new
   * tabId BEFORE injecting: the recorder's READY handshake and its keep-alive
   * port are validated against state.tabId, so injecting first would make the
   * fresh recorder reject itself and tear down immediately. Until the move
   * settles the previous tab stays trusted too, so its recorder survives a
   * failed move. On an injection failure the run is handed back to
   * `previousTabId`, on hold until the user reloads that page or goes back.
   */
  async function moveRun(
    expectedControlVersion: number,
    runId: string,
    previousTabId: number,
    tabId: number,
  ): Promise<'moved' | 'stale' | 'failed'> {
    control.followOriginTabId = previousTabId;
    try {
      const moved = await control.writeStateIf(
        expectedControlVersion,
        (current) =>
          current.isRecording &&
          current.operation === 'recording' &&
          current.runId === runId &&
          current.tabId === previousTabId,
        // A wait notice belonged to the page being left; the new page starts clean.
        (current) => ({ ...clearRecordingWait(current), tabId }),
      );
      if (!moved) return 'stale';
      try {
        // All-frames mirrors the START injection so iframe clicks in the followed
        // tab are relayed to its top-frame recorder rather than silently lost.
        await runtime.injectRecorder(tabId, true);
        return 'moved';
      } catch (error) {
        console.warn(
          '[stepmark] failed to move the recording into another tab',
          describeBrowserError(error),
          error,
        );
      }
      await control.writeStateIf(
        expectedControlVersion,
        (current) =>
          current.isRecording &&
          current.operation === 'recording' &&
          current.runId === runId &&
          current.tabId === tabId,
        (current) => markRecordingWait({ ...current, tabId: previousTabId }, 'follow-failed'),
      );
      return 'failed';
    } finally {
      if (control.followOriginTabId === previousTabId) control.followOriginTabId = null;
    }
  }

  function isFollowableRun(state: RecordingState): boolean {
    return state.operation === 'recording'
      && state.isRecording
      && !!state.runId
      && state.tabId != null
      && canFollow(state);
  }

  /** Re-reads the run and whether it may move across tabs at all. */
  async function readFollowableRun(expectedControlVersion: number): Promise<RecordingState | null> {
    const state = await getRecordingState();
    if (expectedControlVersion !== control.controlVersion || !isFollowableRun(state)) return null;
    if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) return null;
    return state;
  }

  async function followRecordingToTab(tabId: number): Promise<void> {
    const expectedControlVersion = control.controlVersion;
    const state = await readFollowableRun(expectedControlVersion);
    if (!state || state.tabId === tabId) return;
    const tab = await getRecordableTab(tabId);
    // `active` re-checks after the debounce that this tab still holds focus in
    // its window; a same-window switch-away already scheduled its own follow.
    // The recorder may only move into a normal web page, never a
    // browser/extension page (the editor included).
    if (!tab?.active) return;

    const previousTabId = state.tabId!;
    // On failure the run is back in the previous tab, whose recorder was never stopped.
    if ((await moveRun(expectedControlVersion, state.runId!, previousTabId, tabId)) !== 'moved') return;
    rememberPreviousTab(state.runId!, previousTabId);
    forgetTab(tabId);
    // The keep-alive rejection path would retire the old recorder eventually; an
    // explicit stop removes its toolbar right away. If the message cannot reach
    // a bfcached document, that same rejection path remains the backstop.
    await runtime.stopRecorderInTab(previousTabId);
  }

  /**
   * A tab other than the recorded one finished loading. A blank tab (Ctrl+T)
   * is not recordable when it is activated, so activation alone never follows
   * it; once the user types a URL there and it loads, follow it — but only
   * when it is the active tab of the focused window, so a background tab or
   * another window refreshing itself never steals the run.
   */
  function scheduleFollowForLoadedTab(tabId: number, state: RecordingState): void {
    if (!isFollowableRun(state) || state.tabId === tabId) return;
    void browser.tabs.query({ active: true, lastFocusedWindow: true }).then(([focused]) => {
      if (focused?.id === tabId) scheduleRecordingFollow(tabId);
    }).catch((error) => {
      console.warn('[stepmark] failed to inspect the focused window', error);
    });
  }

  /**
   * The recorded tab is gone. A run that follows the user continues where the
   * user now is — the focused window's active tab — or, when that page cannot
   * host it (a blank tab, a browser page), back in the tab it came from.
   * 'nowhere' means the run cannot continue and the caller must end it; a
   * single-tab run (no <all_urls> grant, a captured snapshot) always ends.
   * Must run inside the lifecycle queue so it never interleaves with a
   * START/STOP or another move.
   */
  async function continueAfterRecordedTabClosed(
    closedTabId: number,
    expectedControlVersion: number,
  ): Promise<'moved' | 'stale' | 'nowhere'> {
    forgetTab(closedTabId);
    const initial = await getRecordingState();
    if (
      expectedControlVersion !== control.controlVersion ||
      !initial.isRecording ||
      initial.operation !== 'recording' ||
      initial.tabId !== closedTabId
    ) {
      return 'stale';
    }
    const state = await readFollowableRun(expectedControlVersion);
    if (!state) return 'nowhere';
    const runId = state.runId!;
    let focused: Browser.tabs.Tab | undefined;
    try {
      [focused] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      focused = undefined;
    }
    const previous = trail?.runId === runId ? [...trail.tabIds].reverse() : [];
    const candidates = [focused?.id, ...previous].filter(
      (id, index, all): id is number => id != null && id !== closedTabId && all.indexOf(id) === index,
    );
    for (const candidateId of candidates) {
      if (!(await getRecordableTab(candidateId))) continue;
      const outcome = await moveRun(expectedControlVersion, runId, closedTabId, candidateId);
      if (outcome === 'moved') {
        // The candidate is now the current tab, not a place to come back to.
        forgetTab(candidateId);
        return 'moved';
      }
      if (outcome === 'stale') return 'stale';
    }
    return 'nowhere';
  }

  return { scheduleRecordingFollow, scheduleFollowForLoadedTab, continueAfterRecordedTabClosed };
}


export type FollowMode = ReturnType<typeof createFollowMode>;

import { browser } from 'wxt/browser';
import { pauseMotion } from '../../capture/page-motion';
import { isRegionRectInsideViewport } from '../../capture/region-capture';
import { SNAPSHOT_FREEZE_EVENTS } from '../content-script-constants';
import { findIframeForWindow, snapshotFrameScrollPingType } from '../frame-relay';
import { mountRecordingToolbar, type MountedRecordingToolbar } from '../recording-toolbar-host';
import { createSnapshotSelectionSet } from '../snapshot-selection-set';
import { isMatchingSnapshotViewport } from '../recording-guards';
import { resolveSnapshotTargetAtPoint, type ResolvedSnapshotTarget } from '../snapshot-targeting';
import { snapshotRectKey } from '../snapshot-shield-protocol';
import type {
  SnapshotShieldControlMessage,
  SnapshotShieldPointerDownMessage,
  SnapshotShieldPointerMoveMessage,
  SnapshotShieldPreviewResult,
  SnapshotShieldRegionCaptureMessage,
  SnapshotShieldSelection,
} from '../snapshot-shield-protocol';
import type { ClickCapture, RecordingControlResult, SnapshotInvalidatedMessage } from '../../runtime/messages';
import type { Viewport } from '../../storage/recording-state';
import type { CaptureSender } from './capture-sender';
import type { ContentRecordingSession } from './recording-session';
import type { ToolbarChannel } from './toolbar-channel';

export interface SnapshotRecorderDeps {
  session: ContentRecordingSession;
  capture: CaptureSender;
  toolbar: ToolbarChannel;
  /** False for phase 'preparing-next', where the page stays live and only the
   * floating toolbar is injected. */
  freezePage: boolean;
  /** The exact viewport/DPR baseline this run validates against. Re-reading
   * the window instead would let a scroll between injection and readiness give
   * the background a different baseline than the recorder checks. */
  viewportContract: Viewport;
  devicePixelRatioContract: number;
  initialToolbarState: Parameters<MountedRecordingToolbar['update']>[0];
  /** True when the run was already invalidated before this recorder started. */
  invalidatedAtStart: boolean;
}

/**
 * The snapshot-mode recorder for the top frame: it freezes the page, watches
 * for anything that would shift the frozen pixels, and answers the shield's
 * hover/point/region/control channel. The shield itself is created by the
 * entrypoint after the cleanup spine exists and published on the session.
 */
export function createSnapshotRecorder(deps: SnapshotRecorderDeps) {
  const { session, capture, toolbar, freezePage, viewportContract, devicePixelRatioContract,
    initialToolbarState } = deps;
  let invalidationSent = deps.invalidatedAtStart;
  let interactionsActive = false;
  let dprQuery: MediaQueryList | null = null;
  const selection = createSnapshotSelectionSet();

  const readViewport = (): ClickCapture['viewport'] => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  });
  const notifyInvalidated = (force = false) => {
    if (!freezePage || !interactionsActive || invalidationSent) return;
    const viewport = readViewport();
    if (
      // A child-frame scroll shifts pixels without moving the top viewport,
      // so a forced invalidation must not be masked by a matching contract.
      !force &&
      isMatchingSnapshotViewport(
        viewportContract,
        devicePixelRatioContract,
        viewport,
        window.devicePixelRatio,
      )
    ) {
      return;
    }
    invalidationSent = true;
    interactionsActive = false;
    void browser.runtime.sendMessage({
      type: 'SNAPSHOT_INVALIDATED',
      runId: session.runId,
      viewport,
      devicePixelRatio: window.devicePixelRatio,
    } satisfies SnapshotInvalidatedMessage).catch((error) => {
      console.error('[howbeam] failed to invalidate changed snapshot viewport', error);
    });
  };
  const onDprChange = () => {
    notifyInvalidated();
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', onDprChange);
  };

  const onHover = async (
    point: SnapshotShieldPointerMoveMessage,
  ): Promise<SnapshotShieldPreviewResult> => {
    const shield = session.shield;
    if (!shield || !freezePage || !interactionsActive) return { rect: null };
    const target = await shield.runWithoutShield(() =>
      resolveSnapshotTargetAtPoint(session.runId, point.clientX, point.clientY),
    );
    if (!interactionsActive || !target || selection.isSelected(target)) {
      return { rect: null };
    }
    return { rect: target.rect };
  };

  const onPoint = async (
    point: SnapshotShieldPointerDownMessage,
  ): Promise<SnapshotShieldSelection | null> => {
    const shield = session.shield;
    if (!shield || !freezePage || !interactionsActive) return null;
    const target = await shield.runWithoutShield(() =>
      resolveSnapshotTargetAtPoint(session.runId, point.clientX, point.clientY),
    );
    const now = Date.now();
    if (!interactionsActive || !target) return null;
    if (selection.isSelected(target)) return null;
    const label = await capture.commitSnapshotAnnotation(target.rect, target, 'element', now);
    if (label === null) return null;
    selection.add(target);
    return {
      rect: target.rect,
      label,
    };
  };

  const onRegion = async (
    message: SnapshotShieldRegionCaptureMessage,
  ): Promise<SnapshotShieldSelection | null> => {
    if (!interactionsActive) return null;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (!isRegionRectInsideViewport(message.rect, viewport)) return null;
    if (selection.hasRect(message.rect)) return null;

    const target: ResolvedSnapshotTarget = {
      rect: message.rect,
      identity: `region:${snapshotRectKey(message.rect)}`,
      text: '',
      tagName: 'region',
    };
    const label = await capture.commitSnapshotAnnotation(message.rect, target, 'region', Date.now());
    if (label === null) return null;
    if (!interactionsActive) return null;
    selection.add(target);
    return {
      rect: message.rect,
      label,
    };
  };

  const onControl = async (
    message: SnapshotShieldControlMessage,
  ): Promise<RecordingControlResult> => {
    return toolbar.sendCommand(message.action, message.undoToken);
  };

  /** Undo/restore is DELIBERATELY tracked in three lockstep layers, all moved
   * here by the background's HOWBEAM_SNAPSHOT_HISTORY whichever control asked:
   * this recorder's selection set (dedup of future clicks), the shield
   * channel's committedSelections, and the shield page's overlay stack. All
   * three must pop and push together or duplicate detection and the drawn
   * annotations drift. */
  const applyHistory = (change: 'undo' | 'restore'): void => {
    if (change === 'undo') {
      selection.undoLast();
      session.shield?.undoLast();
    } else {
      selection.restoreUndone();
      session.shield?.restoreUndone();
    }
  };

  /** Installs the snapshot-mode page instrumentation and returns its
   * uninstaller: freeze listeners while a frozen snapshot is being
   * annotated, or the in-page toolbar while the next snapshot is prepared.
   * The input shield itself is created later, after the cleanup spine
   * exists (its failure handler tears the whole recorder down). */
  const install = (): (() => void) => {
    if (!freezePage) {
      // phase === 'preparing-next': the page stays live; only the floating
      // toolbar is injected so the user can create the next snapshot.
      session.toolbar = mountRecordingToolbar(initialToolbarState, {
        onCommand: toolbar.sendCommand,
      });
      // cleanup() owns the toolbar's removal (session.toolbar?.remove()).
      return () => {};
    }

    const onSnapshotFreeze = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onSnapshotScroll = () => notifyInvalidated();
    const onSnapshotResize = () => notifyInvalidated();
    const snapshotScrollPing = snapshotFrameScrollPingType(browser.runtime.id);
    const onSnapshotFramePing = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type !== snapshotScrollPing) return;
      // Only a window that is actually one of this document's iframes may
      // invalidate; page scripts in this frame post with this window as their
      // source and never match.
      if (!findIframeForWindow(event.source)) return;
      notifyInvalidated(true);
    };
    for (const type of SNAPSHOT_FREEZE_EVENTS) {
      window.addEventListener(type, onSnapshotFreeze, { capture: true, passive: false });
    }
    window.addEventListener('scroll', onSnapshotScroll, { capture: true, passive: true });
    window.addEventListener('resize', onSnapshotResize, { passive: true });
    window.addEventListener('message', onSnapshotFramePing);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', onDprChange);
    const releaseMotion = pauseMotion();

    return () => {
      releaseMotion();
      for (const type of SNAPSHOT_FREEZE_EVENTS) {
        window.removeEventListener(type, onSnapshotFreeze, { capture: true });
      }
      window.removeEventListener('scroll', onSnapshotScroll, { capture: true });
      window.removeEventListener('resize', onSnapshotResize);
      window.removeEventListener('message', onSnapshotFramePing);
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = null;
    };
  };
  return {
    install,
    /** The shield's message handlers, in the order createSnapshotShield takes them. */
    handlers: { onPoint, onHover, onControl, onRegion },
    applyHistory,
    /** Selection is armed by the background's SNAPSHOT_ACTIVE handshake and by
     * every recording-phase transition. */
    setInteractionsActive(active: boolean): void {
      interactionsActive = active;
    },
    /** Records that the background already knows this snapshot is stale. */
    markInvalidationSent(): void {
      invalidationSent = true;
    },
    notifyInvalidated,
  };
}

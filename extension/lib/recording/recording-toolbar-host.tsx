import { createRoot, type Root } from 'react-dom/client';
import RecordingToolbar, { type RecordingToolbarState } from './recording-toolbar';
import { OVERLAY_LAYER, releaseTopLayer, showInTopLayer } from '../capture/overlay-layers';
import { REAPPEAR_TRANSITION } from '../capture/capture-presentation';
import { createViewportOverlayHost } from '../capture/viewport-overlay-host';
import type { RecordingControlMessage, RecordingControlResult } from '@/lib/runtime/messages';

type ToolbarAction = RecordingControlMessage['type'];

/** How long a transient notice (e.g. a click that was not recorded) stays up. */
export const TOOLBAR_NOTICE_MS = 6_000;

interface Options {
  onCommand: (action: ToolbarAction, undoToken?: string) => Promise<RecordingControlResult>;
  onUndoApplied?: () => void;
  onRestoreApplied?: () => void;
  onStartRegionCapture?: () => void;
}

export interface MountedRecordingToolbar {
  host: HTMLElement;
  update(state: RecordingToolbarState): void;
  setRegionCaptureActive(active: boolean): void;
  /** Shows a page-side problem on the toolbar; transient notices clear
   * themselves, a persistent one stays until replaced or cleared with null. */
  showNotice(notice: string | null, options?: { persistent?: boolean }): void;
  remove(): void;
}

interface ToolbarSurface {
  host: HTMLElement;
  root: Root;
}

/**
 * One host and one React root per document, reused by every recording run.
 *
 * `createRoot` registers listeners on the document itself (selectionchange and
 * friends) that `root.unmount()` never removes, so a root per run would pin
 * every previous run's fiber tree — and its detached host — for the life of
 * the page. Unmounting only the toolbar tree (render(null)) and detaching the
 * host keeps exactly one root alive however many times recording restarts.
 */
let surface: ToolbarSurface | null = null;
/** Identifies the mount that currently owns the shared surface; a stale
 * handle's update/remove must never touch a newer run's toolbar. */
let ownerToken = 0;

function getSurface(): ToolbarSurface {
  if (surface && surface.host.ownerDocument === document) return surface;
  // A popover so it shares the top layer with the hover frame and the page's
  // own modals; plain z-index would always lose to either.
  const host = createViewportOverlayHost('data-howbeam-recording-toolbar', { 'pointer-events': 'none', transition: REAPPEAR_TRANSITION }, { popover: true });
  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const container = document.createElement('div');
  shadowRoot.append(container);
  surface = { host, root: createRoot(container) };
  return surface;
}

export function mountRecordingToolbar(
  initialState: RecordingToolbarState,
  options: Options,
): MountedRecordingToolbar {
  const { host, root } = getSurface();
  const token = ++ownerToken;
  const owns = () => ownerToken === token;
  let removed = false;
  let currentState = initialState;
  let regionCaptureActive = false;
  let notice: string | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearNoticeTimer = () => {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
  };

  const render = (state: RecordingToolbarState = currentState) => {
    currentState = state;
    if (removed || !owns()) return;
    root.render(
      <RecordingToolbar
        // A fresh tree per run: no command, undo offer or message carries over.
        key={token}
        state={state}
        onCommand={options.onCommand}
        onUndoApplied={options.onUndoApplied}
        onRestoreApplied={options.onRestoreApplied}
        onStartRegionCapture={options.onStartRegionCapture}
        regionCaptureActive={regionCaptureActive}
        notice={notice}
      />,
    );
  };

  document.documentElement.append(host);
  showInTopLayer(host, OVERLAY_LAYER.chrome);
  render(initialState);

  return {
    host,
    update: render,
    setRegionCaptureActive(active) {
      if (removed || regionCaptureActive === active) return;
      regionCaptureActive = active;
      render();
    },
    showNotice(next, { persistent = false } = {}) {
      if (removed) return;
      clearNoticeTimer();
      notice = next;
      if (next !== null && !persistent) {
        noticeTimer = setTimeout(() => {
          noticeTimer = null;
          if (notice !== next) return;
          notice = null;
          render();
        }, TOOLBAR_NOTICE_MS);
      }
      render();
    },
    remove() {
      if (removed) return;
      removed = true;
      clearNoticeTimer();
      if (!owns()) return;
      root.render(null);
      releaseTopLayer(host);
      try {
        if (typeof host.hidePopover === 'function' && host.matches(':popover-open')) host.hidePopover();
      } catch {
        // Detaching the host is sufficient if its popover state changed.
      }
      host.remove();
    },
  };
}

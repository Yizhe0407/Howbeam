import { sendToBackground } from '../runtime/background-client';
import { resolveSnapshotTargetAtPoint } from './snapshot-targeting';
import { installRecorderLifecycle } from './recorder-lifecycle';
import { OVERLAY_LAYER } from '../capture/overlay-layers';
import { mountInPageUi } from '../capture/in-page-ui';
import { createStepPreview } from '../capture/step-preview';
import { isInScrollbarGutter, isPointInAnyScrollGutter } from './recording-guards';
import { getRecordingState } from '../storage/storage';
import type { RecordingState as StoredRecordingState } from '../storage/recording-state';
import { createLatestAsyncRequestRunner } from '../capture/frame-probe';
import type {
  HowbeamRecaptureTargetMessage,
  HowbeamRecordingStateMessage,
  HowbeamStopMessage,
} from '../runtime/messages';
import type { StepRecaptureContext } from '../storage/recording-state';
import { STEP_FOLLOWUP_EVENTS } from './content-script-constants';
import { t } from '@/lib/shared/i18n';
import { addRecorderCleanup, removeRecorderCleanup } from './content/recorder-cleanup';

const RECAPTURE_HINT_STYLES = `
  .hb-recapture-hint {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px);
    gap: 12px; padding: 4px 4px 4px 16px; font-weight: 600; pointer-events: auto;
  }
`;

/** The recapture's hint and cancel, built from the in-page UI kit like the recording toolbar. */
function createRecaptureToolbar(onCancel: () => void): { host: HTMLElement; remove(): void } {
  const ui = mountInPageUi('data-howbeam-recording-toolbar', {
    styles: RECAPTURE_HINT_STYLES,
    // Top layer like the hover preview it must stay above; z-index alone loses to it.
    layer: OVERLAY_LAYER.chrome,
  });
  const hint = document.createElement('div');
  hint.className = 'hb-pill hb-recapture-hint';
  hint.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.textContent = t().recapturePicker.instructions;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'hb-action hb-action--muted';
  cancel.textContent = t().common.cancel;
  cancel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  });
  hint.append(label, cancel);
  ui.layer.append(hint);
  return { host: ui.host, remove: () => ui.remove() };
}

export async function installRecaptureRecorder(context: StepRecaptureContext): Promise<void> {
  const runId = context.runId;
  let active = false;
  let busy = false;
  let removed = false;
  let hoverVersion = 0;
  let lastObservedPhase: string | null = null;

  const preview = createStepPreview();
  // A source page frozen into the back/forward cache must hand its port back
  // cleanly; on restore the recapture is already settled (any navigation fails
  // it), so a stale recorder tears down instead of selecting into a dead run.
  const lifecycle = installRecorderLifecycle({
    isRunCurrent: async () => {
      const state = await getRecordingState();
      return state.operation === 'recapture' && state.recapture?.runId === runId;
    },
    cleanup: () => cleanup(),
    onPush: (message) => {
      const pushed = message as HowbeamStopMessage | HowbeamRecordingStateMessage | null;
      if (pushed?.type === 'HOWBEAM_STOP') cleanup();
      else if (pushed?.type === 'HOWBEAM_RECORDING_STATE') applyState(pushed.state);
    },
  });

  const cancelWorkflow = () => {
    if (removed) return;
    void lifecycle.send({ type: 'CANCEL_STEP_RECAPTURE', runId }).catch((error) => {
      console.error('[howbeam] failed to cancel recapture', error);
    });
  };
  const toolbar = createRecaptureToolbar(cancelWorkflow);

  const hoverProbe = createLatestAsyncRequestRunner(
    async (point: { clientX: number; clientY: number; version: number }) => {
      if (removed || !active || busy) return;
      const target = await resolveSnapshotTargetAtPoint(runId, point.clientX, point.clientY);
      if (removed || !active || busy || point.version !== hoverVersion) return;
      if (target) preview.show(target.rect);
      else preview.hide();
    },
    (error) => {
      if (!removed && active) preview.hide();
      console.warn('[howbeam] failed to preview recapture target', error);
    },
  );

  const onPointerMove = (event: PointerEvent) => {
    if (!active || busy || toolbar.host === event.target || toolbar.host.contains(event.target as Node)) return;
    hoverProbe.submit({
      clientX: event.clientX,
      clientY: event.clientY,
      version: ++hoverVersion,
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if (event.composedPath().includes(toolbar.host)) return;
    if (isInScrollbarGutter(event.clientX, event.clientY, document.documentElement)) return;
    if (isPointInAnyScrollGutter(event.clientX, event.clientY)) return;
    if (!active || busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // This gesture only selects a capture target. It is never replayed into the
    // page, regardless of success, cancellation or screenshot failure.
    event.preventDefault();
    event.stopImmediatePropagation();
    busy = true;
    hoverVersion++;
    hoverProbe.clearPending();
    const clientX = event.clientX;
    const clientY = event.clientY;
    void (async () => {
      const target = await resolveSnapshotTargetAtPoint(runId, clientX, clientY);
      if (!target || removed) {
        busy = false;
        return;
      }
      await preview.prepareForCapture();
      if (removed) return;
      const captureId = crypto.randomUUID();
      const payload: HowbeamRecaptureTargetMessage = {
        type: 'HOWBEAM_RECAPTURE_TARGET',
        runId,
        captureId,
        rect: target.rect,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
        devicePixelRatio: window.devicePixelRatio,
        url: location.href,
        timestamp: Date.now(),
      };
      try {
        const result = await sendToBackground(payload, t().runtime.recaptureResponseInvalid, lifecycle.send);
        if (!result.ok && result.status === 'rejected' && !removed) {
          busy = false;
          preview.show(target.rect);
        }
      } catch (error) {
        console.error('[howbeam] recapture target failed', error);
        cancelWorkflow();
      }
    })();
  };

  const onFollowup = (event: Event) => {
    if (!busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelWorkflow();
  };
  // Set below; a state pushed before that (none can be, as no await comes first) is ignored.
  let applyState = (_state: StoredRecordingState): void => {};
  function cleanup() {
    if (removed) return;
    removed = true;
    active = false;
    hoverProbe.clearPending();
    preview.remove();
    toolbar.remove();
    window.removeEventListener('pointermove', onPointerMove, { capture: true });
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    for (const type of STEP_FOLLOWUP_EVENTS) document.removeEventListener(type, onFollowup, { capture: true });
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    removeRecorderCleanup(cleanup);
    lifecycle.stop();
  }
  /** The run state, as the background pushes it over the connection after every change. */
  applyState = (state: StoredRecordingState) => {
    if (state.operation !== 'recapture' || state.recapture?.runId !== runId) cleanup();
    else {
      const phase = state.recapture.phase;
      const reenteredAwaitingTarget = phase === 'awaiting-target' && lastObservedPhase !== 'awaiting-target';
      lastObservedPhase = phase;
      active = phase === 'awaiting-target';
      if (!active) {
        hoverVersion += 1;
        hoverProbe.clearPending();
        preview.hide();
      } else if (reenteredAwaitingTarget) {
        // The background re-armed target selection (it owns 'failed' and
        // 'cancelled' outcomes, not just 'rejected'): a locally stuck busy
        // flag must never outlive that authoritative transition.
        busy = false;
      }
    }
  };

  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_FOLLOWUP_EVENTS) document.addEventListener(type, onFollowup, { capture: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  addRecorderCleanup(cleanup);

  let ready = false;
  try {
    ready = await sendToBackground(
      {
        type: 'HOWBEAM_RECAPTURE_READY',
        runId,
        url: location.href,
      },
      t().runtime.recaptureResponseInvalid,
      lifecycle.send,
    );
  } catch (error) {
    console.error('[howbeam] recapture readiness check failed', error);
  }
  if (!ready || removed) {
    cleanup();
    return;
  }
  // The durable phase change may land immediately after the ready response.
  // Storage subscription is authoritative; this read closes the tiny gap when
  // the change event fired before the listener was installed.
  const latest = await getRecordingState();
  active =
    latest.operation === 'recapture' &&
    latest.recapture?.runId === runId &&
    latest.recapture.phase === 'awaiting-target';
  if (latest.operation === 'recapture' && latest.recapture?.runId === runId) {
    lastObservedPhase = latest.recapture.phase;
  }
}

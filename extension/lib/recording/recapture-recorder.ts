import { browser } from 'wxt/browser';
import { resolveSnapshotTargetAtPoint } from './snapshot-targeting';
import { installRecorderLifecycle } from './recorder-lifecycle';
import { OVERLAY_LAYER, releaseTopLayer, showInTopLayer } from '../capture/overlay-layers';
import { createStepPreview } from '../capture/step-preview';
import {
  isInScrollbarGutter,
  isPointInAnyScrollGutter,
} from './recording-guards';
import { getRecordingState, onRecordingStateChange } from '../storage/storage';
import { createLatestAsyncRequestRunner } from '../capture/frame-probe';
import {
  isRuntimeBoolean,
  isStepRecaptureTargetResult,
  requireRuntimeMessageResult,
} from '../runtime/runtime-message-result';
import type {
  HowbeamRecaptureTargetMessage,
  HowbeamStopMessage,
  StepRecaptureTargetResult,
} from '../runtime/messages';
import type { StepRecaptureContext } from '../storage/recording-state';
import { CLEANUP_EVENT, STEP_FOLLOWUP_EVENTS } from './content-script-constants';
import { t } from '@/lib/shared/i18n';

function createRecaptureToolbar(onCancel: () => void): { host: HTMLElement; remove(): void } {
  const host = document.createElement('div');
  host.setAttribute('data-howbeam-recording-toolbar', '');
  // Top layer like the hover preview it must stay above; z-index alone loses to it.
  host.setAttribute('popover', 'manual');
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('top', '16px', 'important');
  host.style.setProperty('left', '50%', 'important');
  host.style.setProperty('transform', 'translateX(-50%)', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  const root = host.attachShadow({ mode: 'closed' });
  const wrapper = document.createElement('div');
  wrapper.setAttribute('role', 'status');
  wrapper.style.cssText = [
    'all:initial',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'padding:10px 12px',
    'border:1px solid rgba(255,255,255,.18)',
    'border-radius:8px',
    'background:#111827',
    'box-shadow:0 12px 32px rgba(0,0,0,.35)',
    'color:#f9fafb',
    'font:600 14px/1.3 system-ui,sans-serif',
  ].join(';');
  const label = document.createElement('span');
  label.textContent = t().recapturePicker.instructions;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t().common.cancel;
  cancel.style.cssText = [
    'all:initial',
    'cursor:pointer',
    'padding:7px 10px',
    'border-radius:8px',
    'background:#374151',
    'color:#fff',
    'font:600 14px/1 system-ui,sans-serif',
  ].join(';');
  cancel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  });
  wrapper.append(label, cancel);
  root.append(wrapper);
  document.documentElement.append(host);
  showInTopLayer(host, OVERLAY_LAYER.chrome);
  return {
    host,
    remove: () => {
      releaseTopLayer(host);
      host.remove();
    },
  };
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
  });

  const cancelWorkflow = () => {
    if (removed) return;
    void browser.runtime.sendMessage({ type: 'CANCEL_STEP_RECAPTURE', runId }).catch((error) => {
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
        const result = requireRuntimeMessageResult<StepRecaptureTargetResult>(
          await browser.runtime.sendMessage(payload),
          isStepRecaptureTargetResult,
          t().runtime.recaptureResponseInvalid,
        );
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
  let unsubscribe = () => {};
  const onStop = (message: HowbeamStopMessage) => {
    if (message?.type === 'HOWBEAM_STOP') cleanup();
  };
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
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onStop);
    unsubscribe();
    lifecycle.stop();
  }
  unsubscribe = onRecordingStateChange((state) => {
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
  });

  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_FOLLOWUP_EVENTS) document.addEventListener(type, onFollowup, { capture: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onStop);

  let ready = false;
  try {
    ready = requireRuntimeMessageResult(
      await browser.runtime.sendMessage({
        type: 'HOWBEAM_RECAPTURE_READY',
        runId,
        url: location.href,
      }),
      isRuntimeBoolean,
      t().runtime.recaptureResponseInvalid,
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
  active = latest.operation === 'recapture' && latest.recapture?.runId === runId && latest.recapture.phase === 'awaiting-target';
  if (latest.operation === 'recapture' && latest.recapture?.runId === runId) {
    lastObservedPhase = latest.recapture.phase;
  }
}

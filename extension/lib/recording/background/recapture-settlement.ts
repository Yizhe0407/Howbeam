import { browser } from 'wxt/browser';
import { getRecordingState } from '../../storage/storage';
import type { StepRecaptureResult } from '../../storage/recording-state';
import { t } from '@/lib/shared/i18n';
import { cancelCapture } from './capture-registry';
import { isRecaptureSourceTabIntact, wasRecaptureCommitted } from './recapture-target';
import type { ControlPlane } from './control-plane';
import type { RecorderRuntime } from './recorder-runtime';

export interface RecaptureSettlementDeps {
  control: ControlPlane;
  runtime: RecorderRuntime;
  openEditor(target: { sessionId: string; entryId: string }): Promise<unknown>;
}

/**
 * How a recapture ends: the result is published, the source tab released and
 * the editor shown again. Owns the id of the one capture in flight, which a
 * failure cancels and every settlement clears.
 */
export function createRecaptureSettlement(deps: RecaptureSettlementDeps) {
  const { control, runtime } = deps;
  let activeCaptureId: string | null = null;

  async function settle(
    runId: string,
    status: StepRecaptureResult['status'],
    version: number,
    errorCode?: string,
    message?: string,
  ): Promise<boolean> {
    const settled = await control.writeStateIf(
      version,
      (current) => current.operation === 'recapture' && current.recapture?.runId === runId,
      (current) => {
        const recapture = current.recapture!;
        const result: StepRecaptureResult = {
          runId,
          status,
          sessionId: recapture.sessionId,
          entryId: recapture.entryId,
          ...(errorCode ? { errorCode } : {}),
          ...(message ? { message } : {}),
          completedAt: Date.now(),
        };
        // Not resetRunStateToIdle: settling a recapture deliberately leaves the
        // run-scoped counters it never owned (itemCount &c.) untouched — state
        // normalization already governs how they read outside a recording run.
        return {
          ...current,
          operation: null,
          isRecording: false,
          phase: 'idle',
          tabId: null,
          runId: null,
          recapture: null,
          recaptureResult: result,
          error: status === 'failed' ? message ?? t().recaptureFlow.failed : null,
          recoverableError: null,
        };
      },
    );
    if (!settled) return false;
    const context = settled.previous.recapture!;
    activeCaptureId = null;
    await runtime.stopRecorderInTab(context.sourceTabId);
    if (context.sourceTabCreated) {
      await browser.tabs.remove(context.sourceTabId).catch((error) => {
        console.warn('[stepmark] failed to close temporary recapture tab', error);
      });
    }
    try {
      // Back to the single editor tab, at the entry this recapture worked on.
      await deps.openEditor({ sessionId: context.sessionId, entryId: context.entryId });
    } catch (error) {
      console.error('[stepmark] failed to return to editor after recapture', error);
    }
    return true;
  }

  function fail(
    runId: string,
    errorCode: string,
    message: string,
    expectedControlVersion: number,
  ): Promise<boolean> {
    if (expectedControlVersion !== control.controlVersion) return Promise.resolve(false);
    if (activeCaptureId) cancelCapture(activeCaptureId);
    const version = control.claimControl({ cancelRecaptureGate: true });
    return settle(runId, 'failed', version, errorCode, message);
  }

  /**
   * MV3 may terminate the service worker between capture and durable result
   * handoff. A persisted capture marker lets startup distinguish a committed
   * replacement from abandoned in-flight work instead of leaving the editor
   * permanently locked in recapture mode.
   */
  async function recoverInterrupted(): Promise<void> {
    const state = await getRecordingState();
    const context = state.recapture;
    if (state.operation !== 'recapture' || !context) return;

    if (context.phase === 'awaiting-target') {
      // Selection mode survives ordinary worker restarts — the injected recorder
      // lives on in the source tab. A browser restart, however, reissues tab
      // ids: the persisted sourceTabId then names nothing or an unrelated page,
      // and the claimed single-owner slot would block every future operation.
      if (await isRecaptureSourceTabIntact(context)) return;
      const version = control.claimControl({});
      await settle(
        context.runId,
        'failed',
        version,
        'SOURCE_TAB_CLOSED',
        t().recaptureFlow.sourceTabChanged,
      );
      return;
    }

    const committed = context.phase === 'capturing' && await wasRecaptureCommitted(context);
    const version = control.claimControl({});
    if (committed) {
      await settle(context.runId, 'replaced', version);
      return;
    }
    await settle(
      context.runId,
      'failed',
      version,
      'WORKER_RESTARTED',
      t().recaptureFlow.interrupted,
    );
  }

  return {
    settle,
    fail,
    recoverInterrupted,
    activeCaptureId: () => activeCaptureId,
    trackCapture(captureId: string): void {
      activeCaptureId = captureId;
    },
    releaseCapture(captureId: string): void {
      if (activeCaptureId === captureId) activeCaptureId = null;
    },
  };
}

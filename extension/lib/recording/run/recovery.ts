import { isRecordableTabUrl } from '../../shared/restricted-urls';
import { isSuperseded, type RunActor } from './actor';
import type { Lifecycle } from './lifecycle';
import type { Navigation } from './navigation';
import type { RunPorts } from './ports';
import type { Recording } from './state';
import { liveRecording, notice, waiting, withRecording } from './transitions';

type Assessment =
  | { kind: 'intact' }
  | { kind: 'tab-missing' }
  | { kind: 'ended'; code: string; copy: 'runtime.recordingTabClosed' | 'background.snapshotAnchorLost' | 'background.injectFailed' }
  | { kind: 'unrecordable'; reason: Exclude<Recording['wait'], null> };

/**
 * A restarted worker finds the run its predecessor left. A worker restart
 * keeps the recorder alive in its tab, but a browser restart reissues tab
 * ids: a run that can no longer prove it is in its own tab ends, keeping
 * what it recorded.
 */
export function createRecovery(deps: {
  actor: RunActor;
  ports: RunPorts;
  lifecycle: Lifecycle;
  navigation: Navigation;
  /** Discards every pending snapshot base image but this one. */
  discardPendingAnchorsExcept(keep: string | null): Promise<unknown>;
}) {
  const { actor, ports, lifecycle, navigation } = deps;

  async function assess(recording: Recording): Promise<Assessment> {
    // Startup was cut off: no operation is left to finish it.
    if (recording.phase === 'starting') return { kind: 'ended', code: 'RECORDING_STOPPED', copy: 'background.injectFailed' };
    let url: string | undefined;
    try {
      url = (await ports.tabs.get(recording.tabId)).url;
    } catch {
      return { kind: 'tab-missing' };
    }
    if (recording.mode === 'steps') {
      // Steps runs may navigate; one stopped on a page it cannot record simply waits.
      const reason = await navigation.unrecordableReason(url);
      return reason ? { kind: 'unrecordable', reason } : { kind: 'intact' };
    }
    const tabGone = { kind: 'ended', code: 'RECORDED_TAB_CLOSED', copy: 'runtime.recordingTabClosed' } as const;
    if (!isRecordableTabUrl(url)) return tabGone;
    const annotating = recording.phase === 'recording' || recording.phase === 'finishing';
    const anchorMissing = { kind: 'ended', code: 'SNAPSHOT_ANCHOR_MISSING', copy: 'background.snapshotAnchorLost' } as const;
    if (annotating && !recording.anchor) return anchorMissing;
    if (recording.anchor) {
      const anchor = await ports.steps.get(recording.anchor.id);
      if (annotating && !anchor?.screenshotBlob) return anchorMissing;
      // Snapshot coordinates belong to one document: any other URL invalidates them.
      if (anchor && url !== anchor.url) return tabGone;
    }
    return { kind: 'intact' };
  }

  async function recoverInterruptedRecording(): Promise<void> {
    await actor.ready();
    const op = actor.state().operation;
    // Only the live run's snapshot may still be waiting for its first annotation.
    await deps.discardPendingAnchorsExcept(op.kind === 'recording' ? op.anchor?.id ?? null : null).catch((error) => {
      console.error('[howbeam] failed to discard leftover snapshot images:', error);
    });
    if (op.kind !== 'recording') return;
    const assessment = await assess(op);
    if (assessment.kind === 'intact') return;
    if (assessment.kind === 'tab-missing') {
      // As a live tabs.onRemoved would: the run may carry on in another tab. Not awaited, like that listener.
      void lifecycle.recordedTabGone(op.tabId);
      return;
    }
    await actor.run(async (ctx) => {
      const recording = liveRecording(ctx.state(), op.runId);
      if (!recording) return;
      if (assessment.kind === 'unrecordable') {
        await ctx.commit((state) => withRecording(state, waiting(recording, assessment.reason)));
        return;
      }
      await lifecycle.endWithError(ctx, recording, notice(assessment.code, assessment.copy));
    }).catch((error) => {
      if (!isSuperseded(error)) throw error;
    });
  }

  return { recoverInterruptedRecording };
}

import { describe, expect, it } from 'vitest';
import { fromRecordingState, idleState, toRecordingState, type RunState } from '@/lib/recording/run/state';
import { normalizeRecordingState } from '@/lib/storage/storage';
import { makeRecordingState } from '../../setup/recording-state';
import type { RecordingState } from '@/lib/storage/recording-state';

const recording = makeRecordingState({
  operation: 'recording',
  isRecording: true,
  phase: 'recording',
  sessionId: 'project-1',
  tabId: 4,
  runId: 'run-1',
  mode: 'snapshot',
  itemCount: 2,
  runItemCount: 5,
  lastCommittedCaptureId: 'capture-9',
  groupAnchorId: 'anchor-1',
  snapshotViewport: { width: 1280, height: 720, scrollX: 0, scrollY: 40 },
  snapshotDevicePixelRatio: 2,
  newProject: true,
  targetProjectTitle: null,
  insertAfterStepId: 'step-3',
});

/** What the current background writes, read back through the same normalization the storage reader applies. */
function roundTrip(state: RecordingState): RecordingState {
  return toRecordingState(fromRecordingState(normalizeRecordingState(state)));
}

describe('run state <-> persisted recording state', () => {
  it.each<[string, RecordingState]>([
    ['idle', makeRecordingState()],
    ['a live snapshot run', recording],
    [
      'a paused steps run in a continuation',
      {
        ...recording,
        mode: 'steps',
        phase: 'paused',
        groupAnchorId: null,
        snapshotViewport: null,
        snapshotDevicePixelRatio: null,
        newProject: false,
        targetProjectTitle: '既有專案',
      },
    ],
    [
      'a run on hold in a browser page',
      {
        ...recording,
        mode: 'steps',
        groupAnchorId: null,
        snapshotViewport: null,
        snapshotDevicePixelRatio: null,
        error: 'background.waitingRestrictedPage',
        recoverableError: { code: 'RECORDING_WAITING_RESTRICTED_PAGE', copy: 'background.waitingRestrictedPage' },
      },
    ],
    [
      'a run showing a capture error',
      {
        ...recording,
        error: 'background.captureFailed',
        recoverableError: { code: 'CAPTURE_FAILED', copy: 'background.captureFailed' },
      },
    ],
    [
      'a run that ended on an error',
      makeRecordingState({
        phase: 'error',
        sessionId: 'project-1',
        mode: 'snapshot',
        error: 'runtime.recordingTabClosed',
        recoverableError: { code: 'RECORDED_TAB_CLOSED', copy: 'runtime.recordingTabClosed' },
      }),
    ],
    [
      'a failed recapture waiting for the editor',
      makeRecordingState({
        sessionId: 'project-1',
        error: 'recaptureFlow.failed',
        recaptureResult: {
          runId: 'r',
          status: 'failed',
          sessionId: 'project-1',
          entryId: 'e',
          copy: 'recaptureFlow.failed',
          completedAt: 5,
        },
      }),
    ],
    [
      'a recapture waiting for its target',
      makeRecordingState({
        operation: 'recapture',
        sessionId: 'project-1',
        recapture: {
          runId: 'r',
          sessionId: 'project-1',
          target: { kind: 'single', stepId: 's' },
          entryId: 's',
          phase: 'awaiting-target',
          sourceTabId: 7,
          sourceWindowId: 1,
          sourceUrl: 'https://example.com/',
          sourceTabCreated: true,
          startedAt: 1,
        },
      }),
    ],
  ])('keeps %s unchanged', (_name, state) => {
    const normalized = normalizeRecordingState(state);
    expect(roundTrip(normalized)).toEqual(normalized);
  });

  it('reads a run whose identity is incomplete as idle', () => {
    const run = fromRecordingState(normalizeRecordingState({ ...recording, tabId: null }));
    expect(run.operation.kind).toBe('idle');
  });

  it('starts idle', () => {
    expect(toRecordingState(idleState())).toEqual(makeRecordingState());
  });

  it('shows a wait notice only while no error is shown', () => {
    const state = fromRecordingState(
      normalizeRecordingState({
        ...recording,
        error: 'background.waitingSiteAccess',
        recoverableError: { code: 'RECORDING_WAITING_SITE_ACCESS', copy: 'background.waitingSiteAccess' },
      }),
    ) as RunState & { operation: { kind: 'recording' } };
    expect(state.operation).toMatchObject({ wait: 'site-access', notice: null });
    const withError = {
      ...state,
      operation: { ...state.operation, notice: { code: 'CAPTURE_FAILED', copy: 'background.captureFailed' as const } },
    };
    expect(toRecordingState(withError)).toMatchObject({ error: 'background.captureFailed' });
  });
});

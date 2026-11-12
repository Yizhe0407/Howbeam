import { describe, expect, it } from 'vitest';
import {
  captureCommitted,
  captureUndone,
  editorOpenFailed,
  ended,
  endedWithError,
  notice,
  preparingNextSnapshot,
  recordingLive,
  startFailed,
  startingRun,
  stopped,
  switchedToSnapshot,
  waiting,
  withNotice,
} from '@/lib/recording/run/transitions';
import { idleState, toRecordingState, type RunState } from '@/lib/recording/run/state';

const run = startingRun({
  runId: 'run-1',
  sessionId: 'project-1',
  tabId: 4,
  mode: 'snapshot',
  newProject: true,
  targetProjectTitle: null,
  insertAfterStepId: null,
});
const anchor = { id: 'anchor-1', viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 }, devicePixelRatio: 1 };
const live = captureCommitted(captureCommitted(recordingLive(run, anchor), 'c1'), 'c2');
const state: RunState = { ...idleState(), operation: live };

describe('run transitions', () => {
  it('counts captures and clears a notice once one succeeds', () => {
    const failed = withNotice(live, notice('CAPTURE_FAILED', 'background.captureFailed'));
    expect(captureCommitted(failed, 'c3')).toMatchObject({
      itemCount: 3,
      runItemCount: 3,
      lastCommittedCaptureId: 'c3',
      notice: null,
    });
    expect(captureUndone(captureUndone(captureUndone(live)))).toMatchObject({ itemCount: 0, runItemCount: 0 });
  });

  it('numbers a new snapshot from one but keeps the run total', () => {
    expect(preparingNextSnapshot(live)).toMatchObject({
      phase: 'preparing-next',
      itemCount: 0,
      runItemCount: 2,
      anchor: null,
    });
    expect(switchedToSnapshot({ ...live, mode: 'steps' })).toMatchObject({ mode: 'snapshot', phase: 'preparing-next' });
  });

  it('keeps a paused run paused while it waits', () => {
    expect(waiting({ ...live, phase: 'paused' }, 'restricted-page')).toMatchObject({
      phase: 'paused',
      wait: 'restricted-page',
    });
  });

  it('ends a run back to idle, keeping its Project, mode and last committed capture', () => {
    expect(toRecordingState(ended(state, live))).toEqual({
      ...toRecordingState(idleState()),
      sessionId: 'project-1',
      mode: 'snapshot',
      lastCommittedCaptureId: 'c2',
    });
  });

  it('keeps the notice on STOP, and the Project and counters on an error stop', () => {
    const shown = notice('CAPTURE_FAILED', 'background.captureFailed');
    expect(stopped(state, withNotice(live, shown)).operation).toMatchObject({
      kind: 'idle',
      notice: shown,
      failed: false,
    });
    const tabClosed = notice('RECORDED_TAB_CLOSED', 'runtime.recordingTabClosed');
    expect(toRecordingState(endedWithError(state, live, tabClosed))).toMatchObject({
      phase: 'error',
      sessionId: 'project-1',
      itemCount: 2,
      error: 'runtime.recordingTabClosed',
      recoverableError: { code: 'RECORDED_TAB_CLOSED' },
      newProject: false,
    });
  });

  it('marks a failed start, and a failed editor open after a finish', () => {
    expect(
      toRecordingState(startFailed(idleState(), null, 'snapshot', notice('NO_ACTIVE_TAB', 'background.noActiveTab'))),
    ).toMatchObject({ phase: 'error', mode: 'snapshot', recoverableError: { code: 'NO_ACTIVE_TAB' } });
    expect(toRecordingState(editorOpenFailed(ended(state, live)))).toMatchObject({
      phase: 'error',
      recoverableError: { code: 'EDITOR_OPEN_FAILED' },
    });
  });
});

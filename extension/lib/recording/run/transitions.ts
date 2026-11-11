import type { CopyKey } from '../../shared/i18n/copy';
import type { RecordingMode } from '../../storage/recording-state';
import type { Idle, Notice, Recording, RunState, SnapshotAnchor, WaitReason } from './state';

/**
 * Every way the run state changes, as pure functions. The flows decide when;
 * these decide what the state becomes, so each rule is written once.
 */

export interface NewRun {
  runId: string;
  sessionId: string;
  tabId: number;
  mode: RecordingMode;
  newProject: boolean;
  targetProjectTitle: string | null;
  insertAfterStepId: string | null;
}

export function notice(code: string, copy: CopyKey): Notice {
  return { code, copy };
}

/** A run whose recorder is being injected. */
export function startingRun(run: NewRun): Recording {
  return {
    kind: 'recording',
    ...run,
    phase: 'starting',
    itemCount: 0,
    runItemCount: 0,
    lastCommittedCaptureId: null,
    anchor: null,
    wait: null,
    notice: null,
  };
}

/** The recorder is live (and for a snapshot, its base image is captured): clicks count from here. */
export function recordingLive(recording: Recording, anchor: SnapshotAnchor | null = recording.anchor): Recording {
  return { ...recording, phase: 'recording', anchor, notice: null };
}

export function paused(recording: Recording): Recording {
  return { ...recording, phase: 'paused' };
}

export function resumed(recording: Recording): Recording {
  return { ...recording, phase: 'recording' };
}

export function finishing(recording: Recording): Recording {
  return { ...recording, phase: 'finishing' };
}

export function captureCommitted(recording: Recording, captureId: string): Recording {
  return {
    ...recording,
    itemCount: recording.itemCount + 1,
    runItemCount: recording.runItemCount + 1,
    lastCommittedCaptureId: captureId,
    notice: null,
  };
}

export function captureUndone(recording: Recording): Recording {
  return {
    ...recording,
    itemCount: Math.max(0, recording.itemCount - 1),
    runItemCount: Math.max(0, recording.runItemCount - 1),
    notice: null,
  };
}

export function captureRestored(recording: Recording): Recording {
  return { ...recording, itemCount: recording.itemCount + 1, runItemCount: recording.runItemCount + 1, notice: null };
}

/** Tells the user something went wrong; the run carries on. */
export function withNotice(recording: Recording, shown: Notice): Recording {
  return { ...recording, notice: shown };
}

/** On hold in a page the recorder cannot run on; the phase is kept (a paused run stays paused). */
export function waiting(recording: Recording, reason: WaitReason): Recording {
  return { ...recording, wait: reason, notice: null };
}

export function waitLifted(recording: Recording): Recording {
  return recording.wait ? { ...recording, wait: null } : recording;
}

/** The run now lives in another tab; a wait belonged to the page it left. */
export function movedToTab(recording: Recording, tabId: number): Recording {
  return { ...recording, tabId, wait: null };
}

/** The snapshot's page no longer matches its base image: further annotations would land on the wrong pixels. */
export function snapshotInvalidated(recording: Recording): Recording {
  return {
    ...recording,
    phase: 'invalidated',
    notice: notice('SNAPSHOT_VIEWPORT_CHANGED', 'background.snapshotViewportChanged'),
  };
}

/** Between snapshots: nothing captured yet, the user picks the page to capture. */
export function preparingNextSnapshot(recording: Recording): Recording {
  return { ...recording, phase: 'preparing-next', itemCount: 0, anchor: null, notice: null };
}

/** A fresh snapshot (or a rebuilt one) is being captured. */
export function capturingSnapshot(recording: Recording): Recording {
  return { ...recording, phase: 'starting', itemCount: 0, anchor: null, notice: null };
}

export function switchedToSnapshot(recording: Recording): Recording {
  return { ...preparingNextSnapshot(recording), mode: 'snapshot' };
}

export function switchingToSteps(recording: Recording): Recording {
  return { ...recording, mode: 'steps', phase: 'starting', itemCount: 0, anchor: null, notice: null };
}

function idle(recording: Recording, fields: Partial<Idle>): Idle {
  return {
    kind: 'idle',
    sessionId: recording.sessionId,
    mode: recording.mode,
    failed: false,
    notice: null,
    itemCount: 0,
    runItemCount: 0,
    lastCommittedCaptureId: recording.lastCommittedCaptureId,
    ...fields,
  };
}

/** A run that finished or was discarded: nothing left to show. */
export function ended(state: RunState, recording: Recording): RunState {
  return { ...state, operation: idle(recording, {}) };
}

/** STOP keeps whatever notice the run was showing. */
export function stopped(state: RunState, recording: Recording): RunState {
  return { ...state, operation: idle(recording, { notice: recording.notice }) };
}

/**
 * A run that ended on an error. The Project is kept (never reclaimed) so the
 * popup's recovery can still open it; the counters stay for the popup.
 */
export function endedWithError(state: RunState, recording: Recording, shown: Notice): RunState {
  return {
    ...state,
    operation: idle(recording, {
      failed: true,
      notice: shown,
      itemCount: recording.itemCount,
      runItemCount: recording.runItemCount,
    }),
  };
}

/** A start that failed before the run went live. */
export function startFailed(state: RunState, sessionId: string | null, mode: RecordingMode, shown: Notice): RunState {
  const previous = state.operation;
  return {
    ...state,
    operation: {
      kind: 'idle',
      sessionId: sessionId ?? (previous.kind === 'idle' ? previous.sessionId : null),
      mode,
      failed: true,
      notice: shown,
      itemCount: 0,
      runItemCount: 0,
      lastCommittedCaptureId: previous.kind === 'idle' ? previous.lastCommittedCaptureId : null,
    },
  };
}

/** The editor could not be opened after a run finished: the popup offers to retry. */
export function editorOpenFailed(state: RunState): RunState {
  if (state.operation.kind !== 'idle') return state;
  return {
    ...state,
    operation: {
      ...state.operation,
      failed: true,
      notice: notice('EDITOR_OPEN_FAILED', 'runtime.editorOpenAfterRecordingFailed'),
    },
  };
}

const EDITOR_RECOVERY_CODES = new Set(['RECORDED_TAB_CLOSED', 'EDITOR_OPEN_FAILED']);

/** The ended run left the popup a "finish and open editor" recovery. */
export function needsEditorRecovery(state: RunState): boolean {
  const op = state.operation;
  return op.kind === 'idle' && op.notice?.code != null && EDITOR_RECOVERY_CODES.has(op.notice.code);
}

/** The editor opened the Project the recovery was for: nothing left to recover. */
export function editorRecovered(state: RunState): RunState {
  if (!needsEditorRecovery(state) || state.operation.kind !== 'idle') return state;
  return { ...state, operation: { ...state.operation, failed: false, notice: null } };
}

export function withRecording(state: RunState, recording: Recording): RunState {
  return { ...state, operation: recording };
}

/** The live recording with this run id, if it is still the one running. */
export function liveRecording(state: RunState, runId: string): Recording | null {
  return state.operation.kind === 'recording' && state.operation.runId === runId ? state.operation : null;
}

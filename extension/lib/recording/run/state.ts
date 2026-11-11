import type { CopyKey } from '../../shared/i18n/copy';
import type {
  RecordingMode,
  RecordingState,
  StepRecaptureContext,
  StepRecaptureResult,
  Viewport,
} from '../../storage/recording-state';

/** What the user is told about the run: why it stopped, waits, or failed a step. */
export interface Notice {
  /** Machine-readable reason, for UI that offers a specific recovery; null for a plain notice. */
  code: string | null;
  copy: CopyKey;
}

/** Why a steps run is on hold in a page it cannot record. */
export type WaitReason = 'restricted-page' | 'site-access' | 'page-failed' | 'follow-failed';

export const WAIT_NOTICES: Readonly<Record<WaitReason, Notice>> = {
  'restricted-page': { code: 'RECORDING_WAITING_RESTRICTED_PAGE', copy: 'background.waitingRestrictedPage' },
  'site-access': { code: 'RECORDING_WAITING_SITE_ACCESS', copy: 'background.waitingSiteAccess' },
  'page-failed': { code: 'RECORDING_WAITING_PAGE_FAILED', copy: 'background.errorPageFailedToLoad' },
  'follow-failed': { code: 'RECORDING_WAITING_FOLLOW_FAILED', copy: 'background.waitingFollowFailed' },
};

/** The snapshot's captured base image, which every annotation is drawn on. */
export interface SnapshotAnchor {
  id: string;
  /** The viewport the base image was taken at; annotations must match it. Null when unknown. */
  viewport: Viewport | null;
  devicePixelRatio: number | null;
}

export type RecordingPhase =
  | 'starting'
  | 'recording'
  | 'paused'
  | 'preparing-next'
  | 'invalidated'
  | 'finishing';

export interface Recording {
  kind: 'recording';
  runId: string;
  sessionId: string;
  tabId: number;
  mode: RecordingMode;
  phase: RecordingPhase;
  /** Markers numbered in the current snapshot, or steps since the last mode switch. */
  itemCount: number;
  /** Everything this run recorded, across modes and snapshots. */
  runItemCount: number;
  lastCommittedCaptureId: string | null;
  anchor: SnapshotAnchor | null;
  /** The run records into a Project of its own, created with its first stored capture. */
  newProject: boolean;
  /** Existing Project the run appends to, shown in the toolbar; null for a new one. */
  targetProjectTitle: string | null;
  insertAfterStepId: string | null;
  wait: WaitReason | null;
  notice: Notice | null;
}

export interface Recapture {
  kind: 'recapture';
  context: StepRecaptureContext;
}

export interface Idle {
  kind: 'idle';
  /** The Project the UI last worked on; kept so an ended run's editor recovery can find it. */
  sessionId: string | null;
  mode: RecordingMode;
  /** The run ended on an error the user still has to see. */
  failed: boolean;
  notice: Notice | null;
  /** Counters the popup keeps showing after a run ends. */
  itemCount: number;
  runItemCount: number;
  /** Lets a recorder whose capture answer was lost check whether it was committed. */
  lastCommittedCaptureId: string | null;
}

export type Operation = Idle | Recording | Recapture;

/** Everything the background persists: the operation, and a recapture result
 * waiting for the editor to acknowledge it, which outlives its operation. */
export interface RunState {
  operation: Operation;
  recaptureResult: StepRecaptureResult | null;
}

export function idleState(): RunState {
  return {
    operation: {
      kind: 'idle',
      sessionId: null,
      mode: 'steps',
      failed: false,
      notice: null,
      itemCount: 0,
      runItemCount: 0,
      lastCommittedCaptureId: null,
    },
    recaptureResult: null,
  };
}

/** The notice a run shows: an error first, else why it waits. */
export function visibleNotice(recording: Recording): Notice | null {
  return recording.notice ?? (recording.wait ? WAIT_NOTICES[recording.wait] : null);
}

function noticeFields(notice: Notice | null): Pick<RecordingState, 'error' | 'recoverableError'> {
  return {
    error: notice?.copy ?? null,
    recoverableError: notice?.code ? { code: notice.code, copy: notice.copy } : null,
  };
}

const NO_RUN = {
  tabId: null,
  runId: null,
  lastCommittedCaptureId: null,
  groupAnchorId: null,
  newProject: false,
  targetProjectTitle: null,
  insertAfterStepId: null,
  snapshotViewport: null,
  snapshotDevicePixelRatio: null,
} as const;

/** The persisted and UI-facing shape. */
export function toRecordingState(state: RunState): RecordingState {
  const { operation, recaptureResult } = state;
  if (operation.kind === 'recording') {
    return {
      operation: 'recording',
      isRecording: true,
      phase: operation.phase,
      sessionId: operation.sessionId,
      tabId: operation.tabId,
      ...noticeFields(visibleNotice(operation)),
      mode: operation.mode,
      itemCount: operation.itemCount,
      runItemCount: operation.runItemCount,
      lastCommittedCaptureId: operation.lastCommittedCaptureId,
      groupAnchorId: operation.anchor?.id ?? null,
      runId: operation.runId,
      newProject: operation.newProject,
      targetProjectTitle: operation.targetProjectTitle,
      insertAfterStepId: operation.insertAfterStepId,
      snapshotViewport: operation.anchor?.viewport ?? null,
      snapshotDevicePixelRatio: operation.anchor?.devicePixelRatio ?? null,
      recapture: null,
      recaptureResult,
    };
  }
  if (operation.kind === 'recapture') {
    return {
      ...NO_RUN,
      operation: 'recapture',
      isRecording: false,
      phase: 'idle',
      sessionId: operation.context.sessionId,
      error: null,
      recoverableError: null,
      mode: 'steps',
      itemCount: 0,
      runItemCount: 0,
      recapture: operation.context,
      recaptureResult,
    };
  }
  return {
    ...NO_RUN,
    operation: null,
    isRecording: false,
    phase: operation.failed ? 'error' : 'idle',
    sessionId: operation.sessionId,
    ...noticeFields(operation.notice),
    mode: operation.mode,
    itemCount: operation.itemCount,
    runItemCount: operation.runItemCount,
    lastCommittedCaptureId: operation.lastCommittedCaptureId,
    recapture: null,
    recaptureResult,
  };
}

const WAIT_BY_CODE = new Map(
  (Object.entries(WAIT_NOTICES) as [WaitReason, Notice][]).map(([reason, notice]) => [notice.code, reason]),
);

/** Rebuilds the state a restarted worker left behind (already normalized by storage). */
export function fromRecordingState(stored: RecordingState): RunState {
  const notice: Notice | null = stored.recoverableError
    ? { code: stored.recoverableError.code, copy: stored.recoverableError.copy }
    : stored.error
      ? { code: null, copy: stored.error }
      : null;
  const { recaptureResult } = stored;
  if (stored.operation === 'recapture' && stored.recapture) {
    return { operation: { kind: 'recapture', context: stored.recapture }, recaptureResult };
  }
  if (
    stored.operation === 'recording' &&
    stored.isRecording &&
    stored.runId &&
    stored.sessionId &&
    stored.tabId != null &&
    stored.phase !== 'idle' &&
    stored.phase !== 'error'
  ) {
    const wait = notice?.code ? WAIT_BY_CODE.get(notice.code) ?? null : null;
    const anchor = stored.groupAnchorId
      ? { id: stored.groupAnchorId, viewport: stored.snapshotViewport, devicePixelRatio: stored.snapshotDevicePixelRatio }
      : null;
    return {
      operation: {
        kind: 'recording',
        runId: stored.runId,
        sessionId: stored.sessionId,
        tabId: stored.tabId,
        mode: stored.mode,
        phase: stored.phase,
        itemCount: stored.itemCount,
        runItemCount: stored.runItemCount,
        lastCommittedCaptureId: stored.lastCommittedCaptureId,
        anchor,
        newProject: stored.newProject,
        targetProjectTitle: stored.targetProjectTitle,
        insertAfterStepId: stored.insertAfterStepId,
        wait,
        notice: wait ? null : notice,
      },
      recaptureResult,
    };
  }
  return {
    operation: {
      kind: 'idle',
      sessionId: stored.sessionId,
      mode: stored.mode,
      failed: stored.phase === 'error',
      notice,
      itemCount: stored.itemCount,
      runItemCount: stored.runItemCount,
      lastCommittedCaptureId: stored.lastCommittedCaptureId,
    },
    recaptureResult,
  };
}

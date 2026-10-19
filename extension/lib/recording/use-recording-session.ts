import { useCallback, useEffect, useRef, useState } from 'react';
import { getRecordingState, onRecordingStateChange } from '../storage/storage';
import { createDefaultRecordingState } from '../storage/recording-state';
import { getSteps } from '../storage/step-repository';
import { type Step } from '../storage/models';
import { t } from '@/lib/shared/i18n';


/** Exported so tests assert the reconciliation contract, not a magic number. */
export const RECORDING_RECONCILE_INTERVAL_MS = 5_000;

function boundsMatch(
  first: Step['bounds'] | Step['manualBounds'],
  second: Step['bounds'] | Step['manualBounds'],
): boolean {
  return (
    first === second ||
    (first != null &&
      second != null &&
      first.x === second.x &&
      first.y === second.y &&
      first.width === second.width &&
      first.height === second.height)
  );
}

function redactionsMatch(first: Step['redactions'], second: Step['redactions']): boolean {
  if (first === second) return true;
  if (!first || !second || first.length !== second.length) return false;
  return first.every((redaction, index) => {
    const other = second[index];
    return (
      redaction.id === other.id &&
      redaction.kind === other.kind &&
      boundsMatch(redaction.bounds, other.bounds)
    );
  });
}

function imageEditsMatch(first: Step['imageEdits'], second: Step['imageEdits']): boolean {
  if (first === second) return true;
  if (!first || !second || first.length !== second.length) return false;
  // Edits are small plain data; structural comparison keeps this correct as new edit kinds gain fields.
  return JSON.stringify(first) === JSON.stringify(second);
}

/** IndexedDB returns a fresh Blob wrapper on every read. Keep the existing
 * wrapper only while captureRevision is unchanged; recapture deliberately
 * increments that revision so every image consumer receives the replacement. */
export function reconcileSteps(previous: Step[], next: Step[]): Step[] {
  const previousById = new Map(previous.map((step) => [step.id, step]));
  const reconciled = next.map((step) => {
    const previousStep = previousById.get(step.id);
    if (!previousStep) return step;
    const metadataMatch =
      previousStep.sessionId === step.sessionId &&
      previousStep.order === step.order &&
      boundsMatch(previousStep.bounds, step.bounds) &&
      boundsMatch(previousStep.manualBounds, step.manualBounds) &&
      redactionsMatch(previousStep.redactions, step.redactions) &&
      imageEditsMatch(previousStep.imageEdits, step.imageEdits) &&
      boundsMatch(previousStep.crop, step.crop) &&
      previousStep.redactionReviewRequired === step.redactionReviewRequired &&
      previousStep.devicePixelRatio === step.devicePixelRatio &&
      previousStep.screenshotScale === step.screenshotScale &&
      previousStep.description === step.description &&
      previousStep.url === step.url &&
      previousStep.timestamp === step.timestamp &&
      previousStep.groupId === step.groupId &&
      previousStep.numbered === step.numbered &&
      (previousStep.captureRevision ?? 0) === (step.captureRevision ?? 0) &&
      (previousStep.imageEditRevision ?? 0) === (step.imageEditRevision ?? 0) &&
      previousStep.lastCaptureRunId === step.lastCaptureRunId &&
      Boolean(previousStep.screenshotBlob) === Boolean(step.screenshotBlob);
    if (metadataMatch) return previousStep;
    if (!step.screenshotBlob || !previousStep.screenshotBlob) return step;
    if ((previousStep.captureRevision ?? 0) !== (step.captureRevision ?? 0)) return step;
    return { ...step, screenshotBlob: previousStep.screenshotBlob };
  });
  return reconciled.length === previous.length && reconciled.every((step, index) => step === previous[index])
    ? previous
    : reconciled;
}

export interface UseRecordingSessionOptions {
  /**
   * `false` keeps this hook to lightweight RecordingState reads: step rows —
   * and their screenshot Blobs — are never fetched, and the periodic
   * reconciliation timer never runs. State-only consumers (the popup) must
   * not pay for a full IndexedDB read on every state change. Defaults to
   * `true`; not designed to toggle across renders.
   */
  withSteps?: boolean;
}

/** Shared popup/editor state: current recording status, steps, and any error.
 * Omitting explicitSessionId follows the active recording (popup behavior).
 * Passing a string pins the data source to that Project; passing null explicitly
 * means the editor URL has no Project and must not fall back to unrelated global state. */
export function useRecordingSession(
  explicitSessionId?: string | null,
  { withSteps = true }: UseRecordingSessionOptions = {},
) {
  const [recordingState, setRecordingState] = useState(createDefaultRecordingState);
  const [steps, setSteps] = useState<Step[]>([]);
  const [dataError, setDataError] = useState<string | null>(null);
  const latestStepsRequest = useRef(0);
  const stepsRefreshInFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const hasExplicitSession = explicitSessionId !== undefined;
  const explicitProjectSessionId =
    typeof explicitSessionId === 'string' && explicitSessionId.length > 0
      ? explicitSessionId
      : null;
  const explicitSessionIdRef = useRef(explicitProjectSessionId);
  const hasExplicitSessionRef = useRef(hasExplicitSession);
  const sessionId = hasExplicitSession ? explicitProjectSessionId : recordingState.sessionId;
  const effectiveSessionIdRef = useRef(sessionId);

  // These mirrors exist so the long-lived storage subscription below can read
  // the current data source without resubscribing. They are committed in an
  // effect rather than during render: a discarded concurrent render must not
  // leave the subscription pointing at a session that was never displayed.
  // Storage callbacks are delivered as tasks, so they always observe the
  // committed value.
  useEffect(() => {
    explicitSessionIdRef.current = explicitProjectSessionId;
    hasExplicitSessionRef.current = hasExplicitSession;
    effectiveSessionIdRef.current = sessionId;
  });

  /** Invalidates every in-flight steps read so its late result is discarded. */
  const invalidatePendingStepsReads = useCallback(() => {
    latestStepsRequest.current++;
  }, []);

  const refreshSteps = useCallback((sid: string | null): Promise<void> => {
    if (!withSteps) return Promise.resolve();
    const request = ++latestStepsRequest.current;
    // Not `const`: when `sid` is null the async body reaches its `finally`
    // synchronously, before the initializer returns, so a const binding would
    // still be in its temporal dead zone there.
    let operation!: Promise<void>;
    // eslint-disable-next-line prefer-const
    operation = (async () => {
      try {
        const nextSteps = sid ? await getSteps(sid) : [];
        if (mounted.current && request === latestStepsRequest.current) {
          setSteps((previous) => reconcileSteps(previous, nextSteps));
          setDataError(null);
        }
      } catch (error) {
        if (mounted.current && request === latestStepsRequest.current) {
          setDataError(t().runtime.recordingDataUnreadable);
        }
        throw error;
      } finally {
        if (stepsRefreshInFlight.current === operation) stepsRefreshInFlight.current = null;
      }
    })();
    stepsRefreshInFlight.current = operation;
    return operation;
  }, [withSteps]);

  const refreshStepsSafely = useCallback(async (sid: string | null) => {
    try {
      await refreshSteps(sid);
    } catch (error) {
      console.error('[howbeam] failed to refresh recording steps', error);
    }
  }, [refreshSteps]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let stateVersion = 0;

    const applyState = (
      state: Awaited<ReturnType<typeof getRecordingState>>,
      refreshUnchangedSession: boolean,
    ) => {
      if (disposed) return;
      const nextSessionId = hasExplicitSessionRef.current
        ? explicitSessionIdRef.current
        : state.sessionId;
      const sessionChanged = effectiveSessionIdRef.current !== nextSessionId;
      effectiveSessionIdRef.current = nextSessionId;
      setRecordingState(state);
      // A same-session state change can signal an IndexedDB write (notably a
      // completed recapture). A changed data source is refreshed by the
      // sessionId effect below, avoiding two concurrent full IndexedDB reads.
      if (refreshUnchangedSession && !sessionChanged) {
        void refreshStepsSafely(nextSessionId);
      }
    };

    const initialVersion = stateVersion;
    void getRecordingState()
      .then((state) => {
        // A storage change can arrive while the initial read is pending. Its
        // newer state wins even if the older read resolves last.
        if (stateVersion === initialVersion) applyState(state, false);
      })
      .catch((error) => {
        if (disposed) return;
        console.error('[howbeam] failed to read recording state', error);
        setDataError(t().runtime.recordingStateUnreadable);
      });

    const unsubscribe = onRecordingStateChange((state) => {
      stateVersion++;
      applyState(state, true);
    });

    return () => {
      disposed = true;
      mounted.current = false;
      invalidatePendingStepsReads();
      unsubscribe();
    };
  }, [invalidatePendingStepsReads, refreshStepsSafely]);

  // The editor may supply its URL session as the authoritative data source.
  // Keeping this separate from RecordingState lets an editor continue showing
  // Project A while a global operation belongs to Project B.
  useEffect(() => {
    void refreshStepsSafely(sessionId);
  }, [refreshStepsSafely, sessionId]);

  // Live updates during a recording are event-driven: the background commits
  // the step to IndexedDB and only then bumps the run's itemCount, so the
  // storage-change subscription above always fires *after* the write is
  // durable and refreshes this session. This timer is a slow reconciliation
  // net for any capture path that mutates steps without touching recording
  // state — it is not the primary update mechanism, so it must stay
  // infrequent: every tick re-reads every step, screenshot blobs included.
  useEffect(() => {
    if (
      !withSteps ||
      !recordingState.isRecording ||
      !sessionId ||
      recordingState.sessionId !== sessionId
    ) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reconcile = async () => {
      const activeRefresh = stepsRefreshInFlight.current;
      if (activeRefresh) {
        try {
          await activeRefresh;
        } catch {
          // The owner of the active refresh already records and logs failure.
        }
      } else {
        await refreshStepsSafely(sessionId);
      }
      if (!disposed) timer = setTimeout(() => void reconcile(), RECORDING_RECONCILE_INTERVAL_MS);
    };
    timer = setTimeout(() => void reconcile(), RECORDING_RECONCILE_INTERVAL_MS);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [recordingState.isRecording, recordingState.sessionId, refreshStepsSafely, sessionId, withSteps]);

  return {
    ...recordingState,
    sessionId,
    recording: recordingState,
    steps,
    dataError,
    refresh: () => refreshSteps(sessionId),
  };
}

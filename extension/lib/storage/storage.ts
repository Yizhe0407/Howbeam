import { browser, type Browser } from 'wxt/browser';
import { isBoundedString, isFiniteWithin, isSafeId } from '../shared/validation';
import { PERSISTED_STEP_LIMITS } from './persistence-limits';
import {
  RECAPTURE_PHASES,
  RECORDING_PHASES,
  RECORDING_STATE_KEY,
  STEP_RECAPTURE_RESULT_STATUSES,
  createDefaultRecordingState,
  type RecoverableRecordingError,
  type RecordingState,
  type StepRecaptureContext,
  type StepRecaptureResult,
  type StepRecaptureTarget,
} from './recording-state';

const DEFAULT_STATE: RecordingState = createDefaultRecordingState();

/**
 * Ends the current run by returning every run-scoped field to its idle
 * default while preserving durable, non-run state: sessionId (the Project the
 * UI still targets), mode, and the recapture handoff fields
 * (recapture/recaptureResult), which have their own lifecycle. This is the
 * clean-stop shape; error stops differ deliberately (phase 'error' plus a
 * message) and must keep hand-writing their fields.
 */
export function resetRunStateToIdle(current: RecordingState): RecordingState {
  return {
    ...current,
    operation: null,
    isRecording: false,
    phase: 'idle',
    tabId: null,
    error: null,
    recoverableError: null,
    itemCount: 0,
    runItemCount: 0,
    groupAnchorId: null,
    runId: null,
    autoCreatedProjectId: null,
    targetProjectTitle: null,
    insertAfterStepId: null,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
  };
}

const MAX_STATE_ID_LENGTH = PERSISTED_STEP_LIMITS.maxIdLength;
const MAX_STATE_VALUE_LENGTH = 512;
const MAX_STATE_MESSAGE_LENGTH = 10_000;
const MAX_VIEWPORT_MAGNITUDE = 10_000_000;
const MAX_DEVICE_PIXEL_RATIO = 32;

// Accept lists derived from the canonical const arrays so a newly added
// phase/status can never silently normalize a stored run back to idle.
const VALID_RECORDING_PHASES: ReadonlySet<unknown> = new Set(RECORDING_PHASES);
const VALID_RECAPTURE_PHASES: ReadonlySet<unknown> = new Set(RECAPTURE_PHASES);
const VALID_RECAPTURE_RESULT_STATUSES: ReadonlySet<unknown> = new Set(STEP_RECAPTURE_RESULT_STATUSES);

function normalizeNullableString(value: unknown, maximumLength = MAX_STATE_VALUE_LENGTH): string | null {
  return isBoundedString(value, maximumLength) ? value : null;
}

function normalizeSourceUrl(value: unknown): string | null {
  if (!isBoundedString(value, 8_192) || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function normalizeRecoverableError(value: unknown): RecoverableRecordingError | null {
  if (!value || typeof value !== 'object') return null;
  const error = value as Partial<RecoverableRecordingError>;
  if (!isBoundedString(error.code, MAX_STATE_VALUE_LENGTH) || !isBoundedString(error.message, MAX_STATE_MESSAGE_LENGTH)) return null;
  return { code: error.code, message: error.message };
}

function normalizeViewport(value: unknown): RecordingState['snapshotViewport'] {
  if (!value || typeof value !== 'object') return null;
  const viewport = value as Record<string, unknown>;
  const finiteWithinLimit = (candidate: unknown) =>
    isFiniteWithin(candidate, -MAX_VIEWPORT_MAGNITUDE, MAX_VIEWPORT_MAGNITUDE);
  if (
    !finiteWithinLimit(viewport.width) ||
    !finiteWithinLimit(viewport.height) ||
    !finiteWithinLimit(viewport.scrollX) ||
    !finiteWithinLimit(viewport.scrollY) ||
    (viewport.width as number) <= 0 ||
    (viewport.height as number) <= 0
  ) {
    return null;
  }
  return {
    width: viewport.width as number,
    height: viewport.height as number,
    scrollX: viewport.scrollX as number,
    scrollY: viewport.scrollY as number,
  };
}

function normalizeRecaptureTarget(value: unknown): StepRecaptureTarget | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Partial<StepRecaptureTarget> & Record<string, unknown>;
  if (target.kind === 'single' && isBoundedString(target.stepId, MAX_STATE_ID_LENGTH)) {
    return { kind: 'single', stepId: target.stepId };
  }
  if (
    target.kind === 'snapshot-singleton' &&
    isBoundedString(target.anchorId, MAX_STATE_ID_LENGTH) &&
    isBoundedString(target.annotationId, MAX_STATE_ID_LENGTH) &&
    target.anchorId !== target.annotationId
  ) {
    return {
      kind: 'snapshot-singleton',
      anchorId: target.anchorId,
      annotationId: target.annotationId,
    };
  }
  return null;
}

function normalizeRecaptureContext(value: unknown): StepRecaptureContext | null {
  if (!value || typeof value !== 'object') return null;
  const context = value as Partial<StepRecaptureContext>;
  const target = normalizeRecaptureTarget(context.target);
  if (
    !target ||
    !isBoundedString(context.runId, MAX_STATE_ID_LENGTH) ||
    !isBoundedString(context.sessionId, MAX_STATE_ID_LENGTH) ||
    !isBoundedString(context.entryId, MAX_STATE_ID_LENGTH) ||
    !VALID_RECAPTURE_PHASES.has(context.phase) ||
    !isSafeId(context.sourceTabId) ||
    !isSafeId(context.sourceWindowId) ||
    !normalizeSourceUrl(context.sourceUrl) ||
    typeof context.sourceTabCreated !== 'boolean' ||
    !isSafeId(context.startedAt)
  ) {
    return null;
  }
  return {
    runId: context.runId,
    sessionId: context.sessionId,
    target,
    entryId: context.entryId,
    phase: context.phase as StepRecaptureContext['phase'],
    sourceTabId: context.sourceTabId!,
    sourceWindowId: context.sourceWindowId!,
    sourceUrl: normalizeSourceUrl(context.sourceUrl)!,
    sourceTabCreated: context.sourceTabCreated,
    startedAt: context.startedAt!,
  };
}

function normalizeRecaptureResult(value: unknown): StepRecaptureResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Partial<StepRecaptureResult>;
  if (
    !isBoundedString(result.runId, MAX_STATE_ID_LENGTH) ||
    !VALID_RECAPTURE_RESULT_STATUSES.has(result.status) ||
    !isBoundedString(result.sessionId, MAX_STATE_ID_LENGTH) ||
    !isBoundedString(result.entryId, MAX_STATE_ID_LENGTH) ||
    !isSafeId(result.completedAt) ||
    (result.errorCode !== undefined && !isBoundedString(result.errorCode, MAX_STATE_VALUE_LENGTH)) ||
    (result.message !== undefined && !isBoundedString(result.message, MAX_STATE_MESSAGE_LENGTH))
  ) {
    return null;
  }
  return {
    runId: result.runId,
    status: result.status as StepRecaptureResult['status'],
    sessionId: result.sessionId,
    entryId: result.entryId,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.message ? { message: result.message } : {}),
    completedAt: result.completedAt!,
  };
}

export function normalizeRecordingState(stored: Partial<RecordingState> | undefined): RecordingState {
  const raw = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {};
  const mode = raw.mode === 'steps' || raw.mode === 'snapshot' ? raw.mode : DEFAULT_STATE.mode;
  const requestedRecording = raw.operation === 'recording' || (raw.operation == null && raw.isRecording === true);
  const requestedRecapture = raw.operation === 'recapture';
  const recapture = normalizeRecaptureContext(raw.recapture);
  const sessionId = normalizeNullableString(raw.sessionId, MAX_STATE_ID_LENGTH);
  const tabId = isSafeId(raw.tabId) ? raw.tabId : null;
  const runId = normalizeNullableString(raw.runId, MAX_STATE_ID_LENGTH);
  const hasValidItemCount =
    raw.itemCount == null ||
    (Number.isSafeInteger(raw.itemCount) && (raw.itemCount as number) >= 0 &&
      (raw.itemCount as number) <= PERSISTED_STEP_LIMITS.maxStepsPerProject);
  const hasCompleteRecordingIdentity =
    raw.isRecording === true && sessionId !== null && tabId !== null && runId !== null && hasValidItemCount;
  const operation = requestedRecapture
    ? recapture
      ? 'recapture'
      : null
    : requestedRecording && hasCompleteRecordingIdentity
      ? 'recording'
      : null;
  const isRecording = operation === 'recording' && raw.isRecording === true;
  const candidatePhase = VALID_RECORDING_PHASES.has(raw.phase)
    ? raw.phase as RecordingState['phase']
    : isRecording
      ? 'recording'
      : 'idle';
  const phase = operation === 'recording' ? candidatePhase : candidatePhase === 'error' ? 'error' : 'idle';
  const snapshotViewport = normalizeViewport(raw.snapshotViewport);
  const snapshotDevicePixelRatio =
    typeof raw.snapshotDevicePixelRatio === 'number' &&
    Number.isFinite(raw.snapshotDevicePixelRatio) &&
    raw.snapshotDevicePixelRatio > 0 &&
    raw.snapshotDevicePixelRatio <= MAX_DEVICE_PIXEL_RATIO
      ? raw.snapshotDevicePixelRatio
      : null;

  return {
    operation,
    isRecording,
    phase,
    sessionId: operation === 'recapture' ? recapture!.sessionId : sessionId,
    tabId: operation === 'recording' ? tabId : null,
    error: normalizeNullableString(raw.error, MAX_STATE_MESSAGE_LENGTH),
    recoverableError: normalizeRecoverableError(raw.recoverableError),
    mode,
    itemCount:
      Number.isSafeInteger(raw.itemCount) &&
      (raw.itemCount as number) >= 0 &&
      (raw.itemCount as number) <= PERSISTED_STEP_LIMITS.maxStepsPerProject
        ? raw.itemCount as number
        : 0,
    runItemCount:
      Number.isSafeInteger(raw.runItemCount) &&
      (raw.runItemCount as number) >= 0 &&
      (raw.runItemCount as number) <= PERSISTED_STEP_LIMITS.maxStepsPerProject
        ? raw.runItemCount as number
        : 0,
    lastCommittedCaptureId:
      operation === 'recording' ? normalizeNullableString(raw.lastCommittedCaptureId, MAX_STATE_ID_LENGTH) : null,
    groupAnchorId:
      operation === 'recording' && mode === 'snapshot'
        ? normalizeNullableString(raw.groupAnchorId, MAX_STATE_ID_LENGTH)
        : null,
    runId: operation === 'recording' ? runId : null,
    // Meaningful only while its run is alive: once the run ends (including
    // error stops, whose recovery flow must keep the project), the reclaim
    // window is over and the flag must not leak into a later run.
    autoCreatedProjectId:
      operation === 'recording'
        ? normalizeNullableString(raw.autoCreatedProjectId, MAX_STATE_ID_LENGTH)
        : null,
    targetProjectTitle:
      operation === 'recording' ? normalizeNullableString(raw.targetProjectTitle, MAX_STATE_VALUE_LENGTH) : null,
    insertAfterStepId:
      operation === 'recording' ? normalizeNullableString(raw.insertAfterStepId, MAX_STATE_ID_LENGTH) : null,
    snapshotViewport: operation === 'recording' && mode === 'snapshot' ? snapshotViewport : null,
    snapshotDevicePixelRatio: operation === 'recording' && mode === 'snapshot' ? snapshotDevicePixelRatio : null,
    recapture: operation === 'recapture' ? recapture : null,
    recaptureResult: normalizeRecaptureResult(raw.recaptureResult),
  };
}

/** UI-only Project selection. RecordingState remains the durable owner of an
 * active capture transaction and must never be rewritten merely to navigate. */
export const ACTIVE_PROJECT_ID_KEY = 'howbeam:activeProjectId';

function normalizeActiveProjectId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

// Serializes same-context selection mutations so a compare-and-clear cannot
// remove a selection queued after it. browser.storage has no cross-context
// compare-and-swap primitive, so callers should always use these helpers.
let activeProjectMutation: Promise<void> = Promise.resolve();

function queueActiveProjectMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = activeProjectMutation.then(mutation, mutation);
  activeProjectMutation = result.then(() => undefined, () => undefined);
  return result;
}

export async function getActiveProjectId(): Promise<string | null> {
  const result = await browser.storage.local.get(ACTIVE_PROJECT_ID_KEY);
  return normalizeActiveProjectId(result[ACTIVE_PROJECT_ID_KEY]);
}

export function setActiveProjectId(projectId: string): Promise<void> {
  const normalized = normalizeActiveProjectId(projectId);
  if (!normalized) return Promise.reject(new TypeError('Project id must be a non-empty string.'));
  return queueActiveProjectMutation(async () => {
    await browser.storage.local.set({ [ACTIVE_PROJECT_ID_KEY]: normalized });
  });
}

/** Removes the UI selection only if it still points at expectedProjectId.
 * Returns false when another selection has already won the race. */
export function clearActiveProjectId(expectedProjectId: string): Promise<boolean> {
  const expected = normalizeActiveProjectId(expectedProjectId);
  if (!expected) return Promise.reject(new TypeError('Expected Project id must be a non-empty string.'));
  return queueActiveProjectMutation(async () => {
    const current = await getActiveProjectId();
    if (current !== expected) return false;
    await browser.storage.local.remove(ACTIVE_PROJECT_ID_KEY);
    return true;
  });
}

export async function getRecordingState(): Promise<RecordingState> {
  const result = await browser.storage.local.get(RECORDING_STATE_KEY);
  return normalizeRecordingState(result[RECORDING_STATE_KEY] as Partial<RecordingState> | undefined);
}

export async function setRecordingState(state: RecordingState): Promise<void> {
  await browser.storage.local.set({ [RECORDING_STATE_KEY]: state });
}

/** Subscribes to recording-state changes; returns an unsubscribe function. */
export function onRecordingStateChange(callback: (state: RecordingState) => void): () => void {
  const listener = (changes: Record<string, Browser.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') return;
    const change = changes[RECORDING_STATE_KEY];
    if (change) callback(normalizeRecordingState(change.newValue as Partial<RecordingState> | undefined));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

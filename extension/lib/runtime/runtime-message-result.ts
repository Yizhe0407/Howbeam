import type {
  CancelStepRecaptureResult,
  ClickCaptureResult,
  EditorHandoffResult,
  FocusStepRecaptureSourceResult,
  OpenEditorResult,
  OpenLibraryResult,
  PreflightProjectContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  RecordingControlResult,
  StartRecordingResult,
  StartStepRecaptureResult,
  StepRecaptureTargetResult,
} from './messages';
// Error-code arrays live beside their result types in messages.ts so the
// guard can never drift from the declared unions.
import {
  CONTINUATION_PREFLIGHT_ERROR_CODES,
  RECAPTURE_PREFLIGHT_ERROR_CODES,
  RECAPTURE_START_ERROR_CODES,
} from './messages';
import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';
import { isBoundedString, isRecord } from '../shared/validation';
import { t } from '@/lib/shared/i18n';

export type RuntimeMessageResultGuard<T> = (value: unknown) => value is T;

const RUNTIME_ERROR_LIMIT = 4_096;
const RUNTIME_PERMISSION_PATTERN_LIMIT = 8_192;
const MAX_PROJECT_ITEMS = PERSISTED_STEP_LIMITS.maxStepsPerProject;

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isId(value: unknown): value is string {
  return isBoundedString(value, PERSISTED_STEP_LIMITS.maxIdLength);
}

function isErrorMessage(value: unknown): value is string {
  return isBoundedString(value, RUNTIME_ERROR_LIMIT);
}

function isOptionalErrorMessage(value: unknown): value is string | undefined {
  return value === undefined || isErrorMessage(value);
}

function isSafeNonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function isSourcePermissionPreflightSuccess(
  value: Record<string, unknown>,
): boolean {
  return (
    value.ok === true &&
    hasOnlyKeys(value, ['ok', 'sourceUrl', 'sourceOrigin', 'permissionPattern']) &&
    isBoundedString(value.sourceUrl, PERSISTED_STEP_LIMITS.maxUrlLength) &&
    isBoundedString(value.sourceOrigin, PERSISTED_STEP_LIMITS.maxUrlLength) &&
    isBoundedString(value.permissionPattern, RUNTIME_PERMISSION_PATTERN_LIMIT)
  );
}

/** The shared `{ ok: false, error }` failure envelope, with no extra keys. */
function isFailureResult(value: Record<string, unknown>): value is { ok: false; error: string } {
  return value.ok === false && hasOnlyKeys(value, ['ok', 'error']) && isErrorMessage(value.error);
}

export function isStartRecordingResult(value: unknown): value is StartRecordingResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return hasOnlyKeys(value, ['ok', 'sessionId', 'runId']) && isId(value.sessionId) && isId(value.runId);
  }
  return isFailureResult(value);
}

export function isOpenEditorResult(value: unknown): value is OpenEditorResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return hasOnlyKeys(value, ['ok']);
  return isFailureResult(value);
}

export function isOpenLibraryResult(value: unknown): value is OpenLibraryResult {
  return isOpenEditorResult(value);
}

/**
 * The editor page's answer to a handoff. An unshaped or absent reply is exactly
 * what the background must be able to distinguish from consent, because a
 * discarded or reloading tab answers nothing at all.
 */
export function isEditorHandoffResult(value: unknown): value is EditorHandoffResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return hasOnlyKeys(value, ['ok', 'ready']) && typeof value.ready === 'boolean';
  return isFailureResult(value);
}

function isFinishResult(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'entryId', 'itemCount'])) return false;
  return (
    isId(value.sessionId) &&
    (value.entryId === null || isId(value.entryId)) &&
    isSafeNonNegativeInteger(value.itemCount, MAX_PROJECT_ITEMS)
  );
}

export function isRecordingControlResult(value: unknown): value is RecordingControlResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return isFailureResult(value);
  return (
    value.ok === true &&
    hasOnlyKeys(value, ['ok', 'undoToken', 'removedItemNumber', 'finish']) &&
    (value.undoToken === undefined || isId(value.undoToken)) &&
    (value.removedItemNumber === undefined ||
      (Number.isSafeInteger(value.removedItemNumber) &&
        (value.removedItemNumber as number) > 0 &&
        (value.removedItemNumber as number) <= MAX_PROJECT_ITEMS)) &&
    (value.finish === undefined || isFinishResult(value.finish))
  );
}


/** Both preflights share one success shape and differ only in the error codes
 * they may report, so the validator is parameterized by that code set. */
function isSourcePermissionPreflightResult(
  value: unknown,
  codes: readonly string[],
): boolean {
  if (!isRecord(value)) return false;
  if (value.ok === true) return isSourcePermissionPreflightSuccess(value);
  return (
    value.ok === false &&
    hasOnlyKeys(value, ['ok', 'code', 'message']) &&
    isOneOf(value.code, codes) &&
    isErrorMessage(value.message)
  );
}

export function isPreflightStepRecaptureSourcePermissionResult(
  value: unknown,
): value is PreflightStepRecaptureSourcePermissionResult {
  return isSourcePermissionPreflightResult(value, RECAPTURE_PREFLIGHT_ERROR_CODES);
}

export function isPreflightProjectContinuationSourcePermissionResult(
  value: unknown,
): value is PreflightProjectContinuationSourcePermissionResult {
  return isSourcePermissionPreflightResult(value, CONTINUATION_PREFLIGHT_ERROR_CODES);
}

export function isStartStepRecaptureResult(value: unknown): value is StartStepRecaptureResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return (
      hasOnlyKeys(value, ['ok', 'runId', 'tabId', 'reusedTab']) &&
      isId(value.runId) &&
      isSafeNonNegativeInteger(value.tabId) &&
      typeof value.reusedTab === 'boolean'
    );
  }
  return (
    value.ok === false &&
    hasOnlyKeys(value, ['ok', 'code', 'error']) &&
    isOneOf(value.code, RECAPTURE_START_ERROR_CODES) &&
    isErrorMessage(value.error)
  );
}

export function isFocusStepRecaptureSourceResult(value: unknown): value is FocusStepRecaptureSourceResult {
  return isOpenEditorResult(value);
}

export function isCancelStepRecaptureResult(value: unknown): value is CancelStepRecaptureResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return (
      hasOnlyKeys(value, ['ok', 'status']) &&
      isOneOf(value.status, ['cancelled', 'already-completed'] as const)
    );
  }
  return isFailureResult(value);
}

export function isClickCaptureResult(value: unknown): value is ClickCaptureResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return hasOnlyKeys(value, ['ok']);
  return value.ok === false
    && hasOnlyKeys(value, ['ok', 'error', 'reported'])
    && isErrorMessage(value.error)
    && (value.reported === undefined || value.reported === true);
}

export function isStepRecaptureTargetResult(value: unknown): value is StepRecaptureTargetResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return hasOnlyKeys(value, ['ok', 'status']) && value.status === 'replaced';
  }
  return (
    value.ok === false &&
    hasOnlyKeys(value, ['ok', 'status', 'error']) &&
    isOneOf(value.status, ['rejected', 'cancelled', 'failed'] as const) &&
    isOptionalErrorMessage(value.error)
  );
}

export function isRuntimeBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Runtime responses cross an extension-context boundary and can be absent or
 * stale during reload/navigation. Requiring a contract-specific guard keeps a
 * merely truthy `ok` property from turning malformed data into trusted state.
 */
export function requireRuntimeMessageResult<T>(
  value: unknown,
  guard: RuntimeMessageResultGuard<T>,
  unavailableMessage?: string,
): T {
  if (!guard(value)) throw new Error(unavailableMessage ?? t().runtime.backgroundUnavailable);
  return value;
}

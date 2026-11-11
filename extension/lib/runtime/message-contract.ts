/**
 * The one place a background message is described: what its payload must
 * look like, who may send it, what it answers, and what it answers when its
 * handler fails. The request type guard, the extension-page gate, the
 * background's failure replies and the typed client (background-client.ts)
 * are all read from BACKGROUND_CONTRACTS, so they cannot drift apart.
 */
import {
  STEP_FRAME_LIMITS,
  type BackgroundMessage,
  type BackgroundMessageType,
  type BackgroundResponse,
  type ClickCapture,
  type RecordingControlMessage,
} from './messages';
import {
  isCancelStepRecaptureResult,
  isClickCaptureResult,
  isFocusStepRecaptureSourceResult,
  isOpenEditorResult,
  isOpenLibraryResult,
  isPreflightProjectContinuationSourcePermissionResult,
  isPreflightStepRecaptureSourcePermissionResult,
  isRecordingControlResult,
  isRuntimeBoolean,
  isRuntimeVoid,
  isStartRecordingResult,
  isStartStepRecaptureResult,
  isStepFrameRelayBeginResult,
  isStepFrameRelayClaimResult,
  isStepFrameRelayMutationResult,
  isStepRecaptureTargetResult,
} from './runtime-message-result';
import { t } from '../shared/i18n';
import type { StepRecaptureTarget } from '../storage/recording-state';
import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';
import {
  isBoundedString,
  isFiniteRect,
  isFiniteWithin as isFiniteWithinRange,
  isRecord,
  isSafeId,
} from '../shared/validation';

const MAX_ID_LENGTH = PERSISTED_STEP_LIMITS.maxIdLength;
const MAX_URL_LENGTH = 8_192;
const MAX_TEXT_LENGTH = 10_000;
const MAX_COORDINATE_MAGNITUDE = 10_000_000;
const MAX_DEVICE_PIXEL_RATIO = 32;

function isString(value: unknown, maximumLength: number = MAX_ID_LENGTH): value is string {
  return isBoundedString(value, maximumLength);
}

function isOptionalString(value: unknown, maximumLength: number = MAX_ID_LENGTH): value is string | undefined {
  return value === undefined || isString(value, maximumLength);
}

const isBrowserId = isSafeId;
const isTimestamp = isSafeId;

function isFiniteWithin(value: unknown, maximumMagnitude = MAX_COORDINATE_MAGNITUDE): value is number {
  return isFiniteWithinRange(value, -maximumMagnitude, maximumMagnitude);
}

function isDevicePixelRatio(value: unknown): value is number {
  return isFiniteWithin(value, MAX_DEVICE_PIXEL_RATIO) && value > 0;
}

function isViewport(value: unknown): value is ClickCapture['viewport'] {
  if (!isRecord(value)) return false;
  return (
    isFiniteWithin(value.width) && value.width > 0 &&
    isFiniteWithin(value.height) && value.height > 0 &&
    isFiniteWithin(value.scrollX) &&
    isFiniteWithin(value.scrollY)
  );
}

function isRect(value: unknown): value is ClickCapture['rect'] {
  return isFiniteRect(value, { maxMagnitude: MAX_COORDINATE_MAGNITUDE });
}

function isHttpUrl(value: unknown): value is string {
  if (!isString(value, MAX_URL_LENGTH) || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isTarget(value: unknown): value is StepRecaptureTarget {
  if (!isRecord(value)) return false;
  if (value.kind === 'single') return isString(value.stepId);
  return (
    value.kind === 'snapshot-singleton' &&
    isString(value.anchorId) &&
    isString(value.annotationId) &&
    value.anchorId !== value.annotationId
  );
}

function isContinuation(value: unknown): value is { preferredTabId?: number } | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).every((key) => key === 'preferredTabId') &&
    (value.preferredTabId === undefined || isBrowserId(value.preferredTabId))
  );
}


/**
 * `extension-pages`: only Howbeam's own pages (popup, editor, library), checked
 * before routing. `handler-checked`: content scripts too; the handler binds the
 * sender to the live run or recapture, which only it can read.
 */
export type MessageSenders = 'extension-pages' | 'handler-checked';

export interface MessageContract<K extends BackgroundMessageType> {
  senders: MessageSenders;
  /** Checks the payload (every field but `type`); messages cross a trust boundary whatever their TypeScript type. */
  isRequest(value: Record<string, unknown>): boolean;
  isResponse(value: unknown): value is BackgroundResponse<K>;
  /** What the sender gets when the handler throws. */
  failure(): BackgroundResponse<K>;
}

function isRunId(value: Record<string, unknown>): boolean {
  return isString(value.runId);
}

function isRecordingControl(value: Record<string, unknown>): boolean {
  return isString(value.runId) && isOptionalString(value.undoToken);
}

const recordingControl = {
  senders: 'handler-checked',
  isRequest: isRecordingControl,
  isResponse: isRecordingControlResult,
  failure: () => ({ ok: false, error: t().background.recordingServiceFailed }),
} satisfies MessageContract<RecordingControlMessage['type']>;

const relayMutation = {
  isResponse: isStepFrameRelayMutationResult,
  failure: () => ({ ok: false }),
} as const;

export const BACKGROUND_CONTRACTS: { [K in BackgroundMessageType]: MessageContract<K> } = {
  PAUSE_RECORDING: recordingControl,
  RESUME_RECORDING: recordingControl,
  UNDO_LAST_CAPTURE: recordingControl,
  RESTORE_LAST_CAPTURE: recordingControl,
  PREPARE_NEXT_SNAPSHOT: recordingControl,
  CREATE_NEXT_SNAPSHOT: recordingControl,
  REBUILD_INVALIDATED_SNAPSHOT: recordingControl,
  SWITCH_TO_SNAPSHOT_MODE: recordingControl,
  SWITCH_TO_STEPS_MODE: recordingControl,
  DISCARD_CURRENT_RECORDING: recordingControl,
  FINISH_RECORDING: recordingControl,

  START_RECORDING: {
    senders: 'extension-pages',
    isRequest: (value) => (
      isString(value.sessionId) &&
      (value.mode === 'steps' || value.mode === 'snapshot') &&
      (value.autoCreatedProject === undefined || typeof value.autoCreatedProject === 'boolean') &&
      isContinuation(value.continuation) &&
      (value.insertAfterEntryId === undefined || typeof value.insertAfterEntryId === 'string')
    ),
    isResponse: isStartRecordingResult,
    failure: () => ({ ok: false, error: t().background.startServiceFailed }),
  },
  // Sent only by the e2e harness; product surfaces end a run with FINISH_RECORDING or DISCARD_CURRENT_RECORDING.
  STOP_RECORDING: {
    senders: 'extension-pages',
    isRequest: () => true,
    isResponse: isRuntimeVoid,
    failure: () => undefined,
  },
  OPEN_EDITOR: {
    senders: 'extension-pages',
    isRequest: (value) => (
      isOptionalString(value.sessionId) &&
      isOptionalString(value.entryId) &&
      (value.inPlace === undefined || typeof value.inPlace === 'boolean')
    ),
    isResponse: isOpenEditorResult,
    failure: () => ({ ok: false, error: t().runtime.editorOpenFailed }),
  },
  OPEN_LIBRARY: {
    senders: 'extension-pages',
    isRequest: () => true,
    isResponse: isOpenLibraryResult,
    failure: () => ({ ok: false, error: t().nav.libraryOpenFailed }),
  },
  // Which page registered is derived from the authenticated sender, so the payload carries nothing to forge.
  REGISTER_EXTENSION_PAGE: {
    senders: 'extension-pages',
    isRequest: () => true,
    isResponse: isRuntimeBoolean,
    failure: () => false,
  },

  PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.sessionId) && isTarget(value.target),
    isResponse: isPreflightStepRecaptureSourcePermissionResult,
    failure: () => ({ ok: false, code: 'INVALID_EDITOR', message: t().background.recaptureServiceFailedReload }),
  },
  PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.sessionId) && (value.afterEntryId === undefined || isString(value.afterEntryId)),
    isResponse: isPreflightProjectContinuationSourcePermissionResult,
    failure: () => ({ ok: false, code: 'INVALID_EDITOR', message: t().background.continuationServiceFailed }),
  },
  START_STEP_RECAPTURE: {
    senders: 'handler-checked',
    isRequest: (value) => (
      isString(value.sessionId) &&
      isTarget(value.target) &&
      (value.preferredTabId === undefined || isBrowserId(value.preferredTabId))
    ),
    isResponse: isStartStepRecaptureResult,
    failure: () => ({ ok: false, code: 'INJECTION_FAILED', error: t().background.recaptureServiceFailed }),
  },
  CANCEL_STEP_RECAPTURE: {
    senders: 'handler-checked',
    isRequest: isRunId,
    isResponse: isCancelStepRecaptureResult,
    failure: () => ({ ok: false, error: t().background.recaptureCancelFailed }),
  },
  ACK_STEP_RECAPTURE_RESULT: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.runId) && isString(value.sessionId),
    isResponse: isRuntimeBoolean,
    failure: () => false,
  },
  FOCUS_STEP_RECAPTURE_SOURCE: {
    senders: 'handler-checked',
    isRequest: isRunId,
    isResponse: isFocusStepRecaptureSourceResult,
    failure: () => ({ ok: false, error: t().background.recaptureTabSwitchFailed }),
  },
  HOWBEAM_RECAPTURE_READY: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.runId) && isHttpUrl(value.url),
    isResponse: isRuntimeBoolean,
    failure: () => false,
  },
  HOWBEAM_RECAPTURE_TARGET: {
    senders: 'handler-checked',
    isRequest: (value) => (
      isString(value.runId) &&
      isString(value.captureId) &&
      isRect(value.rect) &&
      isViewport(value.viewport) &&
      isDevicePixelRatio(value.devicePixelRatio) &&
      isHttpUrl(value.url) &&
      isTimestamp(value.timestamp)
    ),
    isResponse: isStepRecaptureTargetResult,
    failure: () => ({ ok: false, status: 'failed' }),
  },

  HOWBEAM_READY: {
    senders: 'handler-checked',
    isRequest: (value) => {
      if (!isString(value.runId)) return false;
      if (value.snapshotContext === undefined) return true;
      if (!isRecord(value.snapshotContext)) return false;
      return (
        isViewport(value.snapshotContext.viewport) &&
        isDevicePixelRatio(value.snapshotContext.devicePixelRatio) &&
        isHttpUrl(value.snapshotContext.url) &&
        isTimestamp(value.snapshotContext.timestamp)
      );
    },
    isResponse: isRuntimeBoolean,
    failure: () => false,
  },
  HOWBEAM_CLICK: {
    senders: 'handler-checked',
    isRequest: (value) => (
      (value.captureKind === undefined || value.captureKind === 'element' || value.captureKind === 'region') &&
      isString(value.captureId) &&
      isString(value.runId) &&
      isRect(value.rect) &&
      isDevicePixelRatio(value.devicePixelRatio) &&
      isViewport(value.viewport) &&
      typeof value.text === 'string' && value.text.length <= MAX_TEXT_LENGTH &&
      isString(value.tagName, 128) &&
      (value.intent === 'click' || value.intent === 'mark') &&
      isHttpUrl(value.url) &&
      isTimestamp(value.timestamp)
    ),
    isResponse: isClickCaptureResult,
    // A diagnostic code, not copy: the recorder only logs it.
    failure: () => ({ ok: false, error: 'capture-request-failed' }),
  },
  HOWBEAM_CANCEL_CAPTURE: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.runId) && isString(value.captureId),
    isResponse: isClickCaptureResult,
    failure: () => ({ ok: false, error: 'capture-cancellation-failed' }),
  },
  SNAPSHOT_INVALIDATED: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.runId) && isViewport(value.viewport) && isDevicePixelRatio(value.devicePixelRatio),
    isResponse: isRuntimeBoolean,
    failure: () => false,
  },
  SNAPSHOT_RECORDER_FAILED: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.runId) && value.reason === 'shield-channel',
    isResponse: isRuntimeBoolean,
    failure: () => false,
  },

  HOWBEAM_STEP_FRAME_BEGIN: {
    senders: 'handler-checked',
    isRequest: (value) => (
      isString(value.runId) &&
      isString(value.captureId) &&
      isRect(value.rect) &&
      typeof value.text === 'string' && value.text.length <= STEP_FRAME_LIMITS.maxTextLength &&
      isString(value.tagName, STEP_FRAME_LIMITS.maxTagLength) &&
      typeof value.interactive === 'boolean'
    ),
    isResponse: isStepFrameRelayBeginResult,
    failure: () => ({ ok: false }),
  },
  HOWBEAM_STEP_FRAME_CLAIM: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.runId) && isString(value.captureId) && isString(value.relayToken),
    isResponse: isStepFrameRelayClaimResult,
    failure: () => ({ ok: false }),
  },
  HOWBEAM_STEP_FRAME_REJECT: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.runId) && isString(value.captureId) && isString(value.relayToken),
    ...relayMutation,
  },
  HOWBEAM_STEP_FRAME_SETTLE: {
    senders: 'handler-checked',
    isRequest: (value) => (
      isString(value.runId) &&
      isString(value.captureId) &&
      isString(value.settleToken) &&
      typeof value.replay === 'boolean'
    ),
    ...relayMutation,
  },
  HOWBEAM_STEP_FRAME_ABORT: {
    senders: 'handler-checked',
    isRequest: (value) => isString(value.runId) && isString(value.captureId),
    ...relayMutation,
  },
};

export function contractFor<K extends BackgroundMessageType>(type: K): MessageContract<K> {
  return BACKGROUND_CONTRACTS[type];
}

function isMessageType(value: string): value is BackgroundMessageType {
  return Object.hasOwn(BACKGROUND_CONTRACTS, value);
}

/** Runtime messages cross a JavaScript trust boundary and require validation even when TypeScript callers are typed. */
export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    isMessageType(value.type) &&
    BACKGROUND_CONTRACTS[value.type].isRequest(value)
  );
}

export function isExtensionPageOnlyMessage(message: BackgroundMessage): boolean {
  return BACKGROUND_CONTRACTS[message.type].senders === 'extension-pages';
}

import { RECORDING_CONTROL_TYPES, type BackgroundMessage, type ClickCapture } from './messages';
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
const MAX_STEP_FRAME_TEXT_LENGTH = 200;
const MAX_STEP_FRAME_TAG_LENGTH = 100;
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

const RECORDING_CONTROLS: ReadonlySet<string> = new Set(RECORDING_CONTROL_TYPES);

/** Runtime messages cross a JavaScript trust boundary and require validation even when TypeScript callers are typed. */
export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  if (RECORDING_CONTROLS.has(value.type)) {
    return isString(value.runId) && isOptionalString(value.undoToken);
  }

  switch (value.type) {
    case 'START_RECORDING':
      return (
        isString(value.sessionId) &&
        (value.mode === 'steps' || value.mode === 'snapshot') &&
        (value.autoCreatedProject === undefined || typeof value.autoCreatedProject === 'boolean') &&
        isContinuation(value.continuation) &&
        (value.insertAfterEntryId === undefined || typeof value.insertAfterEntryId === 'string')
      );
    case 'STOP_RECORDING':
      return true;
    case 'OPEN_EDITOR':
      return (
        isOptionalString(value.sessionId) &&
        isOptionalString(value.entryId) &&
        (value.inPlace === undefined || typeof value.inPlace === 'boolean')
      );
    case 'OPEN_LIBRARY':
      return true;
    case 'REGISTER_EXTENSION_PAGE':
      // Which page registered is derived from the authenticated sender, so the
      // payload carries nothing that could be forged.
      return true;
    case 'RESET_PROJECT':
      return isString(value.sessionId);
    case 'SNAPSHOT_INVALIDATED':
      return isString(value.runId) && isViewport(value.viewport) && isDevicePixelRatio(value.devicePixelRatio);
    case 'SNAPSHOT_RECORDER_FAILED':
      return isString(value.runId) && value.reason === 'shield-channel';
    case 'STEPMARK_CANCEL_CAPTURE':
      return isString(value.runId) && isString(value.captureId);
    case 'STEPMARK_READY': {
      if (!isString(value.runId)) return false;
      if (value.snapshotContext === undefined) return true;
      if (!isRecord(value.snapshotContext)) return false;
      return (
        isViewport(value.snapshotContext.viewport) &&
        isDevicePixelRatio(value.snapshotContext.devicePixelRatio) &&
        isHttpUrl(value.snapshotContext.url) &&
        isTimestamp(value.snapshotContext.timestamp)
      );
    }
    case 'STEPMARK_CLICK':
      return (
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
      );
    case 'STEPMARK_STEP_FRAME_BEGIN':
      return (
        isString(value.runId) &&
        isString(value.captureId) &&
        isRect(value.rect) &&
        typeof value.text === 'string' && value.text.length <= MAX_STEP_FRAME_TEXT_LENGTH &&
        isString(value.tagName, MAX_STEP_FRAME_TAG_LENGTH) &&
        typeof value.interactive === 'boolean'
      );
    case 'STEPMARK_STEP_FRAME_CLAIM':
    case 'STEPMARK_STEP_FRAME_REJECT':
      return isString(value.runId) && isString(value.captureId) && isString(value.relayToken);
    case 'STEPMARK_STEP_FRAME_SETTLE':
      return (
        isString(value.runId) &&
        isString(value.captureId) &&
        isString(value.settleToken) &&
        typeof value.replay === 'boolean'
      );
    case 'STEPMARK_STEP_FRAME_ABORT':
      return isString(value.runId) && isString(value.captureId);
    case 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION':
      return isString(value.sessionId) && isTarget(value.target);
    case 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION':
      return isString(value.sessionId) && (value.afterEntryId === undefined || isString(value.afterEntryId));
    case 'START_STEP_RECAPTURE':
      return isString(value.sessionId) && isTarget(value.target) &&
        (value.preferredTabId === undefined || isBrowserId(value.preferredTabId));
    case 'STEPMARK_RECAPTURE_READY':
      return isString(value.runId) && isHttpUrl(value.url);
    case 'STEPMARK_RECAPTURE_TARGET':
      return (
        isString(value.runId) &&
        isString(value.captureId) &&
        isRect(value.rect) &&
        isViewport(value.viewport) &&
        isDevicePixelRatio(value.devicePixelRatio) &&
        isHttpUrl(value.url) &&
        isTimestamp(value.timestamp)
      );
    case 'CANCEL_STEP_RECAPTURE':
    case 'FOCUS_STEP_RECAPTURE_SOURCE':
      return isString(value.runId);
    case 'ACK_STEP_RECAPTURE_RESULT':
      return isString(value.runId) && isString(value.sessionId);
    default:
      return false;
  }
}

export interface RuntimeMessageSenderLike {
  frameId?: number;
  url?: string;
  tab?: { id?: number; url?: string };
}

function sameExtensionOrigin(candidate: string | undefined, extensionUrl: string): boolean {
  if (!candidate) return false;
  try {
    const candidateUrl = new URL(candidate);
    const expectedUrl = new URL(extensionUrl);
    // URL.origin is the string "null" for chrome-extension:/moz-extension:
    // URLs, so compare the actual extension scheme and host instead.
    return candidateUrl.protocol === expectedUrl.protocol && candidateUrl.host === expectedUrl.host;
  } catch {
    return false;
  }
}

/** Rejects content scripts and child frames from extension-page-only lifecycle controls. */
export function isTrustedExtensionPageSender(sender: RuntimeMessageSenderLike, extensionUrl: string): boolean {
  if (!sameExtensionOrigin(sender.url, extensionUrl)) return false;
  if (!sender.tab) return true; // popup and other extension views are not associated with a tab
  return sender.frameId === 0 && sender.tab.id != null && sameExtensionOrigin(sender.tab.url, extensionUrl);
}

/**
 * In-page toolbars run in the dynamically injected top-frame recorder, not an
 * extension page. Bind their controls to the authoritative recorded tab; the
 * control handler separately verifies the unguessable run id and current phase.
 */
export function isTrustedRecorderControlSender(
  sender: RuntimeMessageSenderLike,
  recordedTabId: number | null,
): boolean {
  return (
    recordedTabId !== null &&
    sender.frameId === 0 &&
    sender.tab?.id === recordedTabId
  );
}

/** Keeps MV3 alive only for the top frame that owns the active capture job,
 * plus the tab a recording is moving out of while that move is in flight. */
export function isTrustedKeepAliveSender(
  sender: RuntimeMessageSenderLike,
  state: {
    operation: 'recording' | 'recapture' | null;
    isRecording: boolean;
    tabId: number | null;
    recapture: { sourceTabId: number } | null;
  },
  followOriginTabId: number | null = null,
): boolean {
  if (sender.frameId !== 0 || sender.tab?.id == null) return false;
  if (state.operation === 'recording') {
    return state.isRecording && (state.tabId === sender.tab.id || followOriginTabId === sender.tab.id);
  }
  return state.operation === 'recapture' && state.recapture?.sourceTabId === sender.tab.id;
}

export function isExtensionPageOnlyMessage(message: BackgroundMessage): boolean {
  return message.type === 'START_RECORDING' ||
    message.type === 'STOP_RECORDING' ||
    message.type === 'RESET_PROJECT' ||
    message.type === 'OPEN_EDITOR' ||
    message.type === 'OPEN_LIBRARY' ||
    message.type === 'REGISTER_EXTENSION_PAGE';
}

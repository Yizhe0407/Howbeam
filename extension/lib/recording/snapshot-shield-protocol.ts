import { RECORDING_CONTROL_TYPES, type RecordingControlMessage, type RecordingControlResult } from '../runtime/messages';
import type { RecordingMode, RecordingPhase } from '../storage/recording-state';
import { REGION_CAPTURE_MIN_SIZE, isRegionRectLargeEnough } from '../capture/region-capture';
import { isFiniteRect } from '../shared/validation';

export const SNAPSHOT_SHIELD_INIT = 'HOWBEAM_SNAPSHOT_SHIELD_INIT';
export const SNAPSHOT_SHIELD_READY = 'HOWBEAM_SNAPSHOT_SHIELD_READY';
export const SNAPSHOT_SHIELD_POINTER_DOWN = 'HOWBEAM_SNAPSHOT_SHIELD_POINTER_DOWN';
export const SNAPSHOT_SHIELD_POINTER_MOVE = 'HOWBEAM_SNAPSHOT_SHIELD_POINTER_MOVE';
export const SNAPSHOT_SHIELD_PREVIEW = 'HOWBEAM_SNAPSHOT_SHIELD_PREVIEW';
export const SNAPSHOT_SHIELD_CAPTURE_COMPLETE = 'HOWBEAM_SNAPSHOT_SHIELD_CAPTURE_COMPLETE';
export const SNAPSHOT_SHIELD_COMMIT = 'HOWBEAM_SNAPSHOT_SHIELD_COMMIT';
export const SNAPSHOT_SHIELD_UNDO = 'HOWBEAM_SNAPSHOT_SHIELD_UNDO';
export const SNAPSHOT_SHIELD_TOOLBAR_STATE = 'HOWBEAM_SNAPSHOT_SHIELD_TOOLBAR_STATE';
export const SNAPSHOT_SHIELD_CONTROL = 'HOWBEAM_SNAPSHOT_SHIELD_CONTROL';
export const SNAPSHOT_SHIELD_CONTROL_RESULT = 'HOWBEAM_SNAPSHOT_SHIELD_CONTROL_RESULT';
export const SNAPSHOT_SHIELD_CANDIDATES = 'HOWBEAM_SNAPSHOT_SHIELD_CANDIDATES';
export const SNAPSHOT_SHIELD_REGION_CAPTURE = 'HOWBEAM_SNAPSHOT_SHIELD_REGION_CAPTURE';
export const SNAPSHOT_KEYBOARD_LABEL_LIMIT = 200;
export const SNAPSHOT_REGION_COORDINATE_LIMIT = 1_000_000;

export interface SnapshotShieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Canonical dedup/identity key for a shield rect at half-pixel resolution.
 * The page-side recorder and the shield page both key committed rects with
 * this exact function — they MUST agree, or undo/duplicate detection drifts
 * between the two sides of the channel.
 */
export function snapshotRectKey(rect: SnapshotShieldRect): string {
  return [rect.x, rect.y, rect.width, rect.height]
    .map((value) => Math.round(value * 2))
    .join(':');
}

export interface SnapshotShieldSelection {
  rect: SnapshotShieldRect;
  label: number;
}

/** Distributes over a shield message union, dropping the channel token that
 * each side's `post` helper injects. */
export type WithoutToken<M> = M extends { token: string } ? Omit<M, 'token'> : never;

export interface SnapshotShieldPreviewResult {
  rect: SnapshotShieldRect | null;
}

export type ToolbarTheme = 'light' | 'dark';

export interface SnapshotShieldInitMessage {
  type: typeof SNAPSHOT_SHIELD_INIT;
  token: string;
  /** The recorded page's OS colour preference. The shield frame is pinned to `only light`, which makes its own
   * `prefers-color-scheme` always read light, so the toolbar inside it cannot tell for itself. */
  theme?: ToolbarTheme;
}

interface SnapshotShieldReadyMessage {
  type: typeof SNAPSHOT_SHIELD_READY;
  token: string;
}

export interface SnapshotShieldPointerDownMessage {
  type: typeof SNAPSHOT_SHIELD_POINTER_DOWN;
  token: string;
  /** Shield-local capture generation. Echoed on CAPTURE_COMPLETE so a reply
   * that outlived its local timeout can never settle a newer capture. */
  captureId: number;
  clientX: number;
  clientY: number;
}

export interface SnapshotShieldPointerMoveMessage {
  type: typeof SNAPSHOT_SHIELD_POINTER_MOVE;
  token: string;
  requestId: number;
  clientX: number;
  clientY: number;
}

export interface SnapshotShieldRegionCaptureMessage {
  type: typeof SNAPSHOT_SHIELD_REGION_CAPTURE;
  token: string;
  /** See SnapshotShieldPointerDownMessage.captureId. */
  captureId: number;
  rect: SnapshotShieldRect;
}

interface SnapshotShieldPreviewMessage {
  type: typeof SNAPSHOT_SHIELD_PREVIEW;
  token: string;
  requestId: number;
  rect: SnapshotShieldRect | null;
}

interface SnapshotShieldCaptureCompleteMessage {
  type: typeof SNAPSHOT_SHIELD_CAPTURE_COMPLETE;
  token: string;
  /** Echo of the originating capture's captureId. */
  captureId: number;
  selection: (SnapshotShieldSelection & { id: number }) | null;
}

interface SnapshotShieldCommitMessage {
  type: typeof SNAPSHOT_SHIELD_COMMIT;
  token: string;
  selection: SnapshotShieldSelection & { id: number };
}

interface SnapshotShieldUndoMessage {
  type: typeof SNAPSHOT_SHIELD_UNDO;
  token: string;
}

export interface SnapshotShieldToolbarStateMessage {
  type: typeof SNAPSHOT_SHIELD_TOOLBAR_STATE;
  token: string;
  state: {
    runId: string;
    mode: RecordingMode;
    phase: RecordingPhase;
    itemCount: number;
    runItemCount: number;
    projectTitle?: string | null;
    error: string | null;
  };
}

export interface SnapshotShieldControlMessage {
  type: typeof SNAPSHOT_SHIELD_CONTROL;
  token: string;
  requestId: number;
  action: RecordingControlMessage['type'];
  undoToken?: string;
}

interface SnapshotShieldControlResultMessage {
  type: typeof SNAPSHOT_SHIELD_CONTROL_RESULT;
  token: string;
  requestId: number;
  result: RecordingControlResult;
}

/** A keyboard-reachable annotation candidate: a viewport point plus its
 * accessible label, driven by index inside the frozen shield (§9.5). */
export interface SnapshotShieldKeyboardAnchor {
  x: number;
  y: number;
  label: string;
}

interface SnapshotShieldCandidatesMessage {
  type: typeof SNAPSHOT_SHIELD_CANDIDATES;
  token: string;
  anchors: SnapshotShieldKeyboardAnchor[];
}

export type SnapshotShieldPortMessage =
  | SnapshotShieldReadyMessage
  | SnapshotShieldPointerDownMessage
  | SnapshotShieldPointerMoveMessage
  | SnapshotShieldRegionCaptureMessage
  | SnapshotShieldControlMessage;

export type SnapshotShieldFrameMessage =
  | SnapshotShieldPreviewMessage
  | SnapshotShieldCaptureCompleteMessage
  | SnapshotShieldCommitMessage
  | SnapshotShieldUndoMessage
  | SnapshotShieldToolbarStateMessage
  | SnapshotShieldControlResultMessage
  | SnapshotShieldCandidatesMessage;

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRect(value: unknown): value is SnapshotShieldRect {
  return isFiniteRect(value, { maxMagnitude: SNAPSHOT_REGION_COORDINATE_LIMIT });
}

export function isSnapshotShieldRegionRect(value: unknown): value is SnapshotShieldRect {
  if (
    !isFiniteRect(value, {
      maxMagnitude: SNAPSHOT_REGION_COORDINATE_LIMIT,
      minSize: REGION_CAPTURE_MIN_SIZE,
    })
  ) {
    return false;
  }
  // Region rects live in viewport coordinates: the origin must be
  // non-negative, and the far edges (sum-check) stay bounded too so a rect
  // cannot smuggle an overflowing extent past the per-field magnitude check.
  if (!isRegionRectLargeEnough(value, REGION_CAPTURE_MIN_SIZE)) return false;
  return (
    value.x + value.width <= SNAPSHOT_REGION_COORDINATE_LIMIT &&
    value.y + value.height <= SNAPSHOT_REGION_COORDINATE_LIMIT
  );
}

function isSelection(value: unknown): value is SnapshotShieldSelection & { id: number } {
  if (!value || typeof value !== 'object') return false;
  const selection = value as Partial<SnapshotShieldSelection & { id: number }>;
  const label = selection.label;
  return (
    isRequestId(selection.id) &&
    isRect(selection.rect) &&
    label !== undefined && Number.isSafeInteger(label) && label > 0
  );
}

/**
 * The shield's init token must never travel in the iframe URL: the host page
 * can read frame URLs through resource timing and would win the init race.
 * Instead the creator parks the token in extension storage under a public
 * per-frame key; only extension contexts can read it, so the extension-origin
 * shield page retrieves (and immediately consumes) it while page scripts
 * cannot.
 */
export const SNAPSHOT_SHIELD_TOKEN_STORAGE_PREFIX = 'howbeam:shieldToken:';
/** Stale token records are swept opportunistically after this age. */
export const SNAPSHOT_SHIELD_TOKEN_TTL_MS = 60_000;
const SNAPSHOT_SHIELD_TOKEN_LIMIT = 256;

export interface SnapshotShieldTokenRecord {
  token: string;
  createdAt: number;
}

export function buildShieldTokenStorageKey(frameKey: string): string {
  return `${SNAPSHOT_SHIELD_TOKEN_STORAGE_PREFIX}${frameKey}`;
}

export function isSnapshotShieldTokenRecord(value: unknown): value is SnapshotShieldTokenRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SnapshotShieldTokenRecord>;
  return (
    typeof record.token === 'string' &&
    record.token.length > 0 &&
    record.token.length <= SNAPSHOT_SHIELD_TOKEN_LIMIT &&
    Number.isFinite(record.createdAt)
  );
}

export function isSnapshotShieldInitMessage(value: unknown, token: string): value is SnapshotShieldInitMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<SnapshotShieldInitMessage>;
  return (
    message.type === SNAPSHOT_SHIELD_INIT &&
    message.token === token &&
    (message.theme === undefined || message.theme === 'light' || message.theme === 'dark')
  );
}

export function isSnapshotShieldPortMessage(value: unknown, token: string): value is SnapshotShieldPortMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as {
    type?: SnapshotShieldPortMessage['type'];
    token?: string;
    requestId?: number;
    captureId?: number;
    clientX?: number;
    clientY?: number;
    action?: RecordingControlMessage['type'];
    undoToken?: string;
    rect?: SnapshotShieldRect;
  };
  if (message.token !== token) return false;
  if (message.type === SNAPSHOT_SHIELD_READY) return true;
  if (message.type === SNAPSHOT_SHIELD_REGION_CAPTURE) {
    return isRequestId(message.captureId) && isSnapshotShieldRegionRect(message.rect);
  }
  if (message.type === SNAPSHOT_SHIELD_CONTROL) {
    return (
      isRequestId(message.requestId) &&
      (RECORDING_CONTROL_TYPES as readonly (string | undefined)[]).includes(message.action) &&
      (message.undoToken === undefined || typeof message.undoToken === 'string')
    );
  }
  const { clientX, clientY } = message;
  const hasPoint =
    clientX !== undefined &&
    clientY !== undefined &&
    Number.isFinite(clientX) &&
    Number.isFinite(clientY) &&
    clientX >= 0 &&
    clientY >= 0;
  if (message.type === SNAPSHOT_SHIELD_POINTER_DOWN) {
    return hasPoint && isRequestId(message.captureId);
  }
  return (
    message.type === SNAPSHOT_SHIELD_POINTER_MOVE && hasPoint && isRequestId(message.requestId)
  );
}

export function isSnapshotShieldFrameMessage(value: unknown, token: string): value is SnapshotShieldFrameMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as {
    type?: SnapshotShieldFrameMessage['type'];
    token?: string;
    requestId?: number;
    captureId?: number;
    rect?: SnapshotShieldRect | null;
    selection?: (SnapshotShieldSelection & { id: number }) | null;
    state?: SnapshotShieldToolbarStateMessage['state'];
    result?: RecordingControlResult;
    anchors?: SnapshotShieldKeyboardAnchor[];
  };
  if (message.token !== token) return false;
  if (message.type === SNAPSHOT_SHIELD_CANDIDATES) {
    return (
      Array.isArray(message.anchors) &&
      message.anchors.every(
        (anchor) =>
          Boolean(anchor) &&
          Number.isFinite(anchor.x) &&
          Number.isFinite(anchor.y) &&
          typeof anchor.label === 'string' &&
          anchor.label.length <= SNAPSHOT_KEYBOARD_LABEL_LIMIT,
      )
    );
  }
  if (message.type === SNAPSHOT_SHIELD_PREVIEW) {
    return isRequestId(message.requestId) && (message.rect === null || isRect(message.rect));
  }
  if (message.type === SNAPSHOT_SHIELD_CAPTURE_COMPLETE) {
    return isRequestId(message.captureId) && (message.selection === null || isSelection(message.selection));
  }
  if (message.type === SNAPSHOT_SHIELD_COMMIT) return isSelection(message.selection);
  if (message.type === SNAPSHOT_SHIELD_UNDO) return true;
  if (message.type === SNAPSHOT_SHIELD_TOOLBAR_STATE) {
    const state = message.state;
    if (!state) return false;
    return (
      typeof state.runId === 'string' &&
      state.mode === 'snapshot' &&
      typeof state.phase === 'string' &&
      Number.isSafeInteger(state.itemCount) &&
      state.itemCount >= 0 &&
      Number.isSafeInteger(state.runItemCount) &&
      state.runItemCount >= 0 &&
      (state.projectTitle == null || (typeof state.projectTitle === 'string' && state.projectTitle.length <= 512)) &&
      (state.error === null || typeof state.error === 'string')
    );
  }
  if (message.type !== SNAPSHOT_SHIELD_CONTROL_RESULT) return false;
  const result = message.result;
  return isRequestId(message.requestId) && result != null && typeof result.ok === 'boolean';
}

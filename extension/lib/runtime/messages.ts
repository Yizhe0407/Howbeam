import type { RecordingMode, StepRecaptureTarget, Viewport } from '../storage/recording-state';

type CaptureIntent = 'click' | 'mark';

/** Clicked element rect in CSS px, relative to the viewport at capture time. */
interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClickCapture {
  type: 'HOWBEAM_CLICK';
  /** Element selections replay the original page click; region selections are capture-only. */
  captureKind?: 'element' | 'region';
  /** 讓已取消 gesture 使進行中的截圖失效。 */
  captureId: string;
  runId: string;
  rect: CaptureRect;
  devicePixelRatio: number;
  /** CSS viewport occupied by the screenshot, used to derive its real pixel scale. */
  viewport: Viewport;
  text: string;
  tagName: string;
  intent: CaptureIntent;
  url: string;
  timestamp: number;
}

export interface StartRecordingMessage {
  type: 'START_RECORDING';
  sessionId: string;
  mode: RecordingMode;
  /** 未擷取內容時，允許 background 回收該流程建立的 Project。 */
  autoCreatedProject?: boolean;
  /** 從持久化來源接續；一律不信任呼叫端提供的來源 URL。 */
  continuation?: { preferredTabId?: number };
  /** Editor runs only: insert the captured steps after this entry instead of appending. */
  insertAfterEntryId?: string;
}

/** Machine-readable reason a start failed, for callers that offer a specific
 * recovery. Optional: most failures carry only their localized `error`. */
export type StartRecordingErrorCode =
  /** Continuation: the source page failed to load (browser error page); the
   * tab opened for it was closed. Continue from another page instead. */
  | 'SOURCE_PAGE_UNREACHABLE';

export type StartRecordingResult =
  | { ok: true; sessionId: string; runId: string }
  | { ok: false; error: string; code?: StartRecordingErrorCode };

export interface SourcePermissionPreflightSuccess {
  ok: true;
  /** Exact persisted HTTP(S) URL resolved by background; never accepted from editor state. */
  sourceUrl: string;
  sourceOrigin: string;
  permissionPattern: string;
}

interface StopRecordingMessage {
  type: 'STOP_RECORDING';
}

export interface OpenEditorMessage {
  type: 'OPEN_EDITOR';
  /** Explicit Project target for normal navigation. Omitted only for recovery. */
  sessionId?: string;
  entryId?: string;
  /**
   * Sent by an extension page asking to become the editor itself. Honoured
   * only when no editor tab exists elsewhere: the single editor tab still
   * wins, so the request then switches to it as usual.
   */
  inPlace?: boolean;
}

interface OpenLibraryMessage {
  type: 'OPEN_LIBRARY';
}

export type OpenLibraryResult = { ok: true } | { ok: false; error: string };

/**
 * An extension page telling the background which tab it occupies. The
 * background cannot discover its own pages with tabs.query — see the
 * permission analysis in lib/recording/background/extension-page-tabs.ts — and
 * the page kind is derived from the authenticated sender URL, never from a
 * payload, so this message needs no fields.
 */
interface RegisterExtensionPageMessage {
  type: 'REGISTER_EXTENSION_PAGE';
}

/**
 * Background-to-editor handoff, delivered with tabs.sendMessage before the
 * background reuses an existing editor tab. Only the page knows which Project it
 * currently displays and whether it holds unsaved work, so it answers whether
 * it is already showing this target (`ready`), consents to being navigated
 * there, or must keep its draft.
 */
export interface EditorHandoffMessage {
  type: 'EDITOR_HANDOFF';
  sessionId: string;
  entryId?: string;
}

export type EditorHandoffResult =
  | { ok: true; ready: boolean }
  | { ok: false; error: string };

export type OpenEditorResult = { ok: true } | { ok: false; error: string };

export const RECORDING_CONTROL_TYPES = [
  'PAUSE_RECORDING',
  'RESUME_RECORDING',
  'UNDO_LAST_CAPTURE',
  'RESTORE_LAST_CAPTURE',
  'PREPARE_NEXT_SNAPSHOT',
  'CREATE_NEXT_SNAPSHOT',
  'REBUILD_INVALIDATED_SNAPSHOT',
  'SWITCH_TO_SNAPSHOT_MODE',
  'SWITCH_TO_STEPS_MODE',
  'DISCARD_CURRENT_RECORDING',
  'FINISH_RECORDING',
] as const;

export interface RecordingControlMessage {
  type: (typeof RECORDING_CONTROL_TYPES)[number];
  runId: string;
  undoToken?: string;
}

/** Sent by the top-level snapshot recorder when its immutable base-image
 * viewport contract no longer matches the live page. */
export interface SnapshotInvalidatedMessage {
  type: 'SNAPSHOT_INVALIDATED';
  runId: string;
  viewport: Viewport;
  devicePixelRatio: number;
}

/** Sent by the top-level snapshot recorder when its private UI channel fails
 * after startup. Background stops the run so the page cannot remain frozen
 * while durable state incorrectly claims recording is still active. */
export interface SnapshotRecorderFailureMessage {
  type: 'SNAPSHOT_RECORDER_FAILED';
  runId: string;
  reason: 'shield-channel';
}

export interface FinishResult {
  sessionId: string;
  entryId: string | null;
  itemCount: number;
}

export type RecordingControlResult =
  | {
      ok: true;
      undoToken?: string;
      removedItemNumber?: number;
      finish?: FinishResult;
    }
  | { ok: false; error: string };

/** 在 BackgroundMessage 外傳送，用於卸載 tab 錄製器並釋放 keep-alive port。 */
export interface HowbeamStopMessage {
  type: 'HOWBEAM_STOP';
}

/** The step screenshot for this capture has been taken: the recorder may
 * replay the held click while the background still stores the step. */
export interface HowbeamCaptureTakenMessage {
  type: 'HOWBEAM_CAPTURE_TAKEN';
  runId: string;
  captureId: string;
}

/** 僅在乾淨 anchor 持久化後啟用快照互動。 */
export interface HowbeamSnapshotActiveMessage {
  type: 'HOWBEAM_SNAPSHOT_ACTIVE';
  runId: string;
}

/** `error` is a short diagnostic reason code/message, not user-facing copy —
 * the content script only ever surfaces it in a console.warn. User-facing
 * failures go through the separate recordingState.error/recoverableError
 * path (setRunError), which this result type does not touch. `reported`
 * marks a rejection the background already told the user about (a run
 * error, an invalidated snapshot, a run it ended or moved); any other
 * rejection leaves the recorder to say the click went unrecorded. */
export type ClickCaptureResult = { ok: true } | { ok: false; error: string; reported?: true };

/**
 * Child-frame step gestures use an extension-authenticated runtime handshake
 * before their geometry is allowed onto the page-visible hop channel. Page
 * scripts may observe or forge hop messages, but cannot mint this authorization.
 */
export interface StepFrameRelayBeginMessage {
  type: 'HOWBEAM_STEP_FRAME_BEGIN';
  runId: string;
  captureId: string;
  /** Target rect in the originating child frame's viewport coordinates. */
  rect: CaptureRect;
  text: string;
  tagName: string;
  interactive: boolean;
}

export type StepFrameRelayBeginResult =
  | { ok: true; relayToken: string }
  | { ok: false };

/** The top-frame content script consumes the page-visible token exactly once. */
export interface StepFrameRelayClaimMessage {
  type: 'HOWBEAM_STEP_FRAME_CLAIM';
  runId: string;
  captureId: string;
  relayToken: string;
}

export type StepFrameRelayClaimResult =
  | {
      ok: true;
      settleToken: string;
      target: { text: string; tagName: string; interactive: boolean };
    }
  | { ok: false };

/** A non-top relay hop could not map the target into its parent viewport. */
export interface StepFrameRelayRejectMessage {
  type: 'HOWBEAM_STEP_FRAME_REJECT';
  runId: string;
  captureId: string;
  relayToken: string;
}

/** The top frame reports whether the swallowed child gesture may replay. */
export interface StepFrameRelaySettleMessage {
  type: 'HOWBEAM_STEP_FRAME_SETTLE';
  runId: string;
  captureId: string;
  settleToken: string;
  replay: boolean;
}

/** The originating frame timed out/cancelled before the relay completed. */
export interface StepFrameRelayAbortMessage {
  type: 'HOWBEAM_STEP_FRAME_ABORT';
  runId: string;
  captureId: string;
}

export interface StepFrameRelayMutationResult {
  ok: boolean;
}

/** Background-to-origin completion; delivered with tabs.sendMessage(frameId). */
export interface HowbeamStepFrameResultMessage {
  type: 'HOWBEAM_STEP_FRAME_RESULT';
  runId: string;
  captureId: string;
  replay: boolean;
}

interface CancelCaptureMessage {
  type: 'HOWBEAM_CANCEL_CAPTURE';
  runId: string;
  captureId: string;
}

export interface RecorderReadyMessage {
  type: 'HOWBEAM_READY';
  runId: string;
  /** 快照模式會先擷取此乾淨底圖，再接受標註。 */
  snapshotContext?: {
    viewport: Viewport;
    devicePixelRatio: number;
    url: string;
    timestamp: number;
  };
}

export interface PreflightStepRecaptureSourcePermissionMessage {
  type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION';
  sessionId: string;
  target: StepRecaptureTarget;
}

/** 與 runtime-message-result.ts 的結果 guard 共用。 */
export const RECAPTURE_PREFLIGHT_ERROR_CODES = [
  'INVALID_EDITOR',
  'TARGET_NOT_FOUND',
  'TARGET_CHANGED',
  'UNSUPPORTED_SNAPSHOT_GROUP',
  'RESTRICTED_SOURCE',
] as const;

export type PreflightStepRecaptureSourcePermissionErrorCode =
  (typeof RECAPTURE_PREFLIGHT_ERROR_CODES)[number];

export type PreflightStepRecaptureSourcePermissionResult =
  | SourcePermissionPreflightSuccess
  | { ok: false; code: PreflightStepRecaptureSourcePermissionErrorCode; message: string };

export interface PreflightProjectContinuationSourcePermissionMessage {
  type: 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION';
  sessionId: string;
  /** Entry the new steps go after; omitted to append at the end. */
  afterEntryId?: string;
}

export const CONTINUATION_PREFLIGHT_ERROR_CODES = [
  'INVALID_EDITOR',
  'SOURCE_NOT_FOUND',
  'RESTRICTED_SOURCE',
] as const;

export type PreflightProjectContinuationSourcePermissionErrorCode =
  (typeof CONTINUATION_PREFLIGHT_ERROR_CODES)[number];

export type PreflightProjectContinuationSourcePermissionResult =
  | SourcePermissionPreflightSuccess
  | { ok: false; code: PreflightProjectContinuationSourcePermissionErrorCode; message: string };

export interface StartStepRecaptureMessage {
  type: 'START_STEP_RECAPTURE';
  sessionId: string;
  target: StepRecaptureTarget;
  /** Editor may nominate an already-open exact-URL tab. Background revalidates it. */
  preferredTabId?: number;
}

/** START 會重跑 preflight，並加入接管來源 tab 的失敗類型。 */
export const RECAPTURE_START_ERROR_CODES = [
  'ACTIVE_OPERATION',
  ...RECAPTURE_PREFLIGHT_ERROR_CODES,
  'HOST_PERMISSION_REQUIRED',
  'SOURCE_TAB_FAILED',
  'INJECTION_FAILED',
] as const;

type StartStepRecaptureErrorCode = (typeof RECAPTURE_START_ERROR_CODES)[number];

export type StartStepRecaptureResult =
  | { ok: true; runId: string; tabId: number; reusedTab: boolean }
  | { ok: false; code: StartStepRecaptureErrorCode; error: string };

export interface HowbeamRecaptureReadyMessage {
  type: 'HOWBEAM_RECAPTURE_READY';
  runId: string;
  url: string;
}

export interface HowbeamRecaptureTargetMessage {
  type: 'HOWBEAM_RECAPTURE_TARGET';
  runId: string;
  captureId: string;
  rect: CaptureRect;
  viewport: Viewport;
  devicePixelRatio: number;
  url: string;
  timestamp: number;
}

export type StepRecaptureTargetResult =
  | { ok: true; status: 'replaced' }
  | { ok: false; status: 'rejected' | 'cancelled' | 'failed'; error?: string };

export interface CancelStepRecaptureMessage {
  type: 'CANCEL_STEP_RECAPTURE';
  runId: string;
}

export type CancelStepRecaptureResult =
  | { ok: true; status: 'cancelled' | 'already-completed' }
  | { ok: false; error: string };

export interface AckStepRecaptureResultMessage {
  type: 'ACK_STEP_RECAPTURE_RESULT';
  runId: string;
  sessionId: string;
}

export interface FocusStepRecaptureSourceMessage {
  type: 'FOCUS_STEP_RECAPTURE_SOURCE';
  runId: string;
}

export type FocusStepRecaptureSourceResult =
  | { ok: true }
  | { ok: false; error: string };

export type BackgroundMessage =
  | ClickCapture
  | StepFrameRelayBeginMessage
  | StepFrameRelayClaimMessage
  | StepFrameRelayRejectMessage
  | StepFrameRelaySettleMessage
  | StepFrameRelayAbortMessage
  | CancelCaptureMessage
  | SnapshotInvalidatedMessage
  | SnapshotRecorderFailureMessage
  | StartRecordingMessage
  | StopRecordingMessage
  | OpenEditorMessage
  | OpenLibraryMessage
  | RegisterExtensionPageMessage
  | RecordingControlMessage
  | RecorderReadyMessage
  | PreflightStepRecaptureSourcePermissionMessage
  | PreflightProjectContinuationSourcePermissionMessage
  | StartStepRecaptureMessage
  | HowbeamRecaptureReadyMessage
  | HowbeamRecaptureTargetMessage
  | CancelStepRecaptureMessage
  | AckStepRecaptureResultMessage
  | FocusStepRecaptureSourceMessage;

import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  ArrowRight,
  Camera,
  Check,
  Crop,
  Crosshair,
  GripVertical,
  Loader2,
  Minimize2,
  Pause,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type { RecordingControlMessage, RecordingControlResult } from '@/lib/runtime/messages';
import type { RecordingMode, RecordingPhase } from '@/lib/storage/recording-state';
import { recordingModeCopy } from './recording-mode-copy';

import { recordingToolbarStyles } from './recording-toolbar-styles';
import type { ToolbarTheme } from './snapshot-shield-protocol';
import { useToolbarPosition } from './use-toolbar-position';
import { useToolbarCollapsed } from './use-toolbar-collapsed';
import { useToolbarUndo } from './use-toolbar-undo';
import { isRecordingControlResult, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';
import { t, useActiveLocale } from '@/lib/shared/i18n';

type ToolbarAction = RecordingControlMessage['type'];

const MODE_OPTIONS: readonly RecordingMode[] = ['steps', 'snapshot'];

const modeSwitchAction = (target: RecordingMode): ToolbarAction =>
  target === 'snapshot' ? 'SWITCH_TO_SNAPSHOT_MODE' : 'SWITCH_TO_STEPS_MODE';

export interface RecordingToolbarState {
  runId: string;
  mode: RecordingMode;
  phase: RecordingPhase;
  itemCount: number;
  /** Existing Project the run appends to; null when recording into a new one. */
  projectTitle?: string | null;
  error: string | null;
}

interface Props {
  state: RecordingToolbarState;
  onCommand: (action: ToolbarAction, undoToken?: string) => Promise<RecordingControlResult>;
  onUndoApplied?: () => void;
  onRestoreApplied?: () => void;
  onStartRegionCapture?: () => void;
  regionCaptureActive?: boolean;
  /** A problem the page side detected on its own (a click that could not be
   * recorded, a page that cannot be recorded), shown like a command error. */
  notice?: string | null;
  /** Overrides the OS preference, for a mount point (the shield frame) where that preference cannot be read. */
  theme?: ToolbarTheme;
}

export default function RecordingToolbar({
  state,
  onCommand,
  onUndoApplied,
  onRestoreApplied,
  onStartRegionCapture,
  regionCaptureActive = false,
  notice = null,
  theme,
}: Props) {
  useActiveLocale();
  const { collapsed, setCollapsed, ready: collapseReady } = useToolbarCollapsed(state.runId);
  const [pending, setPending] = useState<ToolbarAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const { undo, offer: offerUndo, clear: clearUndo } = useToolbarUndo(state.runId, state.itemCount);
  const [showSuccess, setShowSuccess] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const previousCount = useRef(state.itemCount);
  const pendingRef = useRef<ToolbarAction | null>(null);
  const floatingRef = useRef<HTMLElement | null>(null);
  const cancelDiscardRef = useRef<HTMLButtonElement | null>(null);
  const confirmTitleId = useId();
  const confirmDescriptionId = useId();
  const modeCopy = recordingModeCopy(state.mode);

  const {
    corner,
    position,
    ready: positionReady,
    suppressNextClick,
    handlePositionPointerDown,
    handlePositionPointerMove,
    finishPositionDrag,
  } = useToolbarPosition({
    floatingRef,
    // The floating element remounts when collapse toggles and resizes when the
    // phase switches layouts, so both feed the reposition/observer pass.
    layoutKey: `${collapsed}:${state.phase}:${collapseReady}`,
    isInteractionBlocked: () => pendingRef.current !== null,
    announce: setAnnouncement,
  });

  useEffect(() => {
    if (confirmDiscard) cancelDiscardRef.current?.focus();
  }, [confirmDiscard]);

  useEffect(() => {
    if (state.itemCount > previousCount.current) {
      setAnnouncement(recordingModeCopy(state.mode).itemAdded(state.itemCount));
      setShowSuccess(true);
      const timer = window.setTimeout(() => setShowSuccess(false), 800);
      previousCount.current = state.itemCount;
      return () => window.clearTimeout(timer);
    }
    previousCount.current = state.itemCount;
    return undefined;
  }, [state.itemCount, state.mode]);

  useEffect(() => {
    if (regionCaptureActive) setAnnouncement(t().toolbar.regionCaptureStarted);
  }, [regionCaptureActive]);

  async function run(action: ToolbarAction, token?: string): Promise<RecordingControlResult> {
    if (pendingRef.current) return { ok: false, error: t().toolbar.busy };
    pendingRef.current = action;
    setPending(action);
    setMessage(null);
    try {
      const result = requireRuntimeMessageResult<RecordingControlResult>(
        await onCommand(action, token),
        isRecordingControlResult,
        t().runtime.recordingChannelLost,
      );
      if (!result.ok) setMessage(result.error);
      return result;
    } catch (error) {
      // Inline copy of components/shared reportError — the toolbar lives in
      // lib/, which must not depend upward on components/.
      console.error('[howbeam] recording toolbar command failed', error);
      const result = {
        ok: false,
        error: error instanceof Error && error.message ? error.message : t().toolbar.actionFailed,
      } as const;
      setMessage(result.error);
      return result;
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  }

  async function handleUndo() {
    const result = await run('UNDO_LAST_CAPTURE');
    if (!result.ok || !result.undoToken || !result.removedItemNumber) return;
    onUndoApplied?.();
    offerUndo({ token: result.undoToken, itemNumber: result.removedItemNumber }, result.removedItemNumber - 1);
    setAnnouncement(modeCopy.itemRemoved(result.removedItemNumber));
  }

  async function handleRestore() {
    if (!undo) return;
    const result = await run('RESTORE_LAST_CAPTURE', undo.token);
    if (!result.ok) return;
    onRestoreApplied?.();
    clearUndo();
    setAnnouncement(t().toolbar.restored);
  }

  const handleDiscard = async () => {
    const result = await run('DISCARD_CURRENT_RECORDING');
    if (result.ok) setConfirmDiscard(false);
  };

  const handleSwitchMode = (target: RecordingMode) => {
    if (target === state.mode) return;
    // Leaving a snapshot keeps what was annotated, so there is nothing to ask about:
    // discarding is its own, explicit action (the trash button).
    void run(target === 'snapshot' ? 'SWITCH_TO_SNAPSHOT_MODE' : 'SWITCH_TO_STEPS_MODE');
  };

  const handleConfirmKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Stack the toolbar only when its single row would not fit. Measured after
  // every render, before paint, so it follows the real labels (any language,
  // mode or phase) and the viewport rather than a hard-coded breakpoint.
  useLayoutEffect(() => {
    const toolbar = floatingRef.current;
    if (!toolbar?.classList.contains('ft-toolbar')) return;
    const fit = () => {
      toolbar.removeAttribute('data-compact');
      // Measured on the real children: scrollWidth would also count the tooltips'
      // hidden ::after boxes, which stick out past the edge buttons.
      const last = toolbar.lastElementChild;
      const room = toolbar.getBoundingClientRect().right - (parseFloat(getComputedStyle(toolbar).paddingRight) || 0);
      if (last && last.getBoundingClientRect().right > room + 1) toolbar.setAttribute('data-compact', '');
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  });

  const paused = state.phase === 'paused';
  const preparingNext = state.mode === 'snapshot' && state.phase === 'preparing-next';
  const statusLabel = regionCaptureActive
    ? t().toolbar.regionCapturing
    : preparingNext
    ? t().toolbar.statusWaiting
    : state.mode === 'snapshot'
      ? t().toolbar.statusAnnotating(state.itemCount)
      : paused
        ? t().toolbar.statusPaused(state.itemCount)
        : t().toolbar.statusRecording(state.itemCount);
  const hint = regionCaptureActive
    ? null
    : preparingNext
      ? t().toolbar.hintWaiting
      : state.phase === 'recording' && state.itemCount === 0
        ? (state.mode === 'snapshot' ? t().toolbar.hintAnnotating : t().toolbar.hintRecording)
        : null;
  const invalidated = state.mode === 'snapshot' && state.phase === 'invalidated';
  const busy = pending !== null || state.phase === 'finishing';

  useEffect(() => {
    if (!invalidated) return;
    setCollapsed(false);
    clearUndo();
  }, [invalidated, setCollapsed, clearUndo]);

  if (state.phase === 'starting' || !collapseReady || !positionReady) return null;

  return (
    <>
      <style>{recordingToolbarStyles}</style>
      <div
        className="ft-layer"
        data-theme={theme}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || pendingRef.current) return;
          setConfirmDiscard(false);
        }}
      >
        {confirmDiscard && (
          <div
            className="ft-modal-backdrop"
            aria-hidden="true"
            onPointerDown={() => {
              if (pendingRef.current) return;
              setConfirmDiscard(false);
            }}
          />
        )}
        <div
          className="ft-position"
          data-horizontal={corner.endsWith('left') ? 'left' : 'right'}
          data-vertical={corner.startsWith('top') ? 'top' : 'bottom'}
          style={position ? { transform: `translate3d(${position.x}px, ${position.y}px, 0)` } : undefined}
        >
          {(message || (state.error && !invalidated) || notice) && (
            <div className="ft-message" data-kind="error" role="alert">
              {message ?? ((state.error && !invalidated) ? state.error : notice)}
            </div>
          )}
          {!message && !state.error && !notice && showSuccess && (
            <div className="ft-message" role="status"><Check className="ft-success" />{t().toolbar.recorded}</div>
          )}
          {hint && !collapsed && !message && !state.error && !notice && !showSuccess && !undo && !confirmDiscard && (
            <div className="ft-hint">{hint}</div>
          )}
          {undo && (
            <div className="ft-snackbar" role="status">
              <span>{modeCopy.itemRemoved(undo.itemNumber)}</span>
              <button type="button" onClick={handleRestore} disabled={busy}>{t().common.restore}</button>
            </div>
          )}
          {confirmDiscard && (
            <div
              className="ft-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={confirmTitleId}
              aria-describedby={confirmDescriptionId}
              onKeyDown={handleConfirmKeyDown}
            >
              <h2 className="ft-confirm-title" id={confirmTitleId}>{t().toolbar.discardTitle}</h2>
              <p className="ft-confirm-copy" id={confirmDescriptionId}>
                {t().toolbar.discardBody}
              </p>
              <div className="ft-confirm-actions">
                <button
                  ref={cancelDiscardRef}
                  type="button"
                  disabled={pending === 'DISCARD_CURRENT_RECORDING'}
                  onClick={() => setConfirmDiscard(false)}
                >
                  {t().common.cancel}
                </button>
                <button
                  type="button"
                  data-danger="true"
                  disabled={pending === 'DISCARD_CURRENT_RECORDING'}
                  onClick={() => void handleDiscard()}
                >
                  {pending === 'DISCARD_CURRENT_RECORDING' ? t().common.processing : t().toolbar.discard}
                </button>
              </div>
            </div>
          )}

          {collapsed && !invalidated ? (
            <button
              ref={(element) => { floatingRef.current = element; }}
              type="button"
              className="ft-collapsed"
              data-howbeam-toolbar-position=""
              aria-label={t().toolbar.expandLabel(statusLabel)}
              data-tooltip={t().toolbar.expandTooltip}
              onPointerDown={handlePositionPointerDown}
              onPointerMove={handlePositionPointerMove}
              onPointerUp={finishPositionDrag}
              onPointerCancel={finishPositionDrag}
              onClick={() => {
                if (suppressNextClick.current) {
                  suppressNextClick.current = false;
                  return;
                }
                setCollapsed(false);
              }}
            >
              <span className="ft-dot" aria-hidden="true" />
              <span className="ft-count-badge" style={{ minWidth: '22px', height: '22px', fontSize: '12px' }}>{state.itemCount}</span>
              <span className="ft-collapsed-expand">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
              </span>
            </button>
          ) : (
            <div
              ref={(element) => { floatingRef.current = element; }}
              className={`ft-toolbar${invalidated ? ' ft-toolbar--invalidated' : ''}`}
              role="toolbar"
              aria-label={t().toolbar.controlsLabel}
            >
              {invalidated ? (
                <>
                  <div className="ft-invalidated-status" role="status">
                    <TriangleAlert aria-hidden="true" />
                    <span className="ft-invalidated-copy">{t().toolbar.viewportChanged}</span>
                  </div>
                  <div className="ft-invalidated-actions">
                    {/* The invalidated shell has no collapse control (collapsing
                        would hide the only way out of the dead run), so discard
                        sits directly in the row instead of behind a menu whose
                        only item it was. */}
                    <button
                      type="button"
                      className="ft-button"
                      data-danger="true"
                      aria-label={t().toolbar.discardLabel}
                      data-tooltip={t().toolbar.discardLabel}
                      disabled={busy}
                      onClick={() => setConfirmDiscard(true)}
                    >
                      <Trash2 size={17} />
                    </button>
                    <button
                      type="button"
                      className="ft-secondary"
                      disabled={busy}
                      onClick={() => void run('FINISH_RECORDING')}
                    >
                      {pending === 'FINISH_RECORDING' ? t().toolbar.finishing : t().toolbar.finishRecording}
                    </button>
                    <button
                      type="button"
                      className="ft-finish"
                      disabled={busy}
                      onClick={() => void run('REBUILD_INVALIDATED_SNAPSHOT')}
                    >
                      {pending === 'REBUILD_INVALIDATED_SNAPSHOT' ? <Loader2 /> : <Plus />}
                      {pending === 'REBUILD_INVALIDATED_SNAPSHOT' ? t().toolbar.rebuilding : t().toolbar.keepAndRebuild}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ft-status"
                    data-howbeam-toolbar-position=""
                    aria-label={t().toolbar.moveLabel(statusLabel)
                      + (state.projectTitle ? `; ${t().toolbar.appendingTo(state.projectTitle)}` : '')}
                    data-tooltip={state.projectTitle ? t().toolbar.appendingTo(state.projectTitle) : t().toolbar.moveTooltip}
                    onPointerDown={handlePositionPointerDown}
                    onPointerMove={handlePositionPointerMove}
                    onPointerUp={finishPositionDrag}
                    onPointerCancel={finishPositionDrag}
                  >
                    {preparingNext ? (
                      <GripVertical className="ft-grip" aria-hidden="true" />
                    ) : paused ? (
                      <Pause className="ft-state-icon" data-tone="muted" aria-hidden="true" />
                    ) : state.mode === 'snapshot' ? (
                      <Crosshair className="ft-state-icon" aria-hidden="true" />
                    ) : (
                      <span className="ft-dot" aria-hidden="true" />
                    )}
                    {!preparingNext && (
                      <span className="ft-count-badge" data-tone={paused ? 'muted' : undefined}>{state.itemCount}</span>
                    )}
                  </button>

                  <div className="ft-mode-switch" role="radiogroup" aria-label={t().common.recordingMode}>
                    {MODE_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={state.mode === option}
                        disabled={busy || regionCaptureActive}
                        onClick={() => handleSwitchMode(option)}
                      >
                        {pending === modeSwitchAction(option) ? <Loader2 /> : recordingModeCopy(option).label}
                      </button>
                    ))}
                  </div>

                  {preparingNext && (
                    <button
                      type="button"
                      className="ft-primary"
                      data-tooltip={t().toolbar.captureFrameTooltip}
                      disabled={busy}
                      onClick={() => void run('CREATE_NEXT_SNAPSHOT')}
                    >
                      {pending === 'CREATE_NEXT_SNAPSHOT' ? <Loader2 /> : <Camera />}
                      {t().toolbar.captureFrame}
                    </button>
                  )}
                  {state.mode === 'snapshot' && !preparingNext && (
                    <button
                      type="button"
                      className="ft-primary"
                      data-tooltip={t().toolbar.nextFrameTooltip}
                      disabled={busy}
                      onClick={() => void run('PREPARE_NEXT_SNAPSHOT')}
                    >
                      {t().toolbar.nextFrame}
                      {pending === 'PREPARE_NEXT_SNAPSHOT' ? <Loader2 /> : <ArrowRight />}
                    </button>
                  )}

                  <div className="ft-actions-group">
                    {state.mode === 'steps' && (
                      <button
                        type="button"
                        className="ft-button"
                        data-emphasis={paused ? 'true' : undefined}
                        aria-label={paused ? t().toolbar.resume : t().toolbar.pause}
                        data-tooltip={paused ? t().toolbar.resume : t().toolbar.pause}
                        disabled={busy}
                        onClick={() => void run(paused ? 'RESUME_RECORDING' : 'PAUSE_RECORDING')}
                      >
                        {pending === 'PAUSE_RECORDING' || pending === 'RESUME_RECORDING'
                          ? <Loader2 />
                          : paused ? <Play size={16} /> : <Pause size={16} />}
                      </button>
                    )}
                    {!preparingNext && (
                      <button
                        type="button"
                        className="ft-button"
                        aria-label={t().toolbar.undo}
                        data-tooltip={t().toolbar.undoTooltip}
                        disabled={busy || state.itemCount === 0}
                        onClick={handleUndo}
                      >
                        {pending === 'UNDO_LAST_CAPTURE' ? <Loader2 /> : <Undo2 size={18} />}
                      </button>
                    )}
                    {!preparingNext && onStartRegionCapture && (
                      <button
                        type="button"
                        className="ft-button"
                        aria-label={regionCaptureActive ? t().toolbar.regionCaptureActive : t().toolbar.cropRegion}
                        data-tooltip={regionCaptureActive ? t().toolbar.regionCaptureActive : t().toolbar.cropRegion}
                        aria-pressed={regionCaptureActive}
                        disabled={busy || paused || regionCaptureActive || state.phase !== 'recording'}
                        onClick={() => onStartRegionCapture()}
                      >
                        <Crop size={17} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="ft-button"
                      data-danger="true"
                      aria-label={t().toolbar.discardLabel}
                      data-tooltip={t().toolbar.discardLabel}
                      disabled={busy}
                      onClick={() => setConfirmDiscard(true)}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>

                  <button
                    type="button"
                    className="ft-finish"
                    data-tooltip={t().toolbar.finishTooltip}
                    disabled={busy}
                    onClick={() => void run('FINISH_RECORDING')}
                  >
                    {pending === 'FINISH_RECORDING' || state.phase === 'finishing' ? <Loader2 /> : t().toolbar.finish}
                  </button>
                  <button
                    type="button"
                    className="ft-button ft-collapse"
                    aria-label={t().toolbar.collapse}
                    data-tooltip={t().toolbar.collapse}
                    disabled={busy}
                    onClick={() => setCollapsed(true)}
                  >
                    <Minimize2 size={17} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="ft-sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      </div>
    </>
  );
}

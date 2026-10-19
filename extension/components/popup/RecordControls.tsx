import { Fragment, useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Camera, ExternalLink, ListOrdered, Loader2, TriangleAlert } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import InlineAlert from '@/components/shared/InlineAlert';
import OpenEditorButton from '@/components/popup/OpenEditorButton';
import RecordTargetPicker from '@/components/popup/RecordTargetPicker';
import { reportError } from '@/components/shared/report-error';
import { cn } from '@/lib/shared/utils';
import type { RecordingMode, RecordingState } from '@/lib/storage/recording-state';
import { startRecordingIntoProject } from '@/lib/project/project-actions';
import {
  recordingItemCountLabel,
  recordingModeCopy,
} from '@/lib/recording/recording-mode-copy';
import { needsEditorRecovery } from '@/lib/recording/recording-recovery';
import { focusTab } from '@/lib/runtime/navigation';
import { isRecordableTabUrl } from '@/lib/shared/restricted-urls';
import {
  clearCrossTabRecordingDecline,
  hasDeclinedCrossTabRecording,
  markCrossTabRecordingDeclined,
} from '@/lib/runtime/cross-tab-recording';
import { claimPendingStart, discardPendingStart, parkPendingStart } from '@/lib/runtime/pending-start';
import { t } from '@/lib/shared/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  recording: RecordingState;
  onStarted?: () => void;
  onOpenEditor?: () => void | Promise<void>;
  openingEditor?: boolean;
  /** The 「錄到哪裡」 selection (null = 新專案). Pass both to let the parent act on the same target (e.g. reset). */
  targetProjectId?: string | null;
  onTargetProjectChange?: (projectId: string | null) => void;
  className?: string;
}

const MODE_ORDER: readonly RecordingMode[] = ['steps', 'snapshot'];

const MODE_ICONS: Record<RecordingMode, typeof Camera> = {
  steps: ListOrdered,
  snapshot: Camera,
};

/** The record action is the popup's one red sticker; every state of it (idle,
 * starting, editor recovery) shares this shape so the button never jumps. */
const RECORD_BUTTON_CLASS =
  'flex h-12 w-full cursor-pointer items-center justify-center gap-2.5 rounded-md border-2 border-border bg-recording text-base font-bold text-recording-foreground outline-none transition-colors focus-ring hover:bg-recording-hover active:translate-y-px disabled:pointer-events-none disabled:opacity-50';

/** Where the one-time cross-tab (<all_urls>) ask stands. 'unknown' means the
 * mount probe has not resolved yet, so no hint may flash. */
type CrossTabPermission = 'unknown' | 'granted' | 'declined' | 'ungranted';

/**
 * Gathers, via one mount probe, the two facts the start handler needs
 * synchronously before the click: whether the tab is recordable, and where
 * cross-tab permission stands. (Firefox only honours permissions.request as
 * the first await of a direct user-input handler, so there's no room to probe there.)
 */
function useStartPreflight(onProbeError: (message: string) => void) {
  const [crossTab, setCrossTab] = useState<CrossTabPermission>('unknown');
  const [restrictedPage, setRestrictedPage] = useState(false);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;

    // Same check as start() and the background: extension pages (editor,
    // library) genuinely cannot be recorded, so the pre-flight must
    // not enable a start button those layers will reject.
    void browser.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (disposed) return;
        setRestrictedPage(!isRecordableTabUrl(tab?.url));
        setActiveTabId(tab?.id != null && isRecordableTabUrl(tab.url) ? tab.id : null);
      })
      .catch((error) => {
        console.error('[howbeam] failed to inspect the active tab', error);
        if (!disposed) {
          setRestrictedPage(true);
          onProbeError(t().popup.activeTabUnreadable);
        }
      });

    void (async () => {
      try {
        const [granted, declined] = await Promise.all([
          browser.permissions.contains({ origins: ['<all_urls>'] }),
          hasDeclinedCrossTabRecording(),
        ]);
        if (!disposed) setCrossTab(granted ? 'granted' : declined ? 'declined' : 'ungranted');
      } catch (error) {
        console.warn('[howbeam] failed to read the cross-tab recording permission', error);
        if (!disposed) setCrossTab('ungranted');
      }
    })();

    return () => {
      disposed = true;
    };
    // `onProbeError` must be referentially stable (a setState) or the probe
    // re-runs on every render.
  }, [onProbeError]);

  return { crossTab, setCrossTab, restrictedPage, setRestrictedPage, activeTabId };
}

export default function RecordControls({
  recording,
  onStarted,
  onOpenEditor,
  openingEditor = false,
  targetProjectId: controlledTargetProjectId,
  onTargetProjectChange,
  className,
}: Props) {
  const [mode, setMode] = useState<RecordingMode>('steps');
  // null = brand-new project. Never persisted: every popup open starts at 新專案.
  const [localTargetProjectId, setLocalTargetProjectId] = useState<string | null>(null);
  const targetProjectId = controlledTargetProjectId === undefined ? localTargetProjectId : controlledTargetProjectId;
  const setTargetProjectId = useCallback((projectId: string | null) => {
    setLocalTargetProjectId(projectId);
    onTargetProjectChange?.(projectId);
  }, [onTargetProjectChange]);
  const [pending, setPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const { crossTab, setCrossTab, restrictedPage, setRestrictedPage, activeTabId } = useStartPreflight(setControlError);

  /**
   * Must stay the first await in the handler: Firefox only honours
   * permissions.request there. The decline is persisted so the auto-ask fires
   * once; a later grant clears it so a reconsidered user gets asked again.
   */
  async function requestCrossTabPermission(
    resumeStart?: { mode: RecordingMode; tabId: number; projectId: string | null },
  ): Promise<{ granted: boolean; parked: boolean }> {
    try {
      // Not awaited: Firefox needs permissions.request to run synchronously within the click.
      const parking = resumeStart
        ? Promise.all([
            parkPendingStart(resumeStart),
            markCrossTabRecordingDeclined(),
          ]).then(() => true, (error) => {
            console.warn('[howbeam] failed to park the pending recording start', error);
            return false;
          })
        : Promise.resolve(false);
      const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
      const parked = await parking;
      setCrossTab(granted ? 'granted' : 'declined');
      if (granted) await clearCrossTabRecordingDecline();
      else await markCrossTabRecordingDeclined();
      return { granted, parked };
    } catch (error) {
      console.warn('[howbeam] failed to request the cross-tab recording permission', error);
      return { granted: false, parked: false };
    }
  }

  async function start() {
    if (pending || restrictedPage) return;
    setPending(true);
    setControlError(null);
    try {
      // One-time ask at first steps start: the grant itself widens the run's
      // reach (background reads host permissions directly). A decline just
      // continues single-tab. Must be the first await here — see requestCrossTabPermission.
      if (mode === 'steps' && crossTab !== 'granted' && crossTab !== 'declined') {
        const { granted, parked } = await requestCrossTabPermission(
          activeTabId != null ? { mode, tabId: activeTabId, projectId: targetProjectId } : undefined,
        );
        if (granted && parked && !(await claimPendingStart())) {
          onStarted?.();
          return;
        }
        if (!granted) await discardPendingStart();
      }
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!isRecordableTabUrl(activeTab?.url)) {
        setRestrictedPage(true);
        throw new Error(t().popup.restrictedPageError);
      }
      await startRecordingIntoProject(mode, targetProjectId);
      onStarted?.();
    } catch (error) {
      setControlError(reportError('[howbeam] failed to start recording', error, t().popup.startFailed));
    } finally {
      setPending(false);
    }
  }

  async function focusRecordedTab() {
    if (recording.tabId == null) return;
    setControlError(null);
    try {
      // RecordingState carries no windowId, so resolve it first — focusTab
      // only focuses the window when it is told which one.
      const tab = await browser.tabs.get(recording.tabId);
      await focusTab(recording.tabId, tab.windowId);
      window.close();
    } catch (error) {
      setControlError(reportError('[howbeam] failed to return to the recording tab', error, t().popup.returnToTabFailed));
    }
  }

  if (!recording.isRecording && needsEditorRecovery(recording.recoverableError)) {
    const editorFailed = recording.recoverableError?.code === 'EDITOR_OPEN_FAILED';
    return (
      <div className={cn('space-y-3', className)}>
        <OpenEditorButton
          label={editorFailed ? t().popup.retryOpenEditor : t().popup.finishAndOpenEditor}
          pending={openingEditor}
          onOpen={onOpenEditor}
          className={cn(buttonVariants({ size: 'lg' }), 'w-full')}
        />
      </div>
    );
  }

  // START_RECORDING is in flight. Falling through to the idle form here would
  // pair a 「準備中」 header with an enabled start button whose second click
  // fires a duplicate START_RECORDING.
  if (recording.phase === 'starting') {
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        <button type="button" disabled className={RECORD_BUTTON_CLASS}>
          <Loader2 className="size-4 animate-spin" />
          {recordingModeCopy(recording.mode).startingLabel}
        </button>
      </div>
    );
  }

  if (recording.isRecording && recording.runId) {
    // Why the run is on hold or what went wrong, for a user who is not looking at the recorded tab.
    const runError = recording.recoverableError?.message ?? recording.error;
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        {controlError && <InlineAlert>{controlError}</InlineAlert>}
        {runError && runError !== controlError && <InlineAlert>{runError}</InlineAlert>}
        <div className="rounded-md border-2 border-border bg-surface-raised px-3.5 py-3">
          <div className="flex items-center gap-2 text-sm font-bold text-foreground">
            <span className="size-2 rounded-full bg-recording" />
            {recording.phase === 'paused' ? t().common.paused : recordingModeCopy(recording.mode).label}
            {' · '}
            {recordingItemCountLabel(recording.mode, recording.itemCount)}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {t().popup.controlsStayOnPage}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={focusRecordedTab}
            className={cn(buttonVariants(), 'w-full')}
          >
            <ExternalLink className="size-4" />
            {t().popup.returnToRecordingTab}
          </button>
          {/* Secondary exit while a run is live (UX_PLAN 6.4): the editor shows
              what has been captured so far without interrupting the recording,
              which the page controller still owns. */}
          <OpenEditorButton
            label={t().common.openEditor}
            pending={openingEditor}
            onOpen={onOpenEditor}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'w-full')}
          />
        </div>
      </div>
    );
  }

  const activeMode = recordingModeCopy(mode);

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {controlError && <InlineAlert>{controlError}</InlineAlert>}

      <div className="flex flex-col gap-2.5">
        {/* 2px outline + 2px padding puts each option exactly 4px inside, the
            inset the concentric `rounded-sm` radius is drawn for. */}
        <div role="radiogroup" aria-label={t().common.recordingMode} className="flex gap-0.5 rounded-md border-2 border-border bg-secondary p-0.5">
          {MODE_ORDER.map((candidate) => {
            const Icon = MODE_ICONS[candidate];
            const copy = recordingModeCopy(candidate);
            const descriptionId = `record-mode-${candidate}-description`;
            return (
              <Fragment key={candidate}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={mode === candidate}
                      aria-describedby={descriptionId}
                      onClick={() => setMode(candidate)}
                      disabled={pending}
                      className={cn(
                        'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-sm border-2 text-sm font-bold outline-none transition-colors focus-ring',
                        // Pastel fill + ink text in both themes, like every selection.
                        mode === candidate
                          ? 'border-border bg-selected text-on-accent'
                          : 'border-transparent text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      {copy.label}
                    </button>
                  </TooltipTrigger>
                  {/* Visual only: the sibling sr-only span below is the radio's
                      description, so it is announced on focus without waiting
                      for the tooltip and never leaks into the radio's name. */}
                  <TooltipContent side="bottom" sideOffset={6} aria-hidden="true" className="max-w-60 text-center">
                    {copy.description}
                  </TooltipContent>
                </Tooltip>
                <span id={descriptionId} className="sr-only">{copy.description}</span>
              </Fragment>
            );
          })}
        </div>
        <RecordTargetPicker value={targetProjectId} onChange={setTargetProjectId} disabled={pending} />
        {/* Passive affordance, never a nag: shown whenever the grant is absent
            (even after a remembered decline), and the request runs directly in
            the click handler so the browser accepts it as a user gesture. */}
        {mode === 'steps' && (crossTab === 'declined' || crossTab === 'ungranted') && (
          <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">
            {t().popup.singleTabOnly}
            <button
              type="button"
              onClick={() => void requestCrossTabPermission()}
              disabled={pending}
              className="ml-0.5 rounded-sm font-bold text-brand-text underline underline-offset-2 outline-none focus-ring disabled:pointer-events-none"
            >
              {t().popup.enableCrossTab}
            </button>
          </p>
        )}
      </div>

      {/* Says why the button is off and what to do instead, so the disabled
          primary action is never a dead end. */}
      {restrictedPage && (
        <p role="status" className="flex items-start gap-2 rounded-md border-2 border-border bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-foreground">
          <TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
          <span>{t().popup.restrictedPageHint}</span>
        </p>
      )}

      <button
        type="button"
        onClick={start}
        disabled={pending || restrictedPage}
        // A blocked page greys the sticker out entirely; a dimmed red would
        // still read as "ready to record".
        className={cn(
          RECORD_BUTTON_CLASS,
          restrictedPage && 'border-border-soft bg-secondary text-muted-foreground disabled:opacity-100',
        )}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <span className="size-3 rounded-full border-2 border-current bg-current/40" aria-hidden="true" />
        )}
        {pending
          ? activeMode.startingLabel
          : targetProjectId === null
            ? t().common.startRecording
            : t().popup.continueRecording}
      </button>
    </div>
  );
}

import { ExternalLink, Loader2, ShieldCheck, Video, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import ContinuationTabPicker from '@/components/editor/ContinuationTabPicker';
import InlineAlert from '@/components/shared/InlineAlert';
import { t } from '@/lib/shared/i18n';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';
import type { ContinuationTabOption } from '@/lib/editor/editor-app-model';
import type { RecordingMode } from '@/lib/storage/recording-state';
import { recordingModeCopy } from '@/lib/recording/recording-mode-copy';
import { cn } from '@/lib/shared/utils';

const MODE_OPTIONS: readonly RecordingMode[] = ['steps', 'snapshot'];

interface Props {
  open: boolean;
  /** Origin the browser prompt will name. Shown verbatim so the user can compare
   * it against the permission prompt Chrome raises next. */
  sourceOrigin: string;
  /** What the grant is for, e.g. 補拍 or 接續錄製. */
  actionLabel: string;
  pending?: boolean;
  /** Continuation only: opens the explicit 「改在其他頁面接續」 tab picker,
   * which records a user-chosen normal tab without a source grant. */
  onContinueElsewhere?: () => void;
  continueElsewherePending?: boolean;
  continueElsewhereError?: string | null;
  /** Non-null once the elsewhere picker is open: the recordable tabs to choose
   * from, most recently used first. */
  continuationTabs?: ContinuationTabOption[] | null;
  selectedContinuationTabId?: number | null;
  onSelectContinuationTab?: (tabId: number) => void;
  /** Confirms the picked tab and starts recording there. */
  onConfirmContinueElsewhere?: () => void;
  /** When set, the Project has no stored source page: the source-locked confirm
   * is hidden and only the elsewhere path remains, with this reason shown. */
  sourceUnavailableReason?: string | null;
  /** Continuation only: the 1-based step the new steps are inserted after; omitted when they go at the end. */
  insertAfterStep?: number;
  continuationMode?: RecordingMode;
  onContinuationModeChange?: (mode: RecordingMode) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * A modal (not a banner) shows the exact origin and blocks the editor while the browser's own permission prompt appears.
 * The confirm button must stay the direct click source for browser.permissions.request — Chromium requires live transient user activation from that gesture.
 * 改在其他頁面接續 is two-step: the first click opens an explicit tab picker, the second confirms the tab and starts recording.
 */
export default function SourcePermissionDialog({
  open,
  sourceOrigin,
  actionLabel,
  pending = false,
  onContinueElsewhere,
  continueElsewherePending = false,
  continueElsewhereError = null,
  continuationTabs = null,
  selectedContinuationTabId = null,
  onSelectContinuationTab,
  onConfirmContinueElsewhere,
  sourceUnavailableReason = null,
  insertAfterStep,
  continuationMode,
  onContinuationModeChange,
  onCancel,
  onConfirm,
}: Props) {
  const anyPending = pending || continueElsewherePending;
  const pendingShown = useDeferredBusy(pending);
  const continueElsewhereShown = useDeferredBusy(continueElsewherePending);
  const anyShown = pendingShown || continueElsewhereShown;
  const sourceUnavailable = sourceUnavailableReason !== null;
  const pickerOpen = continuationTabs !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !anyPending) onCancel(); }}>
      <DialogContent
        showClose={false}
        onEscapeKeyDown={(event) => anyPending && event.preventDefault()}
        onPointerDownOutside={(event) => anyPending && event.preventDefault()}
        className="w-[min(540px,calc(100vw-32px))] p-6"
      >
        <DialogHeader className="pr-2">
          <DialogTitle className="flex items-center gap-2">
            {pickerOpen || sourceUnavailable ? (
              <Video className="size-5 text-brand-text" aria-hidden="true" />
            ) : (
              <ShieldCheck className="size-5 text-brand-text" aria-hidden="true" />
            )}
            {pickerOpen ? t().editor.permission.pickTab : sourceUnavailable ? actionLabel : t().editor.permission.needsAccess(actionLabel)}
          </DialogTitle>
          <DialogDescription className="leading-6">
            {pickerOpen
              ? t().editor.permission.pickTabBody
              : sourceUnavailable
                ? t().editor.permission.sourceUnavailableBody(sourceUnavailableReason)
                : t().editor.permission.accessBody}
          </DialogDescription>
        </DialogHeader>

        {!pickerOpen && !sourceUnavailable && (
          <p className="mt-4 rounded-md border-2 border-border bg-secondary px-3 py-2.5 font-mono text-xs break-all text-foreground">
            {sourceOrigin}
          </p>
        )}

        {continuationMode !== undefined && onContinuationModeChange && (
          // 2px outline + 2px padding puts each option exactly 4px inside, as `rounded-sm` expects.
          <div role="radiogroup" aria-label={t().common.recordingMode} className="mt-4 flex gap-0.5 rounded-md border-2 border-border bg-secondary p-0.5">
            {MODE_OPTIONS.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={continuationMode === mode}
                disabled={anyShown}
                onClick={() => !anyPending && onContinuationModeChange(mode)}
                className={cn(
                  'flex h-9 flex-1 items-center justify-center rounded-sm border-2 text-sm font-bold outline-none transition-colors focus-ring disabled:pointer-events-none disabled:opacity-50',
                  continuationMode === mode
                    ? 'border-border bg-selected text-on-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {recordingModeCopy(mode).label}
              </button>
            ))}
          </div>
        )}

        {pickerOpen && onSelectContinuationTab && (
          <ContinuationTabPicker
            tabs={continuationTabs}
            selectedTabId={selectedContinuationTabId}
            onSelect={onSelectContinuationTab}
            disabled={anyPending}
          />
        )}

        {onContinueElsewhere && (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {insertAfterStep === undefined ? t().editor.permission.appendNote : t().editor.permission.insertNote(insertAfterStep)}
          </p>
        )}

        {continueElsewhereError && (
          <InlineAlert className="mt-3">{continueElsewhereError}</InlineAlert>
        )}

        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={anyShown} onClick={() => !anyPending && onCancel()}>
            <X />{t().common.cancel}
          </Button>
          {pickerOpen ? (
            <Button
              type="button"
              disabled={anyShown || selectedContinuationTabId === null}
              onClick={() => !anyPending && onConfirmContinueElsewhere?.()}
            >
              {continueElsewhereShown ? <Loader2 className="animate-spin" /> : <Video />}
              {t().common.startRecording}
            </Button>
          ) : (
            <>
              {onContinueElsewhere && (
                <Button
                  type="button"
                  variant={sourceUnavailable ? 'default' : 'outline'}
                  disabled={anyShown}
                  onClick={() => !anyPending && onContinueElsewhere()}
                >
                  {continueElsewhereShown ? <Loader2 className="animate-spin" /> : <ExternalLink />}
                  {t().editor.permission.continueElsewhere}
                </Button>
              )}
              {!sourceUnavailable && (
                <Button type="button" disabled={anyShown} onClick={() => !anyPending && onConfirm()}>
                  {pendingShown && <Loader2 className="animate-spin" />}
                  {pendingShown ? t().editor.permission.authorizing : t().editor.permission.allowAndStart}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

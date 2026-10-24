import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { compositeStepEntry } from '@/lib/export/entry-render';
import { getEntryPrivacyState, type StepEntry } from '@/lib/storage/models';
import { t } from '@/lib/shared/i18n';
import InlineAlert from '@/components/shared/InlineAlert';
import { reportError } from '@/components/shared/report-error';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  entry: StepEntry;
  onDelete: () => Promise<void>;
  onRecapture?: () => Promise<void>;
  deleteDisabled?: boolean;
  operationsDisabled?: boolean;
  recaptureDisabledReason?: string;
}

/** Composites the entry's highlight(s) onto its screenshot and writes the
 * result straight to the clipboard as PNG — same annotate pipeline the ZIP
 * export uses, just a different output format and destination. */
async function copyEntryImage(entry: StepEntry): Promise<void> {
  const blob = await compositeStepEntry(entry, 'image/png');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export default function StepActions({
  entry,
  onDelete,
  onRecapture,
  deleteDisabled = false,
  operationsDisabled = false,
  recaptureDisabledReason,
}: Props) {
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [recapturing, setRecapturing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const privacyReviewRequired = getEntryPrivacyState(entry).reviewRequired;
  const busyShown = useDeferredBusy(copying || deleting || recapturing);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  async function handleCopy() {
    if (copying || operationsDisabled || privacyReviewRequired) {
      if (privacyReviewRequired) setActionError(t().editor.privacyReviewRequiredActionBlocked);
      return;
    }
    setCopying(true);
    setCopied(false);
    setActionError(null);
    try {
      await copyEntryImage(entry);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        setCopied(false);
        copiedTimer.current = null;
      }, 2_000);
    } catch (err) {
      setActionError(reportError('[howbeam] failed to copy image to clipboard', err, t().editor.actions.copyFailed));
    } finally {
      setCopying(false);
    }
  }

  async function handleRecapture() {
    if (!onRecapture || recapturing || operationsDisabled || recaptureDisabledReason) return;
    setRecapturing(true);
    setActionError(null);
    try {
      await onRecapture();
    } catch (err) {
      setActionError(reportError('[howbeam] failed to start recapture', err, t().editor.actions.recaptureStartFailed));
    } finally {
      setRecapturing(false);
    }
  }

  async function handleDelete() {
    if (deleting || deleteDisabled) return;
    setDeleting(true);
    setActionError(null);
    try {
      await onDelete();
    } catch (err) {
      setActionError(reportError('[howbeam] failed to delete step', err, t().editor.actions.deleteFailed));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {/* A 2px outline + 2px padding keeps every button exactly 4px inside, as `rounded-sm` expects.
          Each trigger is a span: a disabled button gets no pointer events, so its reason would never show. */}
      <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                type="button"
                onClick={handleCopy}
                disabled={operationsDisabled || privacyReviewRequired || busyShown}
                aria-label={t().editor.actions.copyImage}
                className="flex size-8 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors focus-ring hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                {copying && busyShown ? <Loader2 className="size-4 animate-spin" /> : copied ? <Check className="size-4 text-brand-text" /> : <Copy className="size-4" />}
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{privacyReviewRequired ? t().editor.privacyReviewTooltip : t().editor.actions.copyImage}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                type="button"
                onClick={() => void handleRecapture()}
                disabled={!onRecapture || operationsDisabled || busyShown || Boolean(recaptureDisabledReason)}
                aria-label={t().editor.actions.recapture}
                className="flex size-8 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors focus-ring hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                {recapturing && busyShown ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{recaptureDisabledReason ?? (operationsDisabled ? t().editor.actions.recaptureUnavailable : t().editor.actions.recapture)}</TooltipContent>
        </Tooltip>
        <span className="mx-0.5 h-5 w-0.5 rounded-full bg-border-soft" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteDisabled || operationsDisabled || busyShown}
                aria-label={t().editor.actions.deleteStep}
                className="flex size-8 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors focus-ring hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
              >
                {deleting && busyShown ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{deleteDisabled ? t().editor.actions.deleteDisabled : t().common.delete}</TooltipContent>
        </Tooltip>
      </div>
      {actionError && <InlineAlert>{actionError}</InlineAlert>}
    </div>
  );
}

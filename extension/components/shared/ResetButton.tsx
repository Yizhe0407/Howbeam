import { Eraser, Loader2 } from 'lucide-react';
import { reportError } from '@/components/shared/report-error';
import { resetSession } from '@/lib/runtime/actions';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import ConfirmationDialog from './ConfirmationDialog';
import { t } from '@/lib/shared/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';

interface Props {
  hasSteps: boolean;
  sessionId: string | null;
  /** Names the project in the confirmation so the target is never implicit. */
  projectTitle?: string;
  disabled?: boolean;
  onReset?: () => void | Promise<void>;
}

export default function ResetButton({
  hasSteps,
  sessionId,
  projectTitle,
  disabled = false,
  onReset,
}: Props) {
  const [resetting, setResetting] = useState(false);
  const resettingShown = useDeferredBusy(resetting);
  const [resetError, setResetError] = useState<string | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  async function handleReset() {
    setResetting(true);
    setResetError(null);
    try {
      if (!sessionId) throw new Error(t().reset.noTarget);
      await resetSession(sessionId);
      await onReset?.();
      setConfirmationOpen(false);
    } catch (err) {
      // The background reports actionable reasons (for example a reset refused
      // mid-recording); surface them instead of flattening to a generic retry.
      const reason = reportError('[howbeam] failed to reset recording', err, '');
      setResetError(reason ? t().reset.failedWithReason(reason) : t().reset.failed);
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      {/* Icon only, as an eraser: the old text "重置" with a circular arrow read as reload. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setResetError(null);
              setConfirmationOpen(true);
            }}
            disabled={!hasSteps || !sessionId || disabled || resettingShown}
            aria-label={resettingShown ? t().reset.pendingLabel : t().reset.actionLabel}
            className="hover:bg-danger-soft hover:text-danger"
          >
            {resettingShown ? <Loader2 className="animate-spin" /> : <Eraser />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{resettingShown ? t().reset.pending : t().reset.label}</TooltipContent>
      </Tooltip>
      <ConfirmationDialog
        open={confirmationOpen}
        title={projectTitle === undefined ? t().reset.dialogTitle : t().reset.dialogTitleNamed(projectTitle)}
        description={t().reset.dialogDescription}
        confirmLabel={t().reset.label}
        pending={resetting}
        // Failure keeps the dialog open for a retry, so the message must live
        // inside the modal; anything rendered behind it is aria-hidden.
        error={resetError}
        onOpenChange={(open) => {
          setConfirmationOpen(open);
          if (!open) setResetError(null);
        }}
        onConfirm={handleReset}
      />
    </>
  );
}

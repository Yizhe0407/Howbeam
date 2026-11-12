import { ExternalLink, Loader2, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import InlineAlert from '@/components/shared/InlineAlert';
import type { RecapturePhase } from '@/lib/storage/recording-state';
import { t } from '@/lib/shared/i18n';

interface Props {
  open: boolean;
  phase: RecapturePhase;
  /** Surfaced inside the dialog because a modal aria-hides the page alert. */
  error?: string | null;
  onFocusSource: () => void;
  onCancel: () => void;
}

/** Recapture takes over the source tab, so a modal blocks editing and keeps only two exits — return to the source tab, or cancel. */
export default function RecaptureProgressDialog({ open, phase, error, onFocusSource, onCancel }: Props) {
  const capturing = phase === 'capturing';

  return (
    <Dialog open={open}>
      <DialogContent
        showClose={false}
        // The workflow owns the editor until the background reports a result; dismissing would hide unreachable state.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="w-[min(420px,calc(100vw-32px))] p-6"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Loader2 className="size-5 animate-spin text-brand-text" aria-hidden="true" />
            {capturing ? t().editor.recapture.capturing : t().editor.recapture.inProgress}
          </DialogTitle>
          <DialogDescription className="leading-6">
            {capturing ? t().editor.recapture.capturingBody : t().editor.recapture.awaitingBody}
          </DialogDescription>
        </DialogHeader>

        {error && <InlineAlert className="mt-4">{error}</InlineAlert>}

        <DialogFooter className="mt-6">
          <Button type="button" variant="ghost" onClick={onCancel}>
            <X />
            {t().editor.recapture.cancel}
          </Button>
          <Button type="button" variant="outline" onClick={onFocusSource}>
            <ExternalLink />
            {t().editor.recapture.returnToSource}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

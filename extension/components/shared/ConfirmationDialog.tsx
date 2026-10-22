import { Loader2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import InlineAlert from '@/components/shared/InlineAlert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { t } from '@/lib/shared/i18n';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';

interface Props {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  pendingLabel?: string;
  confirmVariant?: ComponentProps<typeof Button>['variant'];
  /**
   * Failure feedback rendered inside the dialog. The modal overlay aria-hides
   * the rest of the page, so a failed confirm that keeps the dialog open must
   * report here rather than through a page-level alert behind it.
   */
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

export default function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  pendingLabel = t().common.processing,
  confirmVariant = 'destructive',
  error = null,
  onOpenChange,
  onConfirm,
}: Props) {
  const pendingShown = useDeferredBusy(pending);
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        showClose={false}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
        className="w-[min(420px,calc(100vw-32px))] p-6"
      >
        <DialogHeader className="pr-10">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-6 text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>
        {error && <InlineAlert className="mt-4">{error}</InlineAlert>}
        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={pendingShown} onClick={() => !pending && onOpenChange(false)}>
            {t().common.cancel}
          </Button>
          <Button type="button" variant={confirmVariant} disabled={pendingShown} onClick={() => !pending && void onConfirm()}>
            {pendingShown && <Loader2 className="animate-spin" />}
            {pendingShown ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

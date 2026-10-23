import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import EntryThumbnail from './EntryThumbnail';
import { t } from '@/lib/shared/i18n';
import { getEntryPrivacyState, type StepEntry } from '@/lib/storage/models';

interface Props {
  entries: StepEntry[];
  index: number | null;
  onClose: () => void;
  onNavigate: (entry: StepEntry) => void;
}

/** Full-screen preview with prev/next (buttons + arrow keys) across every
 * timeline entry — ordinary steps and single-image groups alike. */
export default function Lightbox({ entries, index, onClose, onNavigate }: Props) {
  const open = index !== null;
  const entry = index !== null ? entries[index] : null;
  const previous = index !== null ? entries[index - 1] : undefined;
  const next = index !== null ? entries[index + 1] : undefined;

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === 'ArrowRight' && next) {
        e.preventDefault();
        onNavigate(next);
      }
      if (e.key === 'ArrowLeft' && previous) {
        e.preventDefault();
        onNavigate(previous);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, previous, next, onNavigate, onClose]);

  if (!entry || index === null) return null;
  const privacy = getEntryPrivacyState(entry);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent showClose={false} className="fixed inset-0 z-50 flex max-h-none max-w-none translate-x-0 translate-y-0 items-center justify-center rounded-none border-none bg-[rgb(26_23_20/0.92)] p-0 focus:outline-none">
        <DialogTitle className="sr-only">{t().editor.lightbox.title(index + 1)}</DialogTitle>
        <DialogDescription className="sr-only">
          {privacy.reviewRequired
            ? t().editor.privacyReviewRequiredHidden
            : t().editor.lightbox.navigationHint}
        </DialogDescription>

        <Button
          variant="outline"
          size="icon"
          className="fixed top-2 right-2 z-50 size-11 rounded-full sm:top-6 sm:right-6"
          onClick={onClose}
          aria-label={t().editor.lightbox.close}
        >
          <X className="size-5 stroke-[2.5]" />
        </Button>

        <div className="relative flex items-center justify-center">
          <EntryThumbnail
            entry={entry}
            alt={t().editor.lightbox.alt(index + 1)}
            fit="contain"
            className="max-w-full"
            imgClassName="h-auto max-h-[calc(100dvh-10rem)] w-auto max-w-[calc(100vw-7rem)] rounded-md object-contain sm:max-w-[calc(100vw-10rem)]"
          />
        </div>

        {privacy.reviewRequired && (
          <div
            role="alert"
            className="fixed top-1/2 left-1/2 z-50 max-w-[min(80vw,34rem)] -translate-x-1/2 -translate-y-1/2 rounded-md border-2 border-border bg-tamago px-5 py-3.5 text-center text-sm leading-6 font-bold text-on-accent"
          >
            {t().editor.privacyReviewRequiredHidden}
          </div>
        )}

        <Button
          variant="outline"
          size="icon"
          className="fixed inset-y-0 left-2 z-50 my-auto size-11 rounded-full disabled:opacity-30 sm:left-6"
          onClick={() => previous && onNavigate(previous)}
          disabled={!previous}
          aria-label={t().editor.lightbox.previous}
        >
          <ChevronLeft className="size-6" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="fixed inset-y-0 right-2 z-50 my-auto size-11 rounded-full disabled:opacity-30 sm:right-6"
          onClick={() => next && onNavigate(next)}
          disabled={!next}
          aria-label={t().editor.lightbox.next}
        >
          <ChevronRight className="size-6" />
        </Button>

        <div className="fixed bottom-6 left-1/2 z-50 flex h-10 -translate-x-1/2 items-center gap-1.5 rounded-full border-2 border-border bg-card px-5 text-sm font-bold text-foreground tabular-nums">
          <span>{index + 1}</span>
          <span className="text-muted-foreground">/ {entries.length}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

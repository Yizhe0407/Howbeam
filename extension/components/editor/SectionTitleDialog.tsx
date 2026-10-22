import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import InlineAlert from '@/components/shared/InlineAlert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PROJECT_SECTION_LIMITS, sanitizeProjectSectionTitle } from '@/lib/project/project-sections';
import { t } from '@/lib/shared/i18n';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';

/** What the dialog is naming: a new section starting at a step, or an existing one. */
export type SectionDialogRequest =
  | { kind: 'add'; startEntryId: string; step: number }
  | { kind: 'rename'; sectionId: string; title: string };

interface Props {
  /** Null keeps the dialog closed. */
  request: SectionDialogRequest | null;
  onClose: () => void;
  /** Resolves once the title is stored; a rejection keeps the dialog open with the failure shown inside it. */
  onSubmit: (request: SectionDialogRequest, title: string) => Promise<void>;
}

/** The one place a section is named, whether it is being added or renamed. */
export default function SectionTitleDialog({ request, onClose, onSubmit }: Props) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Keyed by the request so every opening starts from its own initial title. */}
      {request && <SectionTitleFields key={requestKey(request)} request={request} onClose={onClose} onSubmit={onSubmit} />}
    </Dialog>
  );
}

function requestKey(request: SectionDialogRequest): string {
  return request.kind === 'add' ? `add:${request.startEntryId}` : `rename:${request.sectionId}`;
}

function SectionTitleFields({ request, onClose, onSubmit }: Props & { request: SectionDialogRequest }) {
  const initialTitle = request.kind === 'rename' ? request.title : '';
  const [draft, setDraft] = useState(initialTitle);
  const [pending, setPending] = useState(false);
  const pendingShown = useDeferredBusy(pending);
  const [failed, setFailed] = useState(false);
  const inputId = useId();
  const copy = t().editor.sections;
  const title = sanitizeProjectSectionTitle(draft);
  const titleChanged = Boolean(title) && title !== initialTitle;
  const canSubmit = titleChanged && !pending;

  async function submit() {
    if (!canSubmit) return;
    setPending(true);
    setFailed(false);
    try {
      await onSubmit(request, title);
    } catch {
      // The page-level banner sits behind this modal, so the failure is shown here too.
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <DialogContent
      showClose={false}
      onEscapeKeyDown={(event) => pending && event.preventDefault()}
      onPointerDownOutside={(event) => pending && event.preventDefault()}
      className="w-[min(420px,calc(100vw-32px))] p-6"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>{request.kind === 'add' ? copy.add : copy.rename}</DialogTitle>
          <DialogDescription className="leading-6">
            {request.kind === 'add' ? copy.addAt(request.step) : copy.renameHint}
          </DialogDescription>
        </DialogHeader>
        <label htmlFor={inputId} className="mt-5 mb-1.5 block text-xs font-bold text-muted-foreground">
          {copy.nameLabel}
        </label>
        <Input
          id={inputId}
          type="text"
          autoFocus
          value={draft}
          maxLength={PROJECT_SECTION_LIMITS.maxTitleLength}
          disabled={pendingShown}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        {failed && (
          <InlineAlert className="mt-4">
            {request.kind === 'add' ? t().editor.mutations.addSection.failed : t().editor.mutations.renameSection.failed}
          </InlineAlert>
        )}
        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={pendingShown} onClick={onClose}>
            {t().common.cancel}
          </Button>
          <Button type="submit" disabled={!titleChanged || pendingShown}>
            {pendingShown && <Loader2 className="animate-spin" />}
            {request.kind === 'add' ? copy.create : t().common.save}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

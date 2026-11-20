import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import InlineAlert from '@/components/shared/InlineAlert';
import { projectDisplayTitle, type ProjectSummary } from '@/lib/storage/models';
import { t } from '@/lib/shared/i18n';
import { useAutoHideScrollbar } from '@/lib/editor/use-auto-hide-scrollbar';

interface Props {
  open: boolean;
  /** Projects in no Series; one leaves the list once it is added. */
  projects: readonly ProjectSummary[];
  disabled: boolean;
  onClose: () => void;
  /** Resolves false when the Project was not added. */
  onAdd: (projectId: string) => Promise<boolean>;
}

/** Adds Projects to the open Series one click each, staying open for the next. */
export default function AddProjectsDialog({ open, projects, disabled, onClose, onAdd }: Props) {
  const copy = t().library.series;
  const scrollbar = useAutoHideScrollbar<HTMLUListElement>();
  const [failed, setFailed] = useState(false);

  async function add(projectId: string) {
    setFailed(false);
    // The page-level banner sits behind this modal, so the failure is shown here too.
    if (!(await onAdd(projectId))) setFailed(true);
  }

  function close() {
    setFailed(false);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent showClose={false} className="w-[min(420px,calc(100vw-32px))] p-6" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{copy.addProjects}</DialogTitle>
        </DialogHeader>
        {projects.length === 0 ? (
          <p className="mt-5 text-sm text-muted-foreground">{copy.noProjectsToAdd}</p>
        ) : (
          <ul {...scrollbar} className="app-scrollbar-autohide mt-5 flex max-h-80 flex-col gap-2 overflow-y-auto">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void add(project.id)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-md border-2 border-border-soft bg-card px-3 text-left text-sm font-bold text-foreground outline-none transition-colors focus-ring hover:border-border hover:bg-secondary disabled:opacity-60"
                >
                  <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-words">{projectDisplayTitle(project.title)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t().library.stepCount(project.entryCount)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {failed && <InlineAlert className="mt-4">{t().library.operationFailed}</InlineAlert>}
        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" onClick={close}>{t().common.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

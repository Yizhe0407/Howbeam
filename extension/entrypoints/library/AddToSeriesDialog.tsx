import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { SeriesWithProjects } from '@/lib/project/library-items';
import { projectDisplayTitle, type ProjectSummary } from '@/lib/storage/models';
import { SERIES_LIMITS, sanitizeSeriesTitle, seriesDisplayTitle } from '@/lib/storage/series-model';
import { t } from '@/lib/shared/i18n';
import { useAutoHideScrollbar } from '@/lib/editor/use-auto-hide-scrollbar';

interface Props {
  /** The Project being placed; null keeps the dialog closed. */
  project: ProjectSummary | null;
  series: readonly SeriesWithProjects[];
  onClose: () => void;
  onAdd: (seriesId: string) => void;
  onCreate: (title: string) => void;
}

/** Puts a Project into an existing Series, or into a new one named here. */
export default function AddToSeriesDialog({ project, series, onClose, onAdd, onCreate }: Props) {
  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && onClose()}>
      {project && <Fields key={project.id} project={project} series={series} onClose={onClose} onAdd={onAdd} onCreate={onCreate} />}
    </Dialog>
  );
}

function Fields({ project, series, onClose, onAdd, onCreate }: Props & { project: ProjectSummary }) {
  const [draft, setDraft] = useState('');
  const title = sanitizeSeriesTitle(draft);
  const copy = t().library.series;
  const scrollbar = useAutoHideScrollbar<HTMLUListElement>();
  return (
    <DialogContent showClose={false} className="w-[min(420px,calc(100vw-32px))] p-6">
      <DialogHeader>
        <DialogTitle>{copy.addToSeries}</DialogTitle>
        <DialogDescription className="break-words">{projectDisplayTitle(project.title)}</DialogDescription>
      </DialogHeader>
      {series.length > 0 && (
        <ul {...scrollbar} className="app-scrollbar-autohide mt-5 flex max-h-72 flex-col gap-2 overflow-y-auto">
          {series.map((entry) => (
            <li key={entry.series.id}>
              <button
                type="button"
                onClick={() => onAdd(entry.series.id)}
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md border-2 border-border-soft bg-card px-3 text-left text-sm font-bold text-foreground outline-none transition-colors focus-ring hover:border-border hover:bg-secondary"
              >
                <span className="min-w-0 break-words">{seriesDisplayTitle(entry.series.title)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{copy.projectCount(entry.projects.length)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (title) onCreate(title);
        }}
      >
        <Input
          type="text"
          aria-label={copy.newSeriesPlaceholder}
          placeholder={copy.newSeriesPlaceholder}
          value={draft}
          maxLength={SERIES_LIMITS.maxTitleLength}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" disabled={!title}>{copy.createConfirm}</Button>
      </form>
      <DialogFooter className="mt-6">
        <Button type="button" variant="outline" onClick={onClose}>{t().common.cancel}</Button>
      </DialogFooter>
    </DialogContent>
  );
}

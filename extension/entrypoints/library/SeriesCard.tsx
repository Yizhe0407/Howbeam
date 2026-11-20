import { Download, Layers, Ungroup } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import EditableTitle from '@/components/shared/EditableTitle';
import type { SeriesWithProjects } from '@/lib/project/library-items';
import { SERIES_LIMITS } from '@/lib/storage/series-model';
import { t } from '@/lib/shared/i18n';
import CardIconButton from './CardIconButton';
import ProjectCover from './ProjectCover';
import { CARD_CLASS, CARD_HEADING_CLASS } from './ProjectCard';

interface Props {
  entry: SeriesWithProjects;
  meta: string;
  locked: boolean;
  lockedTitle: (title: string) => string;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onExport: () => void;
  onDissolve: () => void;
}

/** A Series in the Library grid: its first Project's cover on a stack, and the way into the Series. */
export default function SeriesCard({ entry, meta, locked, lockedTitle, onOpen, onRename, onExport, onDissolve }: Props) {
  const { series, projects } = entry;
  const first = projects[0];
  return (
    <li className={CARD_CLASS}>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onOpen}
        disabled={locked}
        className="relative cursor-pointer bg-secondary px-4 pt-4 disabled:cursor-default"
      >
        {/* Two offset sheets behind the cover read as "several projects". */}
        <span className="absolute inset-x-8 top-1 h-6 rounded-t-md border-2 border-b-0 border-border-soft bg-muted" />
        <span className="absolute inset-x-6 top-2.5 h-6 rounded-t-md border-2 border-b-0 border-border-soft bg-card" />
        <span className="relative block overflow-hidden rounded-t-md border-2 border-b-0 border-border bg-card">
          {first ? (
            <ProjectCover projectId={first.id} revision={first.updatedAt} />
          ) : (
            <span className="block aspect-[16/9] w-full" />
          )}
        </span>
        <Badge className="absolute top-2 left-2 bg-tamago text-on-accent">
          <Layers />
          {t().library.series.label}
        </Badge>
      </button>
      <div className="flex flex-1 flex-col gap-2.5 border-t-2 border-border p-4">
        <h2 className={CARD_HEADING_CLASS}>
          <EditableTitle
            value={series.title}
            maxLength={SERIES_LIMITS.maxTitleLength}
            fallback={t().library.series.untitled}
            label={t().library.series.titleLabel}
            disabled={locked}
            onCommit={onRename}
            lines={2}
          />
        </h2>
        <p className="text-xs font-bold text-muted-foreground">{meta}</p>
        <div className="flex-1" />
        <div className="mt-1 flex items-center gap-1 border-t-2 border-border-soft pt-3">
          <Button size="sm" className="min-w-0 flex-1" onClick={onOpen} disabled={locked}>
            {t().common.open}
          </Button>
          <CardIconButton
            label={t().library.series.exportTitle}
            tooltip={lockedTitle(t().library.series.export)}
            onClick={onExport}
            disabled={locked || projects.length === 0}
          >
            <Download />
          </CardIconButton>
          <CardIconButton
            label={t().library.series.dissolve}
            tooltip={lockedTitle(t().library.series.dissolve)}
            danger
            onClick={onDissolve}
            disabled={locked}
          >
            <Ungroup />
          </CardIconButton>
        </div>
      </div>
    </li>
  );
}

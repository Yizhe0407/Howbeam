import { Archive, CopyPlus, FolderPlus, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import EditableTitle from '@/components/shared/EditableTitle';
import { projectDisplayTitle, type ProjectSummary } from '@/lib/storage/models';
import { PERSISTED_PROJECT_LIMITS } from '@/lib/storage/persistence-limits';
import { t } from '@/lib/shared/i18n';
import CardIconButton from './CardIconButton';
import ProjectCover from './ProjectCover';

export const CARD_CLASS = 'group flex flex-col overflow-hidden rounded-md border-2 border-border bg-card transition-transform duration-200 hover:-translate-y-0.5';
export const CARD_HEADING_CLASS = '-ml-1.5 flex min-w-0 text-base leading-snug font-bold text-foreground';

interface Props {
  project: ProjectSummary;
  meta: string;
  /** This card's own action is in flight. */
  pending: boolean;
  /** Every action is unavailable (a recording, or another action in flight). */
  locked: boolean;
  /** Tooltip copy while another card's action holds the lock. */
  lockedTitle: (title: string) => string;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onDuplicate: () => void;
  onAddToSeries: () => void;
  onExport: () => void;
  onDelete: () => void;
}

export default function ProjectCard({
  project,
  meta,
  pending,
  locked,
  lockedTitle,
  onOpen,
  onRename,
  onDuplicate,
  onAddToSeries,
  onExport,
  onDelete,
}: Props) {
  const title = projectDisplayTitle(project.title);
  return (
    <li className={CARD_CLASS}>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onOpen}
        disabled={locked}
        className="cursor-pointer disabled:cursor-default"
      >
        <ProjectCover projectId={project.id} revision={project.updatedAt} />
      </button>
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <h2 className={CARD_HEADING_CLASS}>
          <EditableTitle
            value={project.title}
            maxLength={PERSISTED_PROJECT_LIMITS.maxTitleLength}
            fallback={t().common.untitledProject}
            label={t().editor.projectTitle.label}
            disabled={locked}
            onCommit={onRename}
            lines={2}
          />
        </h2>
        {project.description && (
          <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
            {project.description}
          </p>
        )}
        <p className="text-xs font-bold text-muted-foreground">{meta}</p>
        <div className="flex-1" />
        <div className="mt-1 flex items-center gap-1 border-t-2 border-border-soft pt-3">
          <Button size="sm" className="min-w-0 flex-1" onClick={onOpen} disabled={locked}>
            {pending && <Loader2 className="animate-spin" />}{t().common.open}
          </Button>
          <CardIconButton label={t().common.duplicate} tooltip={lockedTitle(t().common.duplicate)} onClick={onDuplicate} disabled={locked}>
            <CopyPlus />
          </CardIconButton>
          <CardIconButton
            label={t().library.series.addToSeriesLabel(title)}
            tooltip={lockedTitle(t().library.series.addToSeries)}
            onClick={onAddToSeries}
            disabled={locked}
          >
            <FolderPlus />
          </CardIconButton>
          <CardIconButton
            label={t().library.exportProjectLabel(title)}
            tooltip={lockedTitle(t().library.exportArchiveTooltip)}
            onClick={onExport}
            disabled={locked}
          >
            <Archive />
          </CardIconButton>
          <CardIconButton label={t().common.delete} tooltip={lockedTitle(t().common.delete)} danger onClick={onDelete} disabled={locked}>
            <Trash2 />
          </CardIconButton>
        </div>
      </div>
    </li>
  );
}

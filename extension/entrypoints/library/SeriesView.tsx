import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CircleMinus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DashedOutline } from '@/components/ui/dashed-outline';
import EditableTitle from '@/components/shared/EditableTitle';
import PageHeading from '@/components/shared/PageHeading';
import SortableItem, { SortableOverlay, StaticHandle } from '@/components/editor/SortableItem';
import { useSortableReorder, verticalListModifiers } from '@/lib/editor/dnd';
import type { SeriesWithProjects } from '@/lib/project/library-items';
import { projectDisplayTitle, type ProjectSummary } from '@/lib/storage/models';
import { PERSISTED_PROJECT_LIMITS } from '@/lib/storage/persistence-limits';
import { SERIES_LIMITS } from '@/lib/storage/series-model';
import { t } from '@/lib/shared/i18n';
import CardIconButton from './CardIconButton';
import ProjectCover from './ProjectCover';
import AddProjectsDialog from './AddProjectsDialog';

interface Props {
  entry: SeriesWithProjects;
  /** Projects in no Series, offered by 加入專案. */
  addable: readonly ProjectSummary[];
  locked: boolean;
  onBack: () => void;
  onRename: (title: string) => Promise<void>;
  onOpenProject: (projectId: string) => void;
  onRenameProject: (projectId: string, title: string) => Promise<void>;
  /** Resolves false when the Project was not added. */
  onAddProject: (projectId: string) => Promise<boolean>;
  onRemoveProject: (projectId: string) => void;
  /** Resolves false when the new order was not stored. */
  onReorder: (projectIds: string[]) => Promise<boolean>;
}

/** One Series: its Projects in order, which a drag rearranges. */
export default function SeriesView({
  entry,
  addable,
  locked,
  onBack,
  onRename,
  onOpenProject,
  onRenameProject,
  onAddProject,
  onRemoveProject,
  onReorder,
}: Props) {
  const copy = t().library.series;
  const [adding, setAdding] = useState(false);
  // Holds a dropped order until the stored one arrives, so the row does not jump back meanwhile.
  const [dropped, setDropped] = useState<ProjectSummary[] | null>(null);
  const storedOrder = entry.projects.map((project) => project.id).join('\n');
  useEffect(() => setDropped(null), [storedOrder]);
  const projects = dropped ?? entry.projects;

  const { sensors, accessibility, handlers, itemIds, overlayHost, setOverlayHost, previewPositionOf } = useSortableReorder(
    projects,
    (project) => project.id,
    async (reordered) => {
      setDropped(reordered);
      if (!(await onReorder(reordered.map((project) => project.id)))) setDropped(null);
    },
    { disabled: locked, itemNoun: t().sortable.projectNoun, logLabel: '[howbeam] failed to reorder series' },
  );

  return (
    <>
      <PageHeading
        parent="library"
        onParent={onBack}
        className="mb-6"
        title={(
          <span className="-ml-1.5 flex min-w-0">
            <EditableTitle
              value={entry.series.title}
              maxLength={SERIES_LIMITS.maxTitleLength}
              fallback={copy.untitled}
              label={copy.titleLabel}
              disabled={locked}
              onCommit={onRename}
              lines={2}
            />
          </span>
        )}
        description={copy.projectCount(projects.length)}
      />
      <div className="mb-4 flex">
        <Button variant="outline" onClick={() => setAdding(true)} disabled={locked}>
          <Plus />{copy.addProjects}
        </Button>
      </div>

      {projects.length === 0 ? (
        <div className="relative flex min-h-40 items-center justify-center rounded-md bg-card px-6 py-10 text-sm text-muted-foreground">
          <DashedOutline radius={8} />
          {copy.empty}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          {...handlers}
          accessibility={accessibility}
          modifiers={verticalListModifiers}
        >
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col gap-2.5">
              {projects.map((project) => (
                <SortableItem key={project.id} id={project.id} disabled={locked} overlayHost={overlayHost}>
                  {(handle, overlay) => {
                    const position = previewPositionOf(project.id);
                    const title = projectDisplayTitle(project.title);
                    return (
                      <div className="flex items-center gap-3 rounded-md border-2 border-border bg-card p-2.5 pr-3">
                        {overlay && createPortal(
                          <div className="flex size-full items-center gap-3 rounded-md border-2 border-border bg-card p-2.5 pr-3">
                            <StaticHandle />
                            <span className="w-7 text-center text-base font-bold text-brand-text">{position}</span>
                            <span className="min-w-0 flex-1 truncate text-base font-bold text-foreground">{title}</span>
                          </div>,
                          overlay,
                        )}
                        {handle}
                        <span className="w-7 shrink-0 text-center text-base font-bold text-brand-text">{position}</span>
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-hidden="true"
                          onClick={() => onOpenProject(project.id)}
                          disabled={locked}
                          className="hidden w-28 shrink-0 cursor-pointer overflow-hidden rounded-sm border-2 border-border disabled:cursor-default sm:block [&>div]:border-b-0"
                        >
                          <ProjectCover projectId={project.id} revision={project.updatedAt} />
                        </button>
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="-ml-1.5 flex min-w-0 text-base leading-snug font-bold text-foreground">
                            <EditableTitle
                              value={project.title}
                              maxLength={PERSISTED_PROJECT_LIMITS.maxTitleLength}
                              fallback={t().common.untitledProject}
                              label={t().editor.projectTitle.label}
                              disabled={locked}
                              onCommit={(next) => onRenameProject(project.id, next)}
                              lines={2}
                            />
                          </span>
                          <span className="text-xs font-bold text-muted-foreground">{t().library.stepCount(project.entryCount)}</span>
                        </span>
                        <Button size="sm" onClick={() => onOpenProject(project.id)} disabled={locked}>
                          {t().common.open}
                        </Button>
                        <CardIconButton
                          label={copy.removeFromSeriesLabel(title)}
                          tooltip={copy.removeFromSeries}
                          onClick={() => onRemoveProject(project.id)}
                          disabled={locked}
                        >
                          <CircleMinus />
                        </CardIconButton>
                      </div>
                    );
                  }}
                </SortableItem>
              ))}
            </ol>
          </SortableContext>
          <SortableOverlay onHost={setOverlayHost} />
        </DndContext>
      )}

      <AddProjectsDialog
        open={adding}
        projects={addable}
        disabled={locked}
        onClose={() => setAdding(false)}
        onAdd={onAddProject}
      />
    </>
  );
}

import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';
import { type Step } from '@/lib/storage/models';
import { useSortableReorder, verticalListModifiers } from '@/lib/editor/dnd';
import { useStepDescriptionAutosave } from '@/lib/editor/editor-autosave';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import DescriptionDraftRecoveries from './DescriptionDraftRecoveries';
import DescriptionSaveIssue from './DescriptionSaveIssue';
import SortableItem, { SortableOverlay, StaticHandle } from './SortableItem';
import { t } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';
import { useAutoHideScrollbar } from '@/lib/editor/use-auto-hide-scrollbar';
import { DashedOutline } from '@/components/ui/dashed-outline';

interface RowProps {
  step: Step;
  index: number;
  /** The number shown on the badge, which follows a drag in progress. */
  position: number;
  onDelete: (step: Step) => Promise<void>;
  deleteDisabled: boolean;
  dragHandle: ReactNode;
  /** Where to draw this row's moving copy while it is dragged. */
  overlay: HTMLElement | null;
}

function NumberBadge({ value }: { value: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-border bg-recording text-xs font-bold text-recording-foreground">
      {value}
    </span>
  );
}

/** One marker. Deleting it takes the row off the list at once; a failed delete
 * brings it back and is reported with the editor's other edits. */
function AnnotationRow({ step, index, position, onDelete, deleteDisabled, dragHandle, overlay }: RowProps) {
  const {
    description,
    setDescription,
    saveIssue,
    savedDescription,
    keepSaved,
    recoveries,
    restoreRecovery,
    discardRecovery,
    flush,
    confirmOverwrite,
  } = useStepDescriptionAutosave(step);

  function handleDelete() {
    if (deleteDisabled) return;
    void onDelete(step).catch((error) => console.error('[howbeam] failed to delete annotation', error));
  }

  return (
    <div className="group flex flex-col rounded-md border-2 border-border bg-surface-raised px-3 py-2.5">
      {overlay && createPortal(
        <div className="flex size-full items-start rounded-md border-2 border-border bg-surface-raised px-3 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <NumberBadge value={position} />
            <span className={cn('min-w-0 flex-1 truncate px-1.5 py-1 text-sm', description ? 'text-foreground' : 'text-muted-foreground')}>
              {description || t().editor.annotations.placeholder}
            </span>
            <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground"><Trash2 className="size-3.5" /></span>
            <StaticHandle />
          </div>
        </div>,
        overlay,
      )}
      <div className="flex items-center gap-3">
        <NumberBadge value={position} />
        <input
          type="text"
          aria-label={t().editor.annotations.descriptionLabel(index + 1)}
          value={description}
          maxLength={PERSISTED_STEP_LIMITS.maxAnnotationDescriptionLength}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => void flush().catch(() => undefined)}
          disabled={deleteDisabled}
          placeholder={t().editor.annotations.placeholder}
          className="min-w-0 flex-1 rounded-md border-none bg-transparent px-1.5 py-1 text-sm text-foreground outline-none focus-ring placeholder:text-muted-foreground"
        />
        <div className="flex shrink-0 items-center gap-0.5 opacity-80 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                // The row leaves the list on the first press and the next row slides under the pointer,
                // so a double click's second press must not delete that one too.
                onClick={(event) => {
                  if (event.detail <= 1) handleDelete();
                }}
                onPointerDown={(event) => event.preventDefault()}
                disabled={deleteDisabled}
                aria-label={t().editor.annotations.delete(index + 1)}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors focus-ring hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{deleteDisabled ? t().editor.annotations.deleteDisabled : t().editor.annotations.deleteTooltip}</TooltipContent>
          </Tooltip>
          {dragHandle}
        </div>
      </div>
      <DescriptionSaveIssue
        issue={saveIssue}
        savedDescription={savedDescription}
        onOverwrite={confirmOverwrite}
        onKeepSaved={keepSaved}
        disabled={deleteDisabled}
        className="mt-2 ml-9"
      />
      <DescriptionDraftRecoveries
        recoveries={recoveries}
        onRestore={restoreRecovery}
        onDiscard={discardRecovery}
        onConfirmOverwrite={() => confirmOverwrite()}
        disabled={deleteDisabled}
        className="mt-2 ml-9"
      />
    </div>
  );
}

interface Props {
  annotations: Step[];
  numbered?: boolean;
  onSetNumbered?: (numbered: boolean) => void;
  onDelete: (step: Step) => Promise<void>;
  onReorder: (reordered: Step[]) => Promise<void>;
  editingDisabled?: boolean;
}

export default function AnnotationList({
  annotations,
  numbered = false,
  onSetNumbered,
  onDelete,
  onReorder,
  editingDisabled = false,
}: Props) {
  const scrollbar = useAutoHideScrollbar<HTMLDivElement>();
  const { sensors, accessibility, handlers, itemIds, overlayHost, setOverlayHost, previewPositionOf } = useSortableReorder(
    annotations,
    (step) => step.id,
    onReorder,
    {
      disabled: editingDisabled,
      itemNoun: t().sortable.annotationNoun,
      logLabel: '[howbeam] failed to reorder snapshot annotations',
    },
  );

  if (annotations.length === 0) {
    return <p className="relative rounded-md p-4 text-sm text-muted-foreground"><DashedOutline radius={8} />{t().editor.annotations.empty}</p>;
  }

  return (
    <div className="flex h-full w-full shrink-0 flex-col overflow-hidden rounded-md border-2 border-border bg-card">
      <div className="flex shrink-0 items-center justify-between border-b-2 border-border-soft px-4 py-3">
        <span className="text-xs font-bold text-muted-foreground">
          {t().editor.annotations.count(annotations.length)}
        </span>
        <label className="flex cursor-pointer items-center gap-2.5 text-xs font-bold text-muted-foreground select-none">
          {t().editor.annotations.numbering}
          <Switch
            checked={numbered}
            onCheckedChange={(checked) => onSetNumbered?.(checked)}
            disabled={editingDisabled || !onSetNumbered}
          />
        </label>
      </div>
      <div {...scrollbar} className="app-scrollbar-autohide min-h-0 flex-1 overflow-y-auto p-3">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          {...handlers}
          accessibility={accessibility}
          modifiers={verticalListModifiers}
        >
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            <ul className="flex flex-col gap-2">
              {annotations.map((step, index) => (
                <SortableItem key={step.id} id={step.id} disabled={editingDisabled} overlayHost={overlayHost}>
                  {(handle, overlay) => (
                    <AnnotationRow
                      step={step}
                      index={index}
                      position={previewPositionOf(step.id)}
                      onDelete={onDelete}
                      deleteDisabled={editingDisabled}
                      dragHandle={handle}
                      overlay={overlay}
                    />
                  )}
                </SortableItem>
              ))}
            </ul>
          </SortableContext>
          <SortableOverlay onHost={setOverlayHost} />
        </DndContext>
      </div>
    </div>
  );
}

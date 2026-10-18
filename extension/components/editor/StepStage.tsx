import { useState } from 'react';
import { Bookmark, Loader2, Pencil, Plus, PencilRuler, X, ZoomIn } from 'lucide-react';
import { entryId, getEntryPrivacyState, type Step, type StepEntry } from '@/lib/storage/models';
import ImageEditWorkspace from './ImageEditWorkspace';
import { Badge } from '@/components/ui/badge';
import { DashedOutline } from '@/components/ui/dashed-outline';
import { cn } from '@/lib/shared/utils';
import { tagHueClass } from '@/lib/shared/tag-hue';
import EntryThumbnail from './EntryThumbnail';
import StepActions from './StepActions';
import DescriptionField from './DescriptionField';
import AnnotationList from './AnnotationList';
import TagSelectDialog from './TagSelectDialog';
import EditableTitle from '@/components/shared/EditableTitle';
import InlineAlert from '@/components/shared/InlineAlert';
import { reportError } from '@/components/shared/report-error';
import { recordingItemCountLabel, recordingModeCopy } from '@/lib/recording/recording-mode-copy';
import { t } from '@/lib/shared/i18n';

interface Props {
  entry: StepEntry;
  index: number;
  /** The section this entry falls under, if any. */
  sectionTitle?: string;
  /** Present when a section can start at this entry. */
  onStartSection?: () => void;
  projectTitle?: string;
  projectTags?: readonly string[];
  onTitleChange?: (title: string) => Promise<void>;
  /** Tag edits are single add/remove operations, merged into the stored list. */
  onAddTag?: (tag: string) => Promise<void>;
  onRemoveTag?: (tag: string) => Promise<void>;
  onChange: () => void | Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteAnnotation: (step: Step) => Promise<void>;
  onZoom: () => void;
  onReorderAnnotations: (reordered: Step[]) => Promise<void>;
  onRecapture: () => Promise<void>;
  onSetNumbered: (entryId: string, next: boolean) => Promise<void>;
  editingDisabled?: boolean;
}

export default function StepStage({
  entry,
  index,
  sectionTitle,
  onStartSection,
  projectTitle,
  projectTags = [],
  onTitleChange,
  onAddTag,
  onRemoveTag,
  onChange,
  onDelete,
  onDeleteAnnotation,
  onZoom,
  onReorderAnnotations,
  onRecapture,
  onSetNumbered,
  editingDisabled = false,
}: Props) {
  const [numberingPending, setNumberingPending] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const privacy = getEntryPrivacyState(entry);
  const [imageEditorOpen, setImageEditorOpen] = useState(false);

  const displayTags = projectTags;

  // Adding rethrows so the tag dialog shows the failure inline while open (a stage banner
  // would sit behind the modal); removing happens on the chip row, which uses `stageError`.
  async function addTag(tag: string): Promise<void> {
    if (!onAddTag) return;
    setStageError(null);
    await onAddTag(tag);
  }

  async function removeTag(tag: string): Promise<void> {
    if (!onRemoveTag) return;
    setStageError(null);
    try {
      await onRemoveTag(tag);
    } catch (tagError) {
      setStageError(reportError('[stepmark] failed to update project tags', tagError, t().editor.stage.tagSaveFailed));
    }
  }

  const titleAndTagRow = (
    <>
      <div className="mb-4 flex shrink-0 flex-col gap-3 border-b-2 border-border-soft pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 w-full items-center gap-1.5 sm:max-w-[45%]">
          <EditableTitle
            value={projectTitle ?? ''}
            fallback={t().common.untitledProject}
            label={t().editor.stage.titleLabel}
            disabled={editingDisabled || !onTitleChange}
            onCommit={(title) => onTitleChange?.(title)}
            onCommitError={(titleError) => {
              setStageError(reportError('[stepmark] failed to rename project', titleError, t().editor.stage.titleSaveFailed));
            }}
            className="w-fit min-w-[8ch] max-w-[calc(100%-1.75rem)] rounded-md border-2 border-transparent px-2 py-1 text-[22px] leading-tight font-bold text-foreground transition-colors focus-ring hover:border-border-soft focus:border-border focus:bg-card [field-sizing:content]"
          />
          <Pencil className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="app-scrollbar flex max-h-[84px] min-w-0 flex-wrap items-center gap-2 overflow-y-auto pr-1 sm:max-w-[55%] sm:justify-end">
          {displayTags.map((tag) => (
            <Badge key={tag} variant="tagEditable" className={cn('max-w-full select-none', tagHueClass(tag))}>
              <span className="min-w-0 truncate">{tag}</span>
              <button
                type="button"
                onClick={() => void removeTag(tag)}
                aria-label={t().editor.stage.removeTag(tag)}
                disabled={editingDisabled}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-on-accent outline-none transition-colors focus-ring hover:bg-on-accent hover:text-card disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="size-3 stroke-[2.5]" />
              </button>
            </Badge>
          ))}
          <Badge asChild variant="tagAction" className="disabled:opacity-50">
            <button
              type="button"
              onClick={() => setTagDialogOpen(true)}
              disabled={editingDisabled}
            >
              <DashedOutline radius="full" outset={2} hideOnHover />
              <Plus className="size-3.5 stroke-[2.5]" />
              {t().editor.stage.tagButton}
            </button>
          </Badge>
        </div>
      </div>

      <TagSelectDialog
        open={tagDialogOpen}
        selectedTags={projectTags}
        onOpenChange={setTagDialogOpen}
        onAddTag={addTag}
      />
    </>
  );

  async function setNumbered(next: boolean) {
    if (entry.kind !== 'group' || numberingPending || editingDisabled) return;
    setNumberingPending(true);
    setStageError(null);
    try {
      await onSetNumbered(entryId(entry), next);
    } catch (err) {
      setStageError(reportError('[stepmark] failed to update annotation numbering', err, t().editor.stage.numberingSaveFailed));
    } finally {
      setNumberingPending(false);
    }
  }

  const headerRow = (
    <div className="flex shrink-0 items-center justify-between gap-3 mb-3.5">
      <div className="flex min-w-0 items-center gap-2">
        {sectionTitle && (
          <span
            title={t().editor.sections.current(sectionTitle)}
            className="flex min-w-0 max-w-[16rem] items-center gap-1 rounded-full border-2 border-border bg-matcha px-2.5 py-0.5 text-xs font-bold text-on-accent"
          >
            <Bookmark className="size-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">{t().editor.sections.current(sectionTitle)}</span>
            <span aria-hidden="true" className="min-w-0 truncate">{sectionTitle}</span>
          </span>
        )}
        <span className="shrink-0 rounded-full border-2 border-border bg-secondary px-2.5 py-0.5 text-xs font-bold text-foreground">
          {/* Names entries with the same vocabulary as the popup and recording toolbar. */}
          {entry.kind === 'single'
            ? recordingModeCopy('steps').label
            : `${recordingModeCopy('snapshot').label} · ${recordingItemCountLabel('snapshot', entry.annotations.length)}`}
        </span>
        {/* Sits with the section chip: a section is where this step stands in the document, not an image action. */}
        {onStartSection && (
          <Badge asChild variant="tagAction" className="shrink-0 disabled:opacity-50">
            <button
              type="button"
              onClick={onStartSection}
              disabled={editingDisabled}
              title={t().editor.rail.addSectionAt(index + 1)}
            >
              <DashedOutline radius="full" outset={2} hideOnHover />
              <Plus className="size-3.5 stroke-[2.5]" />
              {t().editor.rail.addSectionHere}
            </button>
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-3">
        {numberingPending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label={t().editor.stage.savingNumbering} />}
        {/* Also the way out of a pending mask review: the editor is where masks are checked and confirmed. */}
        <button
          type="button"
          onClick={() => setImageEditorOpen(true)}
          disabled={editingDisabled}
          className="flex h-10 items-center gap-1.5 rounded-md border-2 border-border bg-card px-3 text-xs font-bold text-foreground outline-none transition-colors focus-ring hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
        >
          <PencilRuler className="size-4" />
          {privacy.reviewRequired ? t().editor.imageEdit.openReview : t().editor.imageEdit.open}
        </button>
        <StepActions
          entry={entry}
          onDelete={onDelete}
          onRecapture={onRecapture}
          deleteDisabled={editingDisabled}
          operationsDisabled={editingDisabled}
          recaptureDisabledReason={
            entry.kind === 'group' && entry.annotations.length !== 1
              ? t().editor.multiAnnotationRecaptureBlocked
              : undefined
          }
        />
      </div>
    </div>
  );

  const zoomHint = (
    <span className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1 rounded-full border-2 border-border bg-card px-2.5 py-1 text-xs font-bold text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
      <ZoomIn className="size-3.5" />
      {t().editor.stage.zoomHint}
    </span>
  );

  const errorNotice = stageError && <InlineAlert>{stageError}</InlineAlert>;

  const privacyReviewNotice = privacy.reviewRequired && (
    <div role="alert" className="rounded-md border-2 border-border bg-warning-soft px-3.5 py-2.5 text-sm text-foreground">
      {t().editor.privacyReviewRequiredNotice}
    </div>
  );

  function imageFrame(alt: string) {
    return (
      <button
        type="button"
        onClick={onZoom}
        aria-label={t().editor.stage.zoomImage}
        className="group relative flex w-full cursor-zoom-in items-center justify-center rounded-md border-none bg-transparent outline-none focus-ring lg:h-full lg:max-h-full lg:max-w-full"
      >
        <EntryThumbnail
          entry={entry}
          alt={alt}
          fit="contain"
          className="max-w-full lg:h-full lg:max-h-full"
          imgClassName="block h-auto w-auto max-w-full rounded-md object-contain outline-2 outline-border lg:max-h-full"
          overlay={zoomHint}
        />
      </button>
    );
  }

  const imageEditor = imageEditorOpen && (
    <ImageEditWorkspace
      entry={entry}
      number={index + 1}
      onClose={() => {
        setImageEditorOpen(false);
        // The editor wrote its changes straight to storage; load them into the screen once.
        void Promise.resolve(onChange()).catch((reloadError) => {
          setStageError(reportError('[stepmark] failed to reload after image edits', reloadError, t().editor.imageEdit.saveFailed));
        });
      }}
    />
  );

  if (entry.kind === 'single') {
    return (
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto bg-background px-4 pt-4 pb-6 sm:px-6 lg:overflow-hidden lg:px-10 lg:pt-5 lg:pb-16">
        <div className="flex w-full max-w-[1180px] flex-none flex-col gap-3 lg:min-h-0 lg:flex-1">
          <div className="flex-none">{titleAndTagRow}</div>
          <div className="flex-none">{headerRow}</div>
          {errorNotice && <div className="flex-none">{errorNotice}</div>}
          {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
          <div className="flex w-full flex-none items-center justify-center p-1 lg:min-h-0 lg:flex-1">
            {imageFrame(t().editor.stage.stepAlt(index + 1))}
          </div>
          <div className="flex-none">
            <DescriptionField
              key={entry.step.id}
              step={entry.step}
              onChange={onChange}
              disabled={editingDisabled}
            />
          </div>
        </div>
        {imageEditor}
      </main>
    );
  }

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-background px-4 pt-4 pb-6 sm:px-6 lg:overflow-hidden lg:px-10 lg:pt-5 lg:pb-16">
      <div className="flex-none">{titleAndTagRow}</div>
      <div className="flex-none">{headerRow}</div>
      {errorNotice && <div className="flex-none">{errorNotice}</div>}
      {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
      <div className="flex flex-none flex-col gap-5 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-[22px]">
        <div className="flex min-w-0 flex-none items-center justify-center p-1 lg:min-h-0 lg:flex-1">
          {imageFrame(t().editor.stage.snapshotAlt(index + 1))}
        </div>
        <aside className="flex min-h-[280px] w-full shrink-0 flex-col gap-2.5 lg:min-h-0 lg:w-[380px]">
          <AnnotationList
            annotations={entry.annotations}
            numbered={entry.anchor.numbered ?? false}
            onSetNumbered={(next) => setNumbered(next)}
            numberingPending={numberingPending}
            onChange={onChange}
            onDelete={onDeleteAnnotation}
            onReorder={onReorderAnnotations}
            editingDisabled={editingDisabled}
          />
        </aside>
      </div>
      {imageEditor}
    </main>
  );
}

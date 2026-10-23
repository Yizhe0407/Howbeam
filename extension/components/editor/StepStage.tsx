import { useState } from 'react';
import { Bookmark, Pencil, Plus, PencilRuler, ZoomIn } from 'lucide-react';
import { entryId, getEntryPrivacyState, type Step, type StepEntry } from '@/lib/storage/models';
import ImageEditWorkspace from './ImageEditWorkspace';
import { Badge } from '@/components/ui/badge';
import { DashedOutline } from '@/components/ui/dashed-outline';
import EntryThumbnail from './EntryThumbnail';
import StepActions from './StepActions';
import DescriptionField from './DescriptionField';
import AnnotationList from './AnnotationList';
import EditableTitle from '@/components/shared/EditableTitle';
import InlineAlert from '@/components/shared/InlineAlert';
import { reportError } from '@/components/shared/report-error';
import { PERSISTED_PROJECT_LIMITS } from '@/lib/storage/persistence-limits';
import { t } from '@/lib/shared/i18n';

interface Props {
  entry: StepEntry;
  index: number;
  /** The section this entry falls under, if any. */
  sectionTitle?: string;
  /** Present when a section can start at this entry. */
  onStartSection?: () => void;
  projectTitle?: string;
  onTitleChange?: (title: string) => Promise<void>;
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
  onTitleChange,
  onDelete,
  onDeleteAnnotation,
  onZoom,
  onReorderAnnotations,
  onRecapture,
  onSetNumbered,
  editingDisabled = false,
}: Props) {
  const [stageError, setStageError] = useState<string | null>(null);
  const privacy = getEntryPrivacyState(entry);
  const [imageEditorOpen, setImageEditorOpen] = useState(false);

  const titleRow = (
    <div className="mb-4 flex shrink-0 items-center gap-1.5 border-b-2 border-border-soft pb-4">
      <EditableTitle
        value={projectTitle ?? ''}
        maxLength={PERSISTED_PROJECT_LIMITS.maxTitleLength}
        fallback={t().common.untitledProject}
        label={t().editor.stage.titleLabel}
        disabled={editingDisabled || !onTitleChange}
        onCommit={(title) => onTitleChange?.(title)}
        onCommitError={(titleError) => {
          setStageError(reportError('[howbeam] failed to rename project', titleError, t().editor.stage.titleSaveFailed));
        }}
        className="w-fit min-w-[8ch] max-w-[calc(100%-1.75rem)] rounded-md border-2 border-transparent px-2 py-1 text-[22px] leading-tight font-bold text-foreground transition-colors focus-ring hover:border-border-soft focus:border-border focus:bg-card [field-sizing:content]"
      />
      <Pencil className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </div>
  );

  function setNumbered(next: boolean) {
    if (entry.kind !== 'group' || editingDisabled) return;
    setStageError(null);
    // The switch flips at once; a failed save is reported with the editor's other edits.
    void onSetNumbered(entryId(entry), next).catch((err) => {
      setStageError(reportError('[howbeam] failed to update annotation numbering', err, t().editor.stage.numberingSaveFailed));
    });
  }

  const headerRow = (
    <div className="mb-3.5 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-center gap-2">
        {sectionTitle && (
          <span
            title={t().editor.sections.current(sectionTitle)}
            // No outline: in this UI an ink outline marks something you can press, and this only labels.
            className="flex min-w-0 max-w-[16rem] items-center gap-1 rounded-full bg-matcha px-3 py-1 text-xs font-bold text-on-accent"
          >
            <Bookmark className="size-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">{t().editor.sections.current(sectionTitle)}</span>
            <span aria-hidden="true" className="min-w-0 truncate">{sectionTitle}</span>
          </span>
        )}
        {/* Sits with the section chip: a section is where this step stands in the document, not an image action. */}
        {onStartSection && (
          <Badge asChild variant="dashedAction" className="shrink-0 disabled:opacity-50">
            <button
              type="button"
              onClick={onStartSection}
              disabled={editingDisabled}
              title={t().editor.sections.addAt(index + 1)}
            >
              <DashedOutline radius="full" outset={2} hideOnHover />
              <Plus className="size-3.5 stroke-[2.5]" />
              {t().editor.sections.add}
            </button>
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-3">
        {/* Also the way out of a pending mask review: the editor is where masks are checked and confirmed. */}
        <button
          type="button"
          onClick={() => setImageEditorOpen(true)}
          disabled={editingDisabled}
          className="flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border-2 border-border bg-card px-3 text-xs font-bold text-foreground outline-none transition-colors focus-ring hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
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
      // Its saves reach this screen through the change broadcast like any other write.
      onClose={() => setImageEditorOpen(false)}
    />
  );

  if (entry.kind === 'single') {
    return (
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto bg-background px-[var(--content-gutter,1rem)] pt-4 pb-[var(--notice-lane,5rem)] lg:pt-5">
        <div className="flex w-full max-w-[1180px] flex-none flex-col gap-3 lg:min-h-0 lg:flex-1">
          <div className="flex-none">{titleRow}</div>
          <div className="flex-none">{headerRow}</div>
          {errorNotice && <div className="flex-none">{errorNotice}</div>}
          {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
          <div className="flex w-full flex-none items-center justify-center p-1 lg:min-h-[14rem] lg:flex-1">
            {imageFrame(t().editor.stage.stepAlt(index + 1))}
          </div>
          <div className="flex-none">
            <DescriptionField
              key={entry.step.id}
              step={entry.step}
              disabled={editingDisabled}
            />
          </div>
        </div>
        {imageEditor}
      </main>
    );
  }

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-background px-[var(--content-gutter,1rem)] pt-4 pb-[var(--notice-lane,5rem)] lg:pt-5">
      <div className="flex-none">{titleRow}</div>
      <div className="flex-none">{headerRow}</div>
      {errorNotice && <div className="flex-none">{errorNotice}</div>}
      {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
      <div className="flex flex-none flex-col gap-5 lg:min-h-[14rem] lg:flex-1 lg:flex-row lg:gap-[22px]">
        <div className="flex min-w-0 flex-none items-center justify-center p-1 lg:min-h-0 lg:flex-1">
          {imageFrame(t().editor.stage.snapshotAlt(index + 1))}
        </div>
        <aside className="flex min-h-[280px] w-full shrink-0 flex-col gap-2.5 lg:min-h-0 lg:w-[380px]">
          <AnnotationList
            annotations={entry.annotations}
            numbered={entry.anchor.numbered ?? false}
            onSetNumbered={setNumbered}
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

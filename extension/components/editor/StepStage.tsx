import { useState } from 'react';
import { PencilRuler, ZoomIn } from 'lucide-react';
import { getEntryPrivacyState, type Step, type StepEntry } from '@/lib/storage/models';
import ImageEditWorkspace from './ImageEditWorkspace';
import EntryPreview from './EntryPreview';
import StepActions from './StepActions';
import SectionChip, { type SectionChipSection } from './SectionChip';
import DescriptionField from './DescriptionField';
import StepTitleField from './StepTitleField';
import AnnotationList from './AnnotationList';
import { t } from '@/lib/shared/i18n';

interface Props {
  entry: StepEntry;
  index: number;
  /** The section this entry falls under, if any. */
  section?: SectionChipSection;
  /** Present when a section can start at this entry. */
  onStartSection?: () => void;
  onRenameSection?: (sectionId: string) => void;
  onDeleteSection?: (sectionId: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onDeleteAnnotation: (step: Step) => Promise<void>;
  onZoom: () => void;
  onReorderAnnotations: (reordered: Step[]) => Promise<void>;
  onRecapture: () => Promise<void>;
  editingDisabled?: boolean;
}

export default function StepStage({
  entry,
  index,
  section,
  onStartSection,
  onRenameSection,
  onDeleteSection,
  onDelete,
  onDeleteAnnotation,
  onZoom,
  onReorderAnnotations,
  onRecapture,
  editingDisabled = false,
}: Props) {
  const privacy = getEntryPrivacyState(entry);
  const [imageEditorOpen, setImageEditorOpen] = useState(false);

  const owner = entry.kind === 'single' ? entry.step : entry.anchor;

  // One row for everything above the image, the step's title included, so the screenshot gets the rest of the height.
  const headerRow = (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
      {/* Sits before the title: a section is where this step stands in the document, not an image action. */}
      {(section || onStartSection) && (
        <SectionChip
          section={section}
          step={index + 1}
          onStartSection={onStartSection}
          onRenameSection={onRenameSection}
          onDeleteSection={onDeleteSection}
          disabled={editingDisabled}
        />
      )}
      <div className="min-w-[12rem] flex-1">
        {/* Keyed by the row, so switching steps never carries one step's draft into another. */}
        <StepTitleField key={owner.id} step={owner} number={index + 1} disabled={editingDisabled} />
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

  // Lives in the thumbnail's overlay slot, which is exactly the image's box, so only the image itself zooms.
  const zoomTarget = (
    <button
      type="button"
      onClick={onZoom}
      aria-label={t().editor.stage.zoomImage}
      className="group pointer-events-auto absolute inset-0 cursor-zoom-in rounded-md border-none bg-transparent outline-none focus-ring"
    >
      <span className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1 rounded-full border-2 border-border bg-card px-2.5 py-1 text-xs font-bold text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <ZoomIn className="size-3.5" />
        {t().editor.stage.zoomHint}
      </span>
    </button>
  );

  const descriptionField = <DescriptionField key={owner.id} step={owner} disabled={editingDisabled} />;

  const privacyReviewNotice = privacy.reviewRequired && (
    <div role="alert" className="rounded-md border-2 border-border bg-warning-soft px-3.5 py-2.5 text-sm text-foreground">
      {t().editor.privacyReviewRequiredNotice}
    </div>
  );

  function imageFrame(alt: string) {
    return (
      <div className="relative flex w-full items-center justify-center lg:h-full lg:max-h-full lg:max-w-full">
        <EntryPreview
          entry={entry}
          alt={alt}
          fit="contain"
          className="max-w-full lg:h-full lg:max-h-full"
          imgClassName="block h-auto w-auto max-w-full rounded-md object-contain outline-2 outline-border lg:max-h-full"
          overlay={zoomTarget}
        />
      </div>
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

  // Below lg the stage scrolls, so its end keeps the notice lane clear to scroll out from under the floating notices.
  // From lg it fits the window and nothing scrolls, so the description sits at the bottom with the same margin as the top.
  if (entry.kind === 'single') {
    return (
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto bg-background px-[var(--content-gutter,1rem)] pt-4 pb-[var(--notice-lane,5rem)] lg:py-5">
        <div className="flex w-full max-w-[1180px] flex-none flex-col gap-3 lg:min-h-0 lg:flex-1">
          <div className="flex-none">{headerRow}</div>
          {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
          <div className="flex w-full flex-none items-center justify-center p-1 lg:min-h-[14rem] lg:flex-1">
            {imageFrame(t().editor.stage.stepAlt(index + 1))}
          </div>
          <div className="flex-none">{descriptionField}</div>
        </div>
        {imageEditor}
      </main>
    );
  }

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-background px-[var(--content-gutter,1rem)] pt-4 pb-[var(--notice-lane,5rem)] lg:py-5">
      <div className="flex-none">{headerRow}</div>
      {privacyReviewNotice && <div className="flex-none">{privacyReviewNotice}</div>}
      <div className="flex flex-none flex-col gap-5 lg:min-h-[14rem] lg:flex-1 lg:flex-row lg:gap-[22px]">
        <div className="flex min-w-0 flex-none items-center justify-center p-1 lg:min-h-0 lg:flex-1">
          {imageFrame(t().editor.stage.snapshotAlt(index + 1))}
        </div>
        <aside className="flex min-h-[280px] w-full shrink-0 flex-col gap-2.5 lg:min-h-0 lg:w-[380px]">
          <AnnotationList
            annotations={entry.annotations}
            onDelete={onDeleteAnnotation}
            onReorder={onReorderAnnotations}
            editingDisabled={editingDisabled}
          />
        </aside>
      </div>
      <div className="flex-none">{descriptionField}</div>
      {imageEditor}
    </main>
  );
}

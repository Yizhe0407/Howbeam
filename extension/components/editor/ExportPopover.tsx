import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import PdfExportOptions from '@/components/editor/PdfExportOptions';
import InlineAlert from '@/components/shared/InlineAlert';
import { generateProjectHtml } from '@/lib/export/project-export-html';
import { generateProjectMarkdownArchive } from '@/lib/export/project-export-markdown';
import { generateProjectPdf } from '@/lib/export/project-export-pdf';
import { projectExportFilename, type ProjectExportMetadata } from '@/lib/export/project-export-contract';
import { DEFAULT_PDF_EXPORT_SETTINGS, type PdfExportSettings } from '@/lib/export/pdf-export-settings';
import { type StepEntry } from '@/lib/storage/models';
import { EditingBlockedError } from '@/lib/editor/editor-app-model';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import {
  DownloadFailedError,
  RedactionReviewRequiredError,
  StepImageError,
} from '@/lib/export/export-errors';
import { t } from '@/lib/shared/i18n';
import { isAbortError, throwIfAborted } from '@/lib/shared/abort';
import { useAutoHideScrollbar } from '@/lib/editor/use-auto-hide-scrollbar';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';

type ProjectEntriesSnapshot = {
  entries: readonly StepEntry[];
  metadata?: ProjectExportMetadata;
};

type ProjectEntriesProvider = (
  signal: AbortSignal,
) =>
  | readonly StepEntry[]
  | ProjectEntriesSnapshot
  | Promise<readonly StepEntry[] | ProjectEntriesSnapshot>;

export type ExportPopoverProps = {
  /** The control that opens the panel; the header owns its look and when it is disabled. */
  trigger: ReactNode;
  /** Runs the export as the editor's one data operation of the moment, so the
   * Project can't change under it. Rejects with EditingBlockedError when the
   * Project can't be touched at all. */
  runExport: <T>(task: () => Promise<T>) => Promise<T>;
  /** Resolves the entries (and optionally fresher metadata) to publish. */
  getProjectEntries: ProjectEntriesProvider;
  metadata?: ProjectExportMetadata;
  /** Resolves `null` when there was nothing to export (so nothing was downloaded). */
  onExportImages?: (signal: AbortSignal) => unknown | Promise<unknown>;
};

type PublicationAction = 'pdf' | 'html' | 'markdown' | 'images';
type DownloadPublicationAction = Exclude<PublicationAction, 'images'>;

const FORMATS: readonly PublicationAction[] = ['pdf', 'html', 'markdown', 'images'];

/** Each format's title, label, description and outcome copy, read at render
 * time so it follows the active locale. */
function publicationCopy(action: PublicationAction) {
  return t().editor.publish[action];
}

/** Space between the header's bottom edge and the panel. */
const PANEL_GAP = 8;

/**
 * Where the panel hangs from: the header's bottom edge, at the trigger's right
 * edge. A virtual anchor as wide as the trigger and no taller than a line, so the
 * panel clears the header's border by `PANEL_GAP` whatever the header or the
 * trigger measure.
 */
function useHeaderAnchor(trigger: { current: HTMLElement | null }) {
  return useRef({
    getBoundingClientRect: () => {
      const button = trigger.current?.getBoundingClientRect() ?? new DOMRect();
      const edge = trigger.current?.closest('header')?.getBoundingClientRect().bottom ?? button.bottom;
      return new DOMRect(button.x, edge, button.width, 0);
    },
  });
}

/** Step numbers beyond this many are summarised so the message stays short. */
const MAX_LISTED_STEPS = 6;

/** The message for a failed export: what actually went wrong, not a blanket
 * "check the masks" for failures that have nothing to do with masks. */
function failureMessage(action: PublicationAction, error: unknown): string {
  const copy = t().editor.publish;
  if (error instanceof StepImageError) return copy.stepImageFailed(error.ordinal);
  if (error instanceof RedactionReviewRequiredError && error.ordinals.length > 0) {
    const listed = error.ordinals.slice(0, MAX_LISTED_STEPS).join(', ');
    return copy.reviewRequired(error.ordinals.length > MAX_LISTED_STEPS ? `${listed}…` : listed);
  }
  if (error instanceof DownloadFailedError) return copy.downloadFailed;
  if (error instanceof EditingBlockedError) return t().editor.publishBusy;
  return copy[action].failed;
}

function isProjectEntriesSnapshot(
  value: readonly StepEntry[] | ProjectEntriesSnapshot,
): value is ProjectEntriesSnapshot {
  return !Array.isArray(value);
}

/**
 * The export panel anchored to the header's Export button: pick a format, set
 * that format's options, download. An export is the editor's one data operation
 * while it runs, and the panel ignores outside clicks meanwhile, so nothing can
 * change or abort it by accident; Escape or the Cancel button stops it.
 */
export default function ExportPopover(props: ExportPopoverProps) {
  const { trigger, runExport, metadata = {}, onExportImages } = props;
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<PublicationAction>('pdf');
  const [pdfSettings, setPdfSettings] = useState<PdfExportSettings>(DEFAULT_PDF_EXPORT_SETTINGS);
  const [pendingAction, setPendingAction] = useState<PublicationAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchor = useHeaderAnchor(triggerRef);
  const descriptionId = useId();
  const scrollbar = useAutoHideScrollbar<HTMLDivElement>();
  const busy = pendingAction !== null;
  // `busy` guards the export; only how it looks waits until the export proves slow.
  const busyShown = useDeferredBusy(busy);

  useEffect(() => () => activeController.current?.abort(), []);
  useEffect(() => {
    if (open) {
      setError(null);
      setNotice(null);
    }
  }, [open]);

  function cancelExport() {
    activeController.current?.abort();
  }

  async function resolveProjectEntries(signal: AbortSignal): Promise<ProjectEntriesSnapshot> {
    const result = await props.getProjectEntries(signal);
    throwIfAborted(signal);

    const snapshot = isProjectEntriesSnapshot(result)
      ? { entries: result.entries, metadata: result.metadata ?? metadata }
      : { entries: result, metadata };
    if (snapshot.entries.length === 0) throw new Error('No project entries are available.');
    return snapshot;
  }

  async function runAction(
    action: PublicationAction,
    task: (signal: AbortSignal) => Promise<'nothing' | void>,
  ) {
    if (activeController.current) return;

    const controller = new AbortController();
    activeController.current = controller;
    setPendingAction(action);
    setError(null);
    setNotice(null);

    try {
      const outcome = await runExport(() => task(controller.signal));
      throwIfAborted(controller.signal);
      // The browser shows the download itself; only an export that produced nothing needs saying.
      setNotice(outcome === 'nothing' ? t().editor.publish.nothingExported : null);
    } catch (actionError) {
      if (!isAbortError(actionError) && !controller.signal.aborted) {
        console.error(`[howbeam] project export failed: ${action}`, actionError);
        setError(failureMessage(action, actionError));
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
      setPendingAction(null);
    }
  }

  function downloadProject(action: DownloadPublicationAction) {
    void runAction(
      action,
      async (signal) => {
        const snapshot = await resolveProjectEntries(signal);
        switch (action) {
          // downloadBlobViaBrowser resolves only once the browser has queued the transfer,
          // which survives this page closing, so the success notice below is always accurate.
          case 'markdown': {
            const archive = await generateProjectMarkdownArchive(snapshot.entries, snapshot.metadata, { signal });
            throwIfAborted(signal);
            await downloadBlobViaBrowser(
              archive.blob,
              projectExportFilename(snapshot.metadata, 'markdown-archive'),
              { signal },
            );
            return;
          }

          case 'html': {
            const html = await generateProjectHtml(snapshot.entries, snapshot.metadata, { signal });
            throwIfAborted(signal);
            await downloadBlobViaBrowser(
              html,
              projectExportFilename(snapshot.metadata, 'html'),
              { signal },
            );
            return;
          }

          case 'pdf': {
            const pdf = await generateProjectPdf(snapshot.entries, snapshot.metadata, { signal, settings: pdfSettings });
            throwIfAborted(signal);
            await downloadBlobViaBrowser(pdf, projectExportFilename(snapshot.metadata, 'pdf'), { signal });
            return;
          }
        }
      },
    );
  }

  function exportImages() {
    if (!onExportImages) return;
    void runAction(
      'images',
      async (signal) => {
        // exportImagesAsZip resolves null when no image could be exported.
        return (await onExportImages(signal)) === null ? 'nothing' : undefined;
      },
    );
  }

  function download() {
    if (format === 'images') exportImages();
    else downloadProject(format);
  }

  const copy = publicationCopy(format);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      <PopoverTrigger ref={triggerRef} asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={PANEL_GAP}
        aria-label={t().editor.publish.title}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (!busy) return;
          event.preventDefault();
          cancelExport();
        }}
        className="flex max-h-[calc(100vh-96px)] w-[360px] max-w-[calc(100vw-32px)] flex-col overflow-hidden p-0"
      >
        {/* The auto-hide scrollbar reserves a 10px gutter on both edges, so 6px of padding keeps the 16px inset the footer uses. */}
        <div {...scrollbar} className="app-scrollbar-autohide min-h-0 flex-1 overflow-y-auto px-1.5 py-4">
          <RadioGroup
            aria-label={t().editor.publish.format}
            aria-describedby={descriptionId}
            value={format}
            onValueChange={(next) => setFormat(next as PublicationAction)}
            disabled={busyShown}
            className="flex gap-0 overflow-hidden rounded-md border-2 border-border bg-surface-raised"
          >
            {FORMATS.map((action) => (
              <RadioGroupItem
                key={action}
                value={action}
                disabled={action === 'images' && !onExportImages}
                className="min-w-0 flex-1 truncate rounded-none border-0 border-r-2 px-1.5 py-2 text-[13px] font-bold last:border-r-0"
              >
                {publicationCopy(action).tab}
              </RadioGroupItem>
            ))}
          </RadioGroup>
          <p id={descriptionId} className="mt-3 break-words text-[13px] text-muted-foreground">{copy.description}</p>

          {format === 'pdf' && <PdfExportOptions settings={pdfSettings} onChange={setPdfSettings} disabled={busyShown} />}
        </div>

        <div className="shrink-0 border-t-2 border-border p-4">
          <div aria-live="polite" aria-atomic="true" className="empty:hidden mb-3">
            {error && <InlineAlert>{error}</InlineAlert>}
            {!error && notice && (
              <p role="status" className="rounded-md border-2 border-border bg-brand-bg-soft px-3.5 py-2.5 text-xs font-bold text-foreground">
                {notice}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              className="min-w-0 flex-1"
              disabled={busyShown || (format === 'images' && !onExportImages)}
              onClick={download}
            >
              {busyShown ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
              <span className="truncate">{busyShown ? t().editor.publish.exporting : copy.label}</span>
            </Button>
            {busyShown && (
              <Button variant="outline" onClick={cancelExport}>
                {t().common.cancel}
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

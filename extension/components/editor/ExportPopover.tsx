import { useRef, useState, type ReactNode } from 'react';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import PdfExportOptions from '@/components/editor/PdfExportOptions';
import { ExportActions, ExportFormatTabs } from '@/components/editor/ExportControls';
import { useExportRunner, type RunExport } from '@/components/editor/use-export-runner';
import { generateProjectHtml } from '@/lib/export/project-export-html';
import { generateProjectMarkdownArchive } from '@/lib/export/project-export-markdown';
import { generateProjectPdf } from '@/lib/export/project-export-pdf';
import { projectExportFilename, type ProjectExportMetadata } from '@/lib/export/project-export-contract';
import { DEFAULT_PDF_EXPORT_SETTINGS, type PdfExportSettings } from '@/lib/export/pdf-export-settings';
import { type StepEntry } from '@/lib/storage/models';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import type { PublicationAction } from '@/lib/export/export-failure';
import { t } from '@/lib/shared/i18n';
import { throwIfAborted } from '@/lib/shared/abort';
import { useAutoHideScrollbar } from '@/lib/editor/use-auto-hide-scrollbar';

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
  runExport: RunExport;
  /** Resolves the entries (and optionally fresher metadata) to publish. */
  getProjectEntries: ProjectEntriesProvider;
  metadata?: ProjectExportMetadata;
  /** Resolves `null` when there was nothing to export (so nothing was downloaded). */
  onExportImages?: (signal: AbortSignal) => unknown | Promise<unknown>;
};

type DownloadPublicationAction = Exclude<PublicationAction, 'images'>;

const FORMATS: readonly PublicationAction[] = ['pdf', 'html', 'markdown', 'images'];

/** Each format's title, label and outcome copy, read at render
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
  const exporter = useExportRunner(runExport, () => t().editor.publish.nothingExported);
  const { busy, busyShown } = exporter;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchor = useHeaderAnchor(triggerRef);
  const scrollbar = useAutoHideScrollbar<HTMLDivElement>();

  async function resolveProjectEntries(signal: AbortSignal): Promise<ProjectEntriesSnapshot> {
    const result = await props.getProjectEntries(signal);
    throwIfAborted(signal);

    const snapshot = isProjectEntriesSnapshot(result)
      ? { entries: result.entries, metadata: result.metadata ?? metadata }
      : { entries: result, metadata };
    if (snapshot.entries.length === 0) throw new Error('No project entries are available.');
    return snapshot;
  }

  function downloadProject(action: DownloadPublicationAction) {
    void exporter.run(
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
    void exporter.run(
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
        // Each opening starts without the last export's outcome.
        if (next) exporter.reset();
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
          exporter.cancel();
        }}
        className="flex max-h-[calc(100vh-96px)] w-[360px] max-w-[calc(100vw-32px)] flex-col overflow-hidden p-0"
      >
        {/* The auto-hide scrollbar reserves a 10px gutter on both edges, so 6px of padding keeps the 16px inset the footer uses. */}
        <div {...scrollbar} className="app-scrollbar-autohide min-h-0 flex-1 overflow-y-auto px-1.5 py-4">
          <ExportFormatTabs
            formats={FORMATS}
            value={format}
            onChange={setFormat}
            disabled={busyShown}
            isUnavailable={(action) => action === 'images' && !onExportImages}
          />

          {format === 'pdf' && <PdfExportOptions settings={pdfSettings} onChange={setPdfSettings} disabled={busyShown} />}
        </div>

        <div className="shrink-0 border-t-2 border-border p-4">
          <ExportActions
            error={exporter.error}
            notice={exporter.notice}
            busyShown={busyShown}
            label={copy.label}
            disabled={format === 'images' && !onExportImages}
            onDownload={download}
            onCancel={exporter.cancel}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

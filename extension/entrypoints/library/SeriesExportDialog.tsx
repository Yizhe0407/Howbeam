import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PdfExportOptions from '@/components/editor/PdfExportOptions';
import { ExportActions, ExportCardGroup, ExportFormatTabs, PagesGlyph } from '@/components/editor/ExportControls';
import { useExportRunner, type RunExport } from '@/components/editor/use-export-runner';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import { DEFAULT_PDF_EXPORT_SETTINGS, type PdfExportSettings } from '@/lib/export/pdf-export-settings';
import { generateSeriesExport, type SeriesExportFormat, type SeriesExportMode } from '@/lib/export/series-export';
import { throwIfAborted } from '@/lib/shared/abort';
import { seriesDisplayTitle, type ProjectSeries } from '@/lib/storage/series-model';
import { t } from '@/lib/shared/i18n';
import { useAutoHideScrollbar } from '@/lib/editor/use-auto-hide-scrollbar';

const FORMATS: readonly SeriesExportFormat[] = ['pdf', 'html', 'markdown'];

interface Props {
  /** The Series to export; null keeps the dialog closed. */
  series: ProjectSeries | null;
  runExport: RunExport;
  onClose: () => void;
}

/** Exports a Series as one document, or as one file per Project in a ZIP. */
export default function SeriesExportDialog({ series, runExport, onClose }: Props) {
  return (
    <Dialog open={series !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Keyed so each opening starts without the last export's outcome. */}
      {series && <Panel key={series.id} series={series} runExport={runExport} />}
    </Dialog>
  );
}

function Panel({ series, runExport }: Omit<Props, 'onClose'> & { series: ProjectSeries }) {
  const copy = t().library.series;
  const [mode, setMode] = useState<SeriesExportMode>('merged');
  const [format, setFormat] = useState<SeriesExportFormat>('pdf');
  const [pdfSettings, setPdfSettings] = useState<PdfExportSettings>(DEFAULT_PDF_EXPORT_SETTINGS);
  const exporter = useExportRunner(runExport, () => copy.exportNothing);
  const title = seriesDisplayTitle(series.title);
  const scrollbar = useAutoHideScrollbar<HTMLDivElement>();

  function download() {
    void exporter.run(format, async (signal) => {
      const file = await generateSeriesExport({ title }, series.projectIds, format, mode, { signal, pdfSettings });
      if (!file) return 'nothing';
      throwIfAborted(signal);
      // Resolves once the browser has queued the transfer, which survives this page closing.
      await downloadBlobViaBrowser(file.blob, file.filename, { signal });
      return undefined;
    });
  }

  return (
    <DialogContent
      showClose={!exporter.busy}
      // A running export is stopped on purpose (Escape or Cancel), never by a stray click.
      onEscapeKeyDown={(event) => {
        if (!exporter.busy) return;
        event.preventDefault();
        exporter.cancel();
      }}
      onPointerDownOutside={(event) => exporter.busy && event.preventDefault()}
      className="flex max-h-[calc(100vh-32px)] w-[min(420px,calc(100vw-32px))] flex-col p-6"
    >
      <DialogHeader>
        <DialogTitle>{copy.exportTitle}</DialogTitle>
        <DialogDescription className="break-words">{title}</DialogDescription>
      </DialogHeader>
      {/* The PDF options make the body tall, so it scrolls between the fixed title and buttons.
          The auto-hide scrollbar reserves 10px on both edges; the negative margin keeps the content aligned. */}
      <div {...scrollbar} className="app-scrollbar-autohide -mx-2.5 mt-5 min-h-0 flex-1 overflow-y-auto">
        <ExportCardGroup
          label={copy.exportMode}
          value={mode}
          onSelect={setMode}
          disabled={exporter.busyShown}
          cards={[
            { value: 'merged', label: copy.exportMerged, glyph: <PagesGlyph pages={1} /> },
            { value: 'separate', label: copy.exportSeparate, glyph: <PagesGlyph pages={2} /> },
          ]}
        />
        <div className="mt-4">
          <ExportFormatTabs formats={FORMATS} value={format} onChange={setFormat} disabled={exporter.busyShown} />
        </div>
        {format === 'pdf' && <PdfExportOptions settings={pdfSettings} onChange={setPdfSettings} disabled={exporter.busyShown} />}
      </div>
      <div className="mt-6 shrink-0">
        <ExportActions
          error={exporter.error}
          notice={exporter.notice}
          busyShown={exporter.busyShown}
          label={mode === 'merged' ? t().editor.publish[format].label : copy.exportLabel}
          onDownload={download}
          onCancel={exporter.cancel}
        />
      </div>
    </DialogContent>
  );
}

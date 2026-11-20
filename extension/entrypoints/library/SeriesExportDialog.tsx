import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PdfExportOptions from '@/components/editor/PdfExportOptions';
import { ExportActions, ExportFormatTabs } from '@/components/editor/ExportControls';
import { useExportRunner, type RunExport } from '@/components/editor/use-export-runner';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import { DEFAULT_PDF_EXPORT_SETTINGS, type PdfExportSettings } from '@/lib/export/pdf-export-settings';
import { generateSeriesZip, seriesExportFilename, type SeriesExportFormat } from '@/lib/export/series-export';
import { throwIfAborted } from '@/lib/shared/abort';
import { seriesDisplayTitle, type ProjectSeries } from '@/lib/storage/series-model';
import { t } from '@/lib/shared/i18n';

const FORMATS: readonly SeriesExportFormat[] = ['pdf', 'html', 'markdown'];

interface Props {
  /** The Series to export; null keeps the dialog closed. */
  series: ProjectSeries | null;
  runExport: RunExport;
  onClose: () => void;
}

/** Exports every Project of a Series, each as its own file, in one ZIP. */
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
  const [format, setFormat] = useState<SeriesExportFormat>('pdf');
  const [pdfSettings, setPdfSettings] = useState<PdfExportSettings>(DEFAULT_PDF_EXPORT_SETTINGS);
  const exporter = useExportRunner(runExport, () => copy.exportNothing);
  const title = seriesDisplayTitle(series.title);

  function download() {
    void exporter.run(format, async (signal) => {
      const zip = await generateSeriesZip(series.projectIds, format, { signal, pdfSettings });
      if (!zip) return 'nothing';
      throwIfAborted(signal);
      // Resolves once the browser has queued the transfer, which survives this page closing.
      await downloadBlobViaBrowser(zip, seriesExportFilename(title), { signal });
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
      className="w-[min(420px,calc(100vw-32px))] p-6"
    >
      <DialogHeader>
        <DialogTitle>{copy.exportTitle}</DialogTitle>
        <DialogDescription className="break-words">{title} · {copy.exportHint}</DialogDescription>
      </DialogHeader>
      <div className="mt-5">
        <ExportFormatTabs formats={FORMATS} value={format} onChange={setFormat} disabled={exporter.busyShown} />
        {format === 'pdf' && <PdfExportOptions settings={pdfSettings} onChange={setPdfSettings} disabled={exporter.busyShown} />}
      </div>
      <div className="mt-6">
        <ExportActions
          error={exporter.error}
          notice={exporter.notice}
          busyShown={exporter.busyShown}
          label={copy.exportLabel}
          onDownload={download}
          onCancel={exporter.cancel}
        />
      </div>
    </DialogContent>
  );
}

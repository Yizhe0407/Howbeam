import { throwIfAborted } from '../shared/abort';
import { documentLang, t } from '@/lib/shared/i18n';
import { StepImageError } from './export-errors';
import { loadPdfFonts } from './pdf/pdf-fonts';
import { readJpegSize } from './pdf/jpeg-size';
import { PdfLayouter } from './pdf/pdf-layout';
import { PdfWriter } from './pdf/pdf-render';
import { resolvePdfExportSettings, type ProjectPdfOptions } from './pdf-export-settings';
import {
  DEFAULT_TITLE,
  MADE_WITH,
  PROJECT_EXPORT_LIMITS,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  type ProjectExportMetadata,
} from './project-export-contract';
import { entryHeading, renderEntryImages } from './project-export-render';
import { type StepEntry } from '../storage/models';

/**
 * Generates a local PDF with real, selectable text. A title block (title and
 * description) is merged with the first step, each step is a numbered heading
 * above a bordered screenshot, and a running footer carries the project title,
 * the Howbeam credit and the page number. Paper, orientation, one-step-per-page
 * versus continuous flow, the footer text and the annotation list follow
 * `options.settings`.
 *
 * Steps are rendered, laid out and written one at a time, so only the page being
 * built holds screenshots in memory; each screenshot is embedded as the JPEG it
 * already is, never re-encoded.
 */
export async function generateProjectPdf(
  entries: readonly StepEntry[],
  metadata: ProjectExportMetadata = {},
  options: ProjectPdfOptions = {},
): Promise<Blob> {
  const { signal } = options;
  throwIfAborted(signal);
  const settings = resolvePdfExportSettings(options.settings);
  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  const copy = t().export;

  const writer = await PdfWriter.create({
    title,
    language: documentLang(),
    fonts: await loadPdfFonts(),
    maxPages: PROJECT_EXPORT_LIMITS.maxPdfPages,
    maxBytes: PROJECT_EXPORT_LIMITS.maxPdfBytes,
    signal,
  });
  const layouter = new PdfLayouter({
    settings,
    measure: (text, style) => writer.measure(text, style),
    footerTitle: title,
    labels: { pageNumber: copy.pageNumber, credit: MADE_WITH, missingDescription: copy.missingDescription },
    signal,
  });
  const writePages = () => {
    for (const page of layouter.takePages()) writer.writePage(page);
  };

  layouter.addTitleBlock(title, textValue(metadata.description));
  const sections = sectionsByStartEntry(metadata.sections, entries);
  for await (const rendered of renderEntryImages(entries, signal)) {
    let size;
    try {
      size = readJpegSize(rendered.imageBytes);
    } catch (error) {
      throw new StepImageError(rendered.content.ordinal, error);
    }
    const section = sections.get(rendered.content.entryId);
    layouter.addStep({
      section: section && { title: section.title },
      ordinal: rendered.content.ordinal,
      heading: entryHeading(rendered.content),
      image: { bytes: rendered.imageBytes, ...size },
      alt: textOrDefault(rendered.content.description, copy.imageAlt),
      annotations: rendered.content.annotations,
    });
    writePages();
  }
  layouter.finish();
  writePages();

  return writer.finish();
}

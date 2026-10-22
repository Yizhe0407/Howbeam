import type { ProjectExportOptions } from './project-export-contract';

export type PdfPaper = 'a4' | 'letter';
export type PdfOrientation = 'portrait' | 'landscape';
/** `page-per-step` starts every step on a fresh page; `continuous` lets steps
 * follow one another and only breaks a page when a step's screenshot would not fit. */
export type PdfStepLayout = 'page-per-step' | 'continuous';

export interface PdfExportSettings {
  paper: PdfPaper;
  orientation: PdfOrientation;
  stepLayout: PdfStepLayout;
  /** The project title and page number in the running footer. The hairline and
   * the Howbeam credit stay, so every document keeps its credit. */
  showFooter: boolean;
}

export const DEFAULT_PDF_EXPORT_SETTINGS: Readonly<PdfExportSettings> = Object.freeze({
  paper: 'a4',
  orientation: 'portrait',
  stepLayout: 'page-per-step',
  showFooter: true,
});

export interface ProjectPdfOptions extends ProjectExportOptions {
  settings?: Partial<PdfExportSettings>;
}

export function resolvePdfExportSettings(settings: Partial<PdfExportSettings> = {}): PdfExportSettings {
  return { ...DEFAULT_PDF_EXPORT_SETTINGS, ...settings };
}

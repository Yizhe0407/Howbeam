import type { PdfOrientation, PdfPaper } from '../pdf-export-settings';
import { PROJECT_EXPORT_THEME } from '../project-export-contract';

/** The layout unit is a ~150dpi pixel; a PDF point is 1/72 inch. */
export const POINTS_PER_PIXEL = 72 / 150;

const PAPER_POINTS: Record<PdfPaper, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

export interface PdfPageSize {
  widthPoints: number;
  heightPoints: number;
  widthPixels: number;
  heightPixels: number;
}

/** The page in PDF points, and in the layout pixels derived from them. */
export function pdfPageSize(paper: PdfPaper, orientation: PdfOrientation): PdfPageSize {
  const { width, height } = PAPER_POINTS[paper];
  const [widthPoints, heightPoints] = orientation === 'portrait' ? [width, height] : [height, width];
  return {
    widthPoints,
    heightPoints,
    widthPixels: widthPoints / POINTS_PER_PIXEL,
    heightPixels: heightPoints / POINTS_PER_PIXEL,
  };
}


/**
 * The page's visual specification. Every length is in page pixels at ~150dpi
 * (an A4 page is 1240 x 1754), the unit the document has always been designed
 * in; the renderer converts to PDF points.
 */
export const PDF_SPEC = Object.freeze({
  margin: 84,
  /** Hanging indent for a step: its printed number sits left of it, and the
   * title, screenshot and annotations all start at the same edge. */
  stepIndent: 66,
  /** Where content stops above the page foot, so steps never collide with the footer. */
  footerZone: 150,
  footerRuleFromBottom: 112,
  footerTextFromBottom: 92,
  footerFontSize: 22,
  footerLineHeight: 30,
  footerRuleThickness: 2,
  footerTitleGap: 40,
  headerRuleThickness: 4,
  headerRuleGapBefore: 10,
  headerRuleGapAfter: 34,
  sectionRuleThickness: 2,
  sectionRuleGapAfter: 28,
  imageMinSpace: 360,
  imageMinHeight: 320,
  imageMaxHeight: 1_040,
  imageBottomClearance: 8,
  imageGapAfter: 30,
  imageBorderWidth: 2,
  annotationColumnGap: 48,
  /** The theme radius is in CSS pixels; the page runs at ~150dpi against CSS's 96. */
  imageRadius: Math.round(PROJECT_EXPORT_THEME.imageRadius * (150 / 96)),
  /** Space between consecutive steps when they flow on one page. */
  continuousStepGap: 48,
  /** In continuous flow a screenshot may shrink to this share of its preferred height to stay on the page. */
  continuousImageMinShare: 0.6,
});

export const PDF_COLORS = Object.freeze({
  text: PROJECT_EXPORT_THEME.text,
  secondary: PROJECT_EXPORT_THEME.secondaryText,
  muted: PROJECT_EXPORT_THEME.mutedText,
  rule: PROJECT_EXPORT_THEME.rule,
  imageBorder: PROJECT_EXPORT_THEME.imageBorder,
});

export type PdfWeight = 'regular' | 'bold';

export interface PdfTextStyle {
  fontSize: number;
  lineHeight: number;
  color: string;
  weight: PdfWeight;
  gapBefore: number;
  gapAfter: number;
}

export const PDF_TEXT = Object.freeze({
  title: { fontSize: 52, lineHeight: 68, color: PDF_COLORS.text, weight: 'bold', gapBefore: 0, gapAfter: 18 },
  description: { fontSize: 28, lineHeight: 48, color: PDF_COLORS.secondary, weight: 'regular', gapBefore: 0, gapAfter: 12 },
  section: { fontSize: 36, lineHeight: 56, color: PDF_COLORS.text, weight: 'bold', gapBefore: 0, gapAfter: 10 },
  stepTitle: { fontSize: 30, lineHeight: 52, color: PDF_COLORS.text, weight: 'bold', gapBefore: 0, gapAfter: 22 },
  annotation: { fontSize: 28, lineHeight: 48, color: PDF_COLORS.secondary, weight: 'regular', gapBefore: 6, gapAfter: 6 },
  footer: { fontSize: PDF_SPEC.footerFontSize, lineHeight: PDF_SPEC.footerLineHeight, color: PDF_COLORS.muted, weight: 'regular', gapBefore: 0, gapAfter: 0 },
} satisfies Record<string, PdfTextStyle>);

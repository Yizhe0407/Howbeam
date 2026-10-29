import { throwIfAborted } from '../../shared/abort';
import type { PdfExportSettings } from '../pdf-export-settings';
import { PDF_COLORS, PDF_SPEC, PDF_TEXT, pdfPageSize, type PdfPageSize, type PdfTextStyle } from './pdf-spec';
import { shortenText, truncateText, wrapText } from '../text-wrap';
import { balancedColumnHeight, chooseAnnotationColumns, fillColumns } from '../annotation-columns';

/** Every coordinate is in page pixels (~150dpi), measured from the page's top-left. */
export interface PdfText {
  text: string;
  x: number;
  /** Top of the line box the text is centred in. */
  top: number;
  style: PdfTextStyle;
}

export interface PdfRule {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface PdfImage {
  bytes: Uint8Array;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A bookmark for the viewer's outline pane; `level` 2 nests under the latest level 1. */
export interface PdfOutlineEntry {
  level: 1 | 2;
  title: string;
}

export interface PdfListItem {
  /** Absent on the continuation of an item whose label was set on the previous page. */
  label?: PdfText;
  lines: PdfText[];
}

/**
 * What each piece of a page is, so the document can be tagged for assistive
 * technology: headings, paragraphs, lists and figures belong to the reading
 * order, while rules and the running footer are artifacts a reader skips.
 */
export type PdfBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; lines: PdfText[]; outline?: PdfOutlineEntry }
  | { kind: 'paragraph'; lines: PdfText[] }
  | { kind: 'list'; items: PdfListItem[] }
  | { kind: 'figure'; alt: string; image: PdfImage }
  | { kind: 'artifact'; role: 'layout' | 'pagination'; rules: PdfRule[]; texts: PdfText[] };

export interface PdfPage {
  number: number;
  /** Page size in layout pixels and in PDF points. */
  size: PdfPageSize;
  /** In reading order. */
  blocks: PdfBlock[];
}

export interface LayoutStep {
  section?: { title: string };
  ordinal: number;
  heading: string;
  image: { bytes: Uint8Array; width: number; height: number };
  alt: string;
  annotations: readonly { description: string }[];
}

export interface PdfLayouterOptions {
  settings: PdfExportSettings;
  /** Width of `text` in layout pixels when set in `style`. */
  measure: (text: string, style: PdfTextStyle) => number;
  footerTitle: string;
  labels: {
    pageNumber: (page: number) => string;
    credit: string;
    missingDescription: string;
  };
  signal?: AbortSignal;
}

/** Longest bookmark title, in characters; a step heading can be a whole paragraph. */
const OUTLINE_TITLE_LENGTH = 100;

/**
 * Lays a project out page by page. It decides where everything goes and emits
 * that as plain data; nothing here draws. Pages are handed over as soon as they
 * are complete, so the caller can render and release each one while the next is
 * still being laid out.
 */
interface AnnotationMarker {
  label: string;
  lines: string[];
  height: number;
}

export class PdfLayouter {
  private readonly size: PdfPageSize;
  private readonly contentWidth: number;
  private readonly stepContentWidth: number;
  private readonly contentBottom: number;
  private blocks: PdfBlock[] = [];
  private openList: { page: number; items: PdfListItem[] } | undefined;
  private cursorY = PDF_SPEC.margin;
  private hasContent = false;
  private pageNumber = 0;
  private stepCount = 0;
  /** Once a section title has been printed, steps nest under it. */
  private inSection = false;
  private completed: PdfPage[] = [];

  constructor(private readonly options: PdfLayouterOptions) {
    this.size = pdfPageSize(options.settings.paper, options.settings.orientation);
    this.contentWidth = this.size.widthPixels - PDF_SPEC.margin * 2;
    this.stepContentWidth = this.contentWidth - PDF_SPEC.stepIndent;
    this.contentBottom = this.size.heightPixels - PDF_SPEC.footerZone;
  }

  /** Pages laid out so far, including any still waiting to be taken. */
  get pagesFinished(): number {
    return this.pageNumber;
  }

  /** Hands over the pages completed since the last call. */
  takePages(): PdfPage[] {
    const pages = this.completed;
    this.completed = [];
    return pages;
  }

  finish(): void {
    if (this.hasContent) this.finishPage();
  }

  addTitleBlock(title: string, description: string): void {
    this.addTextBlock({ kind: 'heading', level: 1 }, title, PDF_TEXT.title);
    this.addTextBlock({ kind: 'paragraph' }, description, PDF_TEXT.description);
    this.addRule(PDF_SPEC.headerRuleGapBefore, PDF_SPEC.headerRuleGapAfter, PDF_SPEC.headerRuleThickness, PDF_COLORS.text);
  }

  /**
   * Lays out one step: optional section title, numbered heading, framed
   * screenshot, then its annotation list. In `page-per-step` mode every step
   * after the first starts a fresh page. In `continuous` mode it follows the
   * previous step and only moves to a new page when its section title, heading
   * and screenshot would not all fit below the cursor, so a heading is never
   * stranded at the foot of a page away from its screenshot.
   */
  addStep(step: LayoutStep): void {
    throwIfAborted(this.options.signal);
    const { settings } = this.options;
    if (this.stepCount > 0) {
      if (settings.stepLayout === 'page-per-step') this.startNewPage();
      else if (this.hasContent) this.cursorY += PDF_SPEC.continuousStepGap;
    }
    this.stepCount += 1;

    const leadingHeight = step.section
      ? PDF_TEXT.section.lineHeight + PDF_TEXT.section.gapAfter + PDF_SPEC.sectionRuleThickness + PDF_SPEC.sectionRuleGapAfter
      : 0;
    const imageSpace = this.imageSpaceFor(step.image.width, step.image.height, leadingHeight);
    this.ensureSpace(leadingHeight + PDF_TEXT.stepTitle.lineHeight + PDF_TEXT.stepTitle.gapAfter + imageSpace);
    if (step.section) {
      this.addTextBlock(
        { kind: 'heading', level: 2, outline: { level: 1, title: shortenText(step.section.title, OUTLINE_TITLE_LENGTH) } },
        step.section.title,
        PDF_TEXT.section,
      );
      this.inSection = true;
      this.addRule(0, PDF_SPEC.sectionRuleGapAfter, PDF_SPEC.sectionRuleThickness, PDF_COLORS.rule);
    }
    this.addStepHeading(step.ordinal, step.heading, imageSpace);
    this.addImage(step.image, step.alt);
    // The heading already carries the entry's own description; a Mark entry's markers are its content, so they always follow.
    this.addAnnotations(step.annotations);
  }

  /**
   * Vertical room a step's screenshot must find below its heading. A step on
   * its own page only needs the minimum (the image shrinks to what is left);
   * in continuous mode the screenshot must keep most of its preferred size
   * (capped by what a fresh page offers), so flowing steps never get squeezed
   * into the leftover strip of a page, yet a page is not left empty because a
   * screenshot would be a little too tall.
   */
  private imageSpaceFor(imageWidth: number, imageHeight: number, leadingHeight: number): number {
    if (this.options.settings.stepLayout === 'page-per-step') return PDF_SPEC.imageMinSpace;
    const scale = Math.min(
      this.stepContentWidth / Math.max(1, imageWidth),
      PDF_SPEC.imageMaxHeight / Math.max(1, imageHeight),
      1,
    );
    const freshPageSpace =
      this.contentBottom - PDF_SPEC.margin - leadingHeight - PDF_TEXT.stepTitle.lineHeight - PDF_TEXT.stepTitle.gapAfter - PDF_SPEC.imageBottomClearance;
    const preferred = Math.ceil(imageHeight * scale);
    return Math.max(PDF_SPEC.imageMinSpace, Math.min(Math.ceil(preferred * PDF_SPEC.continuousImageMinShare), freshPageSpace));
  }

  private measure(style: PdfTextStyle) {
    return (text: string) => this.options.measure(text, style);
  }

  /** A heading or paragraph of wrapped lines. If it runs onto another page, each page gets its own block. */
  private addTextBlock(
    template: { kind: 'heading'; level: 1 | 2 | 3; outline?: PdfOutlineEntry } | { kind: 'paragraph' },
    text: string,
    style: PdfTextStyle,
  ): void {
    if (!text) return;
    const lines = wrapText(this.measure(style), text, this.contentWidth, this.options.signal);
    let pendingGap = style.gapBefore;
    let block: (PdfBlock & { lines: PdfText[] }) | undefined;
    let blockPage = 0;

    for (const line of lines) {
      this.ensureSpace(pendingGap + style.lineHeight);
      this.cursorY += pendingGap;
      if (!block || blockPage !== this.pageNumber) {
        // Only the first fragment carries the bookmark.
        block = template.kind === 'heading'
          ? { kind: 'heading', level: template.level, lines: [], ...(block ? {} : { outline: template.outline }) }
          : { kind: 'paragraph', lines: [] };
        blockPage = this.pageNumber;
        this.pushBlock(block);
      }
      block.lines.push({ text: line, x: PDF_SPEC.margin, top: this.cursorY, style });
      this.cursorY += style.lineHeight;
      this.hasContent = true;
      pendingGap = 0;
    }
    this.cursorY += style.gapAfter;
  }

  /** Step heading: the printed number in the hanging column, the bold title beside it. */
  private addStepHeading(ordinal: number, text: string, imageSpace: number): void {
    const style = PDF_TEXT.stepTitle;
    const lines = wrapText(this.measure(style), text, this.stepContentWidth, this.options.signal);
    const outlineTitle = shortenText(text ? `${ordinal}. ${text}` : `${ordinal}.`, OUTLINE_TITLE_LENGTH);
    let pendingGap = style.gapBefore;
    let block: (PdfBlock & { kind: 'heading' }) | undefined;
    let blockPage = 0;

    for (const [index, line] of lines.entries()) {
      // The last line must leave room for the screenshot that follows it.
      const reservedBelow = index === lines.length - 1 ? style.gapAfter + imageSpace : 0;
      this.ensureSpace(pendingGap + style.lineHeight + reservedBelow);
      this.cursorY += pendingGap;
      if (!block || blockPage !== this.pageNumber) {
        block = {
          kind: 'heading',
          level: this.inSection ? 3 : 2,
          lines: [],
          ...(block ? {} : { outline: { level: this.inSection ? 2 : 1, title: outlineTitle } }),
        };
        blockPage = this.pageNumber;
        this.pushBlock(block);
      }
      if (index === 0) block.lines.push({ text: `${ordinal}.`, x: PDF_SPEC.margin, top: this.cursorY, style });
      block.lines.push({ text: line, x: PDF_SPEC.margin + PDF_SPEC.stepIndent, top: this.cursorY, style });
      this.cursorY += style.lineHeight;
      this.hasContent = true;
      pendingGap = 0;
    }
    this.cursorY += style.gapAfter;
  }

  /**
   * A step's markers as one numbered list, every description starting at the
   * widest number so they line up. They share rows in columns, numbered down
   * each column, when that makes the list shorter; a marker too long for a
   * column runs across the full width between them (see `chooseAnnotationColumns`).
   */
  private addAnnotations(annotations: LayoutStep['annotations']): void {
    // Same rule as hasAnnotationText in project-export-render: unlabelled markers get no list.
    if (annotations.every((annotation) => annotation.description.trim() === '')) return;
    const style = PDF_TEXT.annotation;
    const texts = annotations.map((annotation) => annotation.description.trim() || this.options.labels.missingDescription);
    const labelFor = (index: number) => `${index + 1}. `;
    const labelWidth = Math.max(...texts.map((_, index) => this.options.measure(labelFor(index), style)));
    const layout = chooseAnnotationColumns(
      (count) => texts.map((text) => wrapText(this.measure(style), text, this.annotationColumnWidth(count) - labelWidth, this.options.signal)),
      (lineCount) => style.gapBefore + lineCount * style.lineHeight + style.gapAfter,
    );
    const markers = layout.lines.map((lines, index) => ({
      label: labelFor(index),
      lines,
      height: style.gapBefore + lines.length * style.lineHeight + style.gapAfter,
    }));
    let runStart = 0;
    for (const [index, marker] of markers.entries()) {
      if (layout.columns > 1 && !layout.spans[index]) continue;
      this.addAnnotationColumns(markers.slice(runStart, index), layout.columns, labelWidth);
      this.addAnnotation(marker.label, labelWidth, marker.lines);
      runStart = index + 1;
    }
    this.addAnnotationColumns(markers.slice(runStart), layout.columns, labelWidth);
  }

  /** A run of markers in balanced columns, carrying over to the next page when they don't fit. */
  private addAnnotationColumns(markers: readonly AnnotationMarker[], columns: number, labelWidth: number): void {
    const style = PDF_TEXT.annotation;
    const columnWidth = this.annotationColumnWidth(columns);
    let rest = markers;
    for (let first = rest[0]; first; first = rest[0]) {
      this.ensureSpace(first.height);
      // The rest of the run in balanced columns when it fits on this page; otherwise the columns fill the page and the rest carries over.
      const heights = rest.map((marker) => marker.height);
      const capacity = Math.min(balancedColumnHeight(heights, columns), this.contentBottom - this.cursorY);
      const { count, starts } = fillColumns(heights, columns, capacity);
      const items = this.listFor(this.pageNumber);
      let tallest = 0;
      for (const [column, start] of starts.entries()) {
        const x = PDF_SPEC.margin + PDF_SPEC.stepIndent + column * (columnWidth + PDF_SPEC.annotationColumnGap);
        let top = this.cursorY;
        for (const marker of rest.slice(start, starts[column + 1] ?? count)) {
          const lineTop = top + style.gapBefore;
          items.push({
            label: { text: marker.label, x, top: lineTop, style },
            lines: marker.lines.map((line, lineIndex) => ({ text: line, x: x + labelWidth, top: lineTop + lineIndex * style.lineHeight, style })),
          });
          top += marker.height;
        }
        tallest = Math.max(tallest, top - this.cursorY);
      }
      this.cursorY += tallest;
      this.hasContent = true;
      rest = rest.slice(count);
    }
  }

  private annotationColumnWidth(columns: number): number {
    return (this.stepContentWidth - PDF_SPEC.annotationColumnGap * (columns - 1)) / columns;
  }

  /** A full-width marker, which may run onto the next page line by line. */
  private addAnnotation(label: string, labelWidth: number, lines: readonly string[]): void {
    const style = PDF_TEXT.annotation;
    let pendingGap = style.gapBefore;
    let item: PdfListItem | undefined;
    let itemPage = 0;

    for (const [index, line] of lines.entries()) {
      this.ensureSpace(pendingGap + style.lineHeight);
      this.cursorY += pendingGap;
      if (!item || itemPage !== this.pageNumber) {
        item = { lines: [] };
        itemPage = this.pageNumber;
        this.listFor(this.pageNumber).push(item);
      }
      const x = PDF_SPEC.margin + PDF_SPEC.stepIndent;
      if (index === 0) item.label = { text: label, x, top: this.cursorY, style };
      item.lines.push({ text: line, x: x + labelWidth, top: this.cursorY, style });
      this.cursorY += style.lineHeight;
      this.hasContent = true;
      pendingGap = 0;
    }
    this.cursorY += style.gapAfter;
  }

  /** The list currently open on `page`, started if there is none. */
  private listFor(page: number): PdfListItem[] {
    if (!this.openList || this.openList.page !== page) {
      this.openList = { page, items: [] };
      this.blocks.push({ kind: 'list', items: this.openList.items });
    }
    return this.openList.items;
  }

  /** Draws a full-width horizontal rule. */
  private addRule(gapBefore: number, gapAfter: number, thickness: number, color: string): void {
    this.ensureSpace(gapBefore + thickness);
    this.cursorY += gapBefore;
    const rule: PdfRule = { x: PDF_SPEC.margin, y: this.cursorY, width: this.contentWidth, height: thickness, color };
    this.pushBlock({ kind: 'artifact', role: 'layout', rules: [rule], texts: [] });
    this.cursorY += thickness + gapAfter;
    this.hasContent = true;
  }

  private addImage(image: LayoutStep['image'], alt: string): void {
    if (this.contentBottom - this.cursorY < PDF_SPEC.imageMinSpace) this.startNewPage();
    const availableHeight = Math.max(
      PDF_SPEC.imageMinHeight,
      this.contentBottom - this.cursorY - PDF_SPEC.imageBottomClearance,
    );
    const scale = Math.min(
      this.stepContentWidth / Math.max(1, image.width),
      Math.min(PDF_SPEC.imageMaxHeight, availableHeight) / Math.max(1, image.height),
      1,
    );
    const width = Math.max(1, image.width * scale);
    const height = Math.max(1, image.height * scale);
    this.pushBlock({
      kind: 'figure',
      alt,
      image: { bytes: image.bytes, x: PDF_SPEC.margin + PDF_SPEC.stepIndent, y: this.cursorY, width, height },
    });
    this.cursorY += height + PDF_SPEC.imageGapAfter;
    this.hasContent = true;
  }

  private pushBlock(block: PdfBlock): void {
    this.blocks.push(block);
    this.openList = undefined;
  }

  private ensureSpace(requiredHeight: number): void {
    throwIfAborted(this.options.signal);
    if (this.cursorY + requiredHeight <= this.contentBottom) return;
    this.startNewPage();
  }

  private startNewPage(): void {
    if (this.hasContent) this.finishPage();
  }

  /** Running footer: hairline and the credit centred; the project title (left)
   * and page number (right) unless the footer text is switched off. */
  private drawFooter(): void {
    const style = PDF_TEXT.footer;
    const { widthPixels, heightPixels } = this.size;
    const { footerTitle, labels, settings } = this.options;
    const top = heightPixels - PDF_SPEC.footerTextFromBottom;
    const measure = this.measure(style);
    const rule: PdfRule = {
      x: PDF_SPEC.margin,
      y: heightPixels - PDF_SPEC.footerRuleFromBottom,
      width: this.contentWidth,
      height: PDF_SPEC.footerRuleThickness,
      color: PDF_COLORS.rule,
    };

    const creditWidth = measure(labels.credit);
    const texts: PdfText[] = [];
    if (settings.showFooter) {
      const maxTitleWidth = Math.max(0, (this.contentWidth - creditWidth) / 2 - PDF_SPEC.footerTitleGap);
      texts.push({ text: truncateText(measure, footerTitle, maxTitleWidth), x: PDF_SPEC.margin, top, style });
    }
    texts.push({ text: labels.credit, x: (widthPixels - creditWidth) / 2, top, style });
    if (settings.showFooter) {
      const pageLabel = labels.pageNumber(this.pageNumber);
      texts.push({ text: pageLabel, x: widthPixels - PDF_SPEC.margin - measure(pageLabel), top, style });
    }
    this.pushBlock({ kind: 'artifact', role: 'pagination', rules: [rule], texts });
  }

  private finishPage(): void {
    this.pageNumber += 1;
    this.drawFooter();
    this.completed.push({ number: this.pageNumber, size: this.size, blocks: this.blocks });
    this.blocks = [];
    this.cursorY = PDF_SPEC.margin;
    this.hasContent = false;
  }
}

import { throwIfAborted } from '../shared/abort';
import { type StepEntry } from '../storage/models';
import {
  DEFAULT_TITLE,
  MADE_WITH,
  PROJECT_EXPORT_LIMITS,
  PROJECT_EXPORT_THEME,
  ProjectExportLimitError,
  IMAGE_MIME_TYPE,
  formatProjectCreatedAt,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  type ProjectExportMetadata,
  type ProjectExportOptions,
} from './project-export-contract';
import { renderEntryImages } from './project-export-render';
import { truncatePdfText, wrapPdfText } from './pdf-text-layout';
import { t } from '@/lib/shared/i18n';

/**
 * Generates a local PDF using a hybrid raster pipeline: text and decorations
 * are rasterized per page with the browser's installed fonts (so CJK
 * descriptions remain visible without shipping a large font file in the
 * extension bundle), while each step screenshot is embedded as its own
 * full-resolution JPEG layered over the page raster. This keeps screenshots at
 * their native capture resolution instead of the page raster's ~150dpi.
 *
 * Layout: a title block (accent kicker, title, description, metadata line)
 * merged with the first step page, one step per page with a numbered badge
 * heading above a bordered screenshot, and a running footer with the project
 * title and page number.
 */
export async function generateProjectPdf(
  entries: readonly StepEntry[],
  metadata: ProjectExportMetadata = {},
  options: ProjectExportOptions = {},
): Promise<Blob> {
  const { signal } = options;
  throwIfAborted(signal);
  const { PDFDocument } = await import('pdf-lib');
  throwIfAborted(signal);
  const document = await PDFDocument.create();
  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  document.setTitle(title);
  // 分頁器會先驗證頁數與位元組預算，再呼叫此純嵌入 callback。
  const paginator = new ProjectPdfPaginator(async (jpegBytes, screenshots) => {
    throwIfAborted(signal);
    const embedded = await document.embedJpg(jpegBytes);
    const page = document.addPage([PDF_PAGE_WIDTH_POINTS, PDF_PAGE_HEIGHT_POINTS]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: PDF_PAGE_WIDTH_POINTS,
      height: PDF_PAGE_HEIGHT_POINTS,
    });
    // 將截圖疊在空白點陣矩形上，以保留原生解析度。
    for (const screenshot of screenshots) {
      const image = await document.embedJpg(screenshot.bytes);
      page.drawImage(image, {
        x: screenshot.x * PDF_POINTS_PER_PIXEL_X,
        y: PDF_PAGE_HEIGHT_POINTS - (screenshot.y + screenshot.height) * PDF_POINTS_PER_PIXEL_Y,
        width: screenshot.width * PDF_POINTS_PER_PIXEL_X,
        height: screenshot.height * PDF_POINTS_PER_PIXEL_Y,
      });
    }
  }, title, signal);

  await paginator.addParagraph(title, PDF_TITLE_TEXT);
  const projectDescription = textValue(metadata.description);
  if (projectDescription) await paginator.addParagraph(projectDescription, PDF_PROJECT_DESCRIPTION_TEXT);
  const metaParts = [t().export.stepCount(entries.length)];
  const createdAt = formatProjectCreatedAt(metadata.createdAt);
  if (createdAt) metaParts.push(t().export.createdAt(createdAt));
  await paginator.addParagraph(metaParts.join(' · '), PDF_META_TEXT);
  await paginator.addRule(0, PDF_HEADER_RULE_GAP_AFTER, PDF_HEADER_RULE_THICKNESS, PDF_COLOR_TEXT);

  const sections = sectionsByStartEntry(metadata.sections, entries);
  let renderedCount = 0;
  for await (const rendered of renderEntryImages(entries, signal)) {
    if (renderedCount > 0) await paginator.startNewPage();
    const section = sections.get(rendered.content.entryId);
    if (section) {
      await paginator.addParagraph(section.title, PDF_SECTION_TEXT);
      await paginator.addRule(0, PDF_SECTION_RULE_GAP_AFTER, PDF_SECTION_RULE_THICKNESS, PDF_COLOR_RULE);
    }
    await paginator.addStepHeading(
      rendered.content.ordinal,
      textOrDefault(rendered.content.description, t().export.missingDescription),
    );
    await paginator.addImage(rendered.imageBytes);
    // 標題已包含項目說明。
    for (const [index, annotation] of rendered.content.annotations.entries()) {
      await paginator.addNumberedParagraph(index + 1, annotation.description);
    }
    renderedCount += 1;
  }
  await paginator.addRule(PDF_END_GAP_BEFORE, PDF_END_RULE_GAP_AFTER, PDF_SECTION_RULE_THICKNESS, PDF_COLOR_RULE);
  await paginator.addCenteredLine(MADE_WITH, PDF_END_TEXT);
  await paginator.finish();
  throwIfAborted(signal);

  const saved = await document.save();
  throwIfAborted(signal);
  if (saved.byteLength > PROJECT_EXPORT_LIMITS.maxPdfBytes) {
    throw new ProjectExportLimitError('Project PDF exceeds the output size limit.');
  }
  const owned = new Uint8Array(saved.byteLength);
  owned.set(saved);
  return new Blob([owned.buffer], { type: 'application/pdf' });
}

// A4 rasterized at ~150dpi; embedded 1:1 into A4 point-sized pages.
const PDF_PAGE_WIDTH = 1_240;
const PDF_PAGE_HEIGHT = 1_754;
const PDF_PAGE_WIDTH_POINTS = 595.28;
const PDF_PAGE_HEIGHT_POINTS = 841.89;
/**
 * Converts page-canvas pixel coordinates to PDF points, matching the slight
 * per-axis stretch the full-page raster gets so overlaid screenshots align
 * exactly with the borders drawn on the raster.
 */
const PDF_POINTS_PER_PIXEL_X = PDF_PAGE_WIDTH_POINTS / PDF_PAGE_WIDTH;
const PDF_POINTS_PER_PIXEL_Y = PDF_PAGE_HEIGHT_POINTS / PDF_PAGE_HEIGHT;
/**
 * Quality when a screenshot must be re-encoded to fit the byte budget. Kept
 * above the 0.9 floor screenshots require; the normal path embeds the
 * composited JPEG bytes untouched, so no re-encode happens at all.
 */
const PDF_SCREENSHOT_JPEG_QUALITY = 0.92;
/** Page rasters carry text and hairlines only; 0.9 keeps them artifact-free. */
const PDF_PAGE_RASTER_JPEG_QUALITY = 0.9;
const PDF_MARGIN = 84;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
/** Content stops above the footer zone so steps never collide with it. */
const PDF_CONTENT_BOTTOM = PDF_PAGE_HEIGHT - 150;
const PDF_FOOTER_RULE_Y = PDF_PAGE_HEIGHT - 112;
const PDF_FOOTER_TEXT_Y = PDF_PAGE_HEIGHT - 92;
/** Hanging indent for a step: its printed number sits left of it, and the
 * title, screenshot and annotations all start at the same edge. */
const PDF_STEP_INDENT = 66;
const PDF_STEP_CONTENT_WIDTH = PDF_CONTENT_WIDTH - PDF_STEP_INDENT;
const PDF_HEADER_RULE_THICKNESS = 4;
const PDF_HEADER_RULE_GAP_AFTER = 34;
const PDF_SECTION_RULE_THICKNESS = 2;
const PDF_SECTION_RULE_GAP_AFTER = 28;
const PDF_END_GAP_BEFORE = 40;
const PDF_END_RULE_GAP_AFTER = 18;
const PDF_IMAGE_MIN_SPACE = 360;
const PDF_IMAGE_MIN_HEIGHT = 320;
const PDF_IMAGE_MAX_HEIGHT = 1_040;
const PDF_IMAGE_BOTTOM_CLEARANCE = 8;
const PDF_IMAGE_GAP_AFTER = 30;
const PDF_IMAGE_BORDER_WIDTH = 2;
const PDF_FOOTER_FONT_SIZE = 22;
const PDF_FOOTER_RULE_THICKNESS = 2;
const PDF_FOOTER_TITLE_GAP = 40;
const PDF_FONT_FAMILY = PROJECT_EXPORT_THEME.fontFamily;

const PDF_COLOR_TEXT = PROJECT_EXPORT_THEME.text;
const PDF_COLOR_SECONDARY = PROJECT_EXPORT_THEME.secondaryText;
const PDF_COLOR_MUTED = PROJECT_EXPORT_THEME.mutedText;
const PDF_COLOR_RULE = PROJECT_EXPORT_THEME.rule;
const PDF_COLOR_IMAGE_BORDER = PROJECT_EXPORT_THEME.imageBorder;

type PdfTextStyle = {
  fontSize: number;
  lineHeight: number;
  color: string;
  weight: number;
  gapBefore: number;
  gapAfter: number;
};

const PDF_TITLE_TEXT: PdfTextStyle = {
  fontSize: 52,
  lineHeight: 68,
  color: PDF_COLOR_TEXT,
  weight: 750,
  gapBefore: 0,
  gapAfter: 18,
};
const PDF_PROJECT_DESCRIPTION_TEXT: PdfTextStyle = {
  fontSize: 28,
  lineHeight: 48,
  color: PDF_COLOR_SECONDARY,
  weight: 400,
  gapBefore: 0,
  gapAfter: 12,
};
const PDF_META_TEXT: PdfTextStyle = {
  fontSize: 23,
  lineHeight: 36,
  color: PDF_COLOR_MUTED,
  weight: 400,
  gapBefore: 6,
  gapAfter: 18,
};
const PDF_SECTION_TEXT: PdfTextStyle = {
  fontSize: 36,
  lineHeight: 56,
  color: PDF_COLOR_TEXT,
  weight: 700,
  gapBefore: 0,
  gapAfter: 10,
};
const PDF_STEP_TITLE_TEXT: PdfTextStyle = {
  fontSize: 30,
  lineHeight: 52,
  color: PDF_COLOR_TEXT,
  weight: 650,
  gapBefore: 0,
  gapAfter: 22,
};
const PDF_END_TEXT: PdfTextStyle = {
  fontSize: 22,
  lineHeight: 34,
  color: PDF_COLOR_MUTED,
  weight: 400,
  gapBefore: 0,
  gapAfter: 0,
};
const PDF_LIST_TEXT: PdfTextStyle = {
  fontSize: 28,
  lineHeight: 48,
  color: PDF_COLOR_SECONDARY,
  weight: 400,
  gapBefore: 6,
  gapAfter: 6,
};

type PdfCanvasContext = OffscreenCanvasRenderingContext2D;

/** A screenshot embedded as a standalone PDF image over the page raster. */
type PdfPageScreenshot = {
  /** Pre-encoded JPEG bytes, embedded at their native resolution. */
  bytes: Uint8Array;
  /** Layout rectangle in page-canvas pixel coordinates (top-left origin). */
  x: number;
  y: number;
  width: number;
  height: number;
};

class ProjectPdfPaginator {
  private canvas!: OffscreenCanvas;
  private context!: PdfCanvasContext;
  private cursorY = PDF_MARGIN;
  private hasContent = false;
  private pageNumber = 0;
  private pageScreenshots: PdfPageScreenshot[] = [];
  /** Bytes already committed to the document (page rasters plus embedded
   * screenshots). Together with pageNumber this is the single place the
   * document's size and page budgets are tracked and enforced. */
  private committedBytes = 0;

  constructor(
    private readonly emitPage: (
      jpegBytes: Uint8Array,
      screenshots: readonly PdfPageScreenshot[],
    ) => Promise<void>,
    private readonly footerTitle: string,
    private readonly signal?: AbortSignal,
  ) {
    this.resetPage();
  }

  async startNewPage(): Promise<void> {
    if (this.hasContent) await this.flushPage();
  }

  async addParagraph(text: string, style: PdfTextStyle): Promise<void> {
    const content = textValue(text);
    if (!content) return;
    this.applyTextStyle(style);
    // Line-break normalization happens once, inside wrapPdfText.
    const lines = wrapPdfText(this.context, content, PDF_CONTENT_WIDTH, this.signal);
    let pendingGap = style.gapBefore;

    for (const line of lines) {
      await this.ensureSpace(pendingGap + style.lineHeight);
      this.applyTextStyle(style);
      this.cursorY += pendingGap;
      this.context.fillText(line, PDF_MARGIN, this.cursorY);
      this.cursorY += style.lineHeight;
      this.hasContent = true;
      pendingGap = 0;
    }
    this.cursorY += style.gapAfter;
  }

  /** Step heading: the printed number in the hanging column, the bold title beside it. */
  async addStepHeading(ordinal: number, text: string): Promise<void> {
    const style = PDF_STEP_TITLE_TEXT;
    this.applyTextStyle(style);
    const lines = wrapPdfText(this.context, text, PDF_STEP_CONTENT_WIDTH, this.signal);
    let pendingGap = style.gapBefore;

    for (const [index, line] of lines.entries()) {
      await this.ensureSpace(pendingGap + style.lineHeight);
      this.applyTextStyle(style);
      this.cursorY += pendingGap;
      if (index === 0) this.context.fillText(`${ordinal}.`, PDF_MARGIN, this.cursorY);
      this.context.fillText(line, PDF_MARGIN + PDF_STEP_INDENT, this.cursorY);
      this.cursorY += style.lineHeight;
      this.hasContent = true;
      pendingGap = 0;
    }
    this.cursorY += style.gapAfter;
  }

  async addCenteredLine(text: string, style: PdfTextStyle): Promise<void> {
    await this.ensureSpace(style.gapBefore + style.lineHeight);
    this.applyTextStyle(style);
    this.cursorY += style.gapBefore;
    this.context.textAlign = 'center';
    this.context.fillText(truncatePdfText(this.context, text, PDF_CONTENT_WIDTH), PDF_PAGE_WIDTH / 2, this.cursorY);
    this.context.textAlign = 'left';
    this.cursorY += style.lineHeight + style.gapAfter;
    this.hasContent = true;
  }

  async addNumberedParagraph(number: number, text: string): Promise<void> {
    const style = PDF_LIST_TEXT;
    this.applyTextStyle(style);
    const prefix = `${number}. `;
    const prefixWidth = this.context.measureText(prefix).width;
    const lines = wrapPdfText(
      this.context,
      textOrDefault(text, t().export.missingDescription),
      PDF_STEP_CONTENT_WIDTH - prefixWidth,
      this.signal,
    );
    let pendingGap = style.gapBefore;

    for (const [index, line] of lines.entries()) {
      await this.ensureSpace(pendingGap + style.lineHeight);
      this.applyTextStyle(style);
      this.cursorY += pendingGap;
      if (index === 0) this.context.fillText(prefix, PDF_MARGIN + PDF_STEP_INDENT, this.cursorY);
      this.context.fillText(line, PDF_MARGIN + PDF_STEP_INDENT + prefixWidth, this.cursorY);
      this.cursorY += style.lineHeight;
      this.hasContent = true;
      pendingGap = 0;
    }
    this.cursorY += style.gapAfter;
  }

  /** Draws a full-width horizontal rule. */
  async addRule(
    gapBefore: number,
    gapAfter: number,
    thickness: number,
    color: string,
  ): Promise<void> {
    await this.ensureSpace(gapBefore + thickness);
    this.cursorY += gapBefore;
    this.context.fillStyle = color;
    this.context.fillRect(PDF_MARGIN, this.cursorY, PDF_CONTENT_WIDTH, thickness);
    this.cursorY += thickness + gapAfter;
    this.hasContent = true;
  }

  async addImage(imageBytes: Uint8Array): Promise<void> {
    throwIfAborted(this.signal);
    // Blob construction already copies the bytes, and the caller hands us an
    // owned buffer, so no additional defensive copy is needed here.
    const bitmap = await createImageBitmap(new Blob([imageBytes as Uint8Array<ArrayBuffer>], { type: IMAGE_MIME_TYPE }));
    try {
      throwIfAborted(this.signal);
      if (PDF_CONTENT_BOTTOM - this.cursorY < PDF_IMAGE_MIN_SPACE) await this.startNewPage();
      const availableHeight = Math.max(
        PDF_IMAGE_MIN_HEIGHT,
        PDF_CONTENT_BOTTOM - this.cursorY - PDF_IMAGE_BOTTOM_CLEARANCE,
      );
      const scale = Math.min(
        PDF_STEP_CONTENT_WIDTH / Math.max(1, bitmap.width),
        Math.min(PDF_IMAGE_MAX_HEIGHT, availableHeight) / Math.max(1, bitmap.height),
        1,
      );
      const width = Math.max(1, bitmap.width * scale);
      const height = Math.max(1, bitmap.height * scale);
      const x = PDF_MARGIN + PDF_STEP_INDENT;
      const y = this.cursorY;
      const embeddable = await this.prepareScreenshot(imageBytes, bitmap, width, height);
      if (embeddable) {
        // The rectangle stays blank on the page canvas; emitPage layers the
        // full-resolution JPEG over it, so the ~150dpi raster never softens
        // the screenshot.
        this.pageScreenshots.push({ bytes: embeddable, x, y, width, height });
      } else {
        this.context.drawImage(bitmap, x, y, width, height);
      }
      this.context.strokeStyle = PDF_COLOR_IMAGE_BORDER;
      this.context.lineWidth = PDF_IMAGE_BORDER_WIDTH;
      // The border straddles the image edge: offset by half its width outward.
      this.context.strokeRect(
        x - PDF_IMAGE_BORDER_WIDTH / 2,
        y - PDF_IMAGE_BORDER_WIDTH / 2,
        width + PDF_IMAGE_BORDER_WIDTH,
        height + PDF_IMAGE_BORDER_WIDTH,
      );
      this.cursorY += height + PDF_IMAGE_GAP_AFTER;
      this.hasContent = true;
    } finally {
      bitmap.close();
    }
  }

  /**
   * Chooses the bytes embedded for a screenshot. The composited JPEG from the
   * shared render pipeline is reused untouched whenever the byte budget
   * allows, so no decode/re-encode pass degrades it and the PDF keeps the
   * native capture resolution. Under byte pressure it re-encodes at 2x the
   * layout rectangle (still ~300dpi at print size) with quality 0.92, and as
   * a last resort returns undefined so the caller falls back to drawing into
   * the page raster — degrading resolution instead of failing the export.
   */
  private async prepareScreenshot(
    imageBytes: Uint8Array,
    bitmap: ImageBitmap,
    layoutWidth: number,
    layoutHeight: number,
  ): Promise<Uint8Array | undefined> {
    const budget = this.screenshotByteBudget();
    if (imageBytes.byteLength <= budget) return imageBytes;
    const targetWidth = Math.max(1, Math.min(bitmap.width, Math.round(layoutWidth * 2)));
    const targetHeight = Math.max(1, Math.min(bitmap.height, Math.round(layoutHeight * 2)));
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    const blob = await canvas.convertToBlob({ type: IMAGE_MIME_TYPE, quality: PDF_SCREENSHOT_JPEG_QUALITY });
    throwIfAborted(this.signal);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return bytes.byteLength <= budget ? bytes : undefined;
  }

  /**
   * Bytes one screenshot may add while leaving at least half of the unspent
   * maxPdfBytes budget for page rasters and later screenshots, so a single
   * large capture cannot starve the rest of the project.
   */
  private screenshotByteBudget(): number {
    let pending = 0;
    for (const screenshot of this.pageScreenshots) pending += screenshot.bytes.byteLength;
    return Math.max(0, Math.floor((PROJECT_EXPORT_LIMITS.maxPdfBytes - this.committedBytes - pending) / 2));
  }

  async finish(): Promise<void> {
    if (this.hasContent) await this.flushPage();
  }

  private async ensureSpace(requiredHeight: number): Promise<void> {
    throwIfAborted(this.signal);
    if (this.cursorY + requiredHeight <= PDF_CONTENT_BOTTOM) return;
    await this.startNewPage();
  }

  private applyTextStyle(style: PdfTextStyle): void {
    this.context.font = `${style.weight} ${style.fontSize}px ${PDF_FONT_FAMILY}`;
    this.context.fillStyle = style.color;
    this.context.textBaseline = 'top';
    this.context.textAlign = 'left';
  }

  /** Running footer: hairline, project title on the left, page number right. */
  private drawFooter(): void {
    const context = this.context;
    context.fillStyle = PDF_COLOR_RULE;
    context.fillRect(PDF_MARGIN, PDF_FOOTER_RULE_Y, PDF_CONTENT_WIDTH, PDF_FOOTER_RULE_THICKNESS);
    context.font = `400 ${PDF_FOOTER_FONT_SIZE}px ${PDF_FONT_FAMILY}`;
    context.fillStyle = PDF_COLOR_MUTED;
    context.textBaseline = 'top';
    context.textAlign = 'left';
    const pageLabel = t().export.pageNumber(this.pageNumber);
    const pageLabelWidth = context.measureText(pageLabel).width;
    const maxTitleWidth = Math.max(0, PDF_CONTENT_WIDTH - pageLabelWidth - PDF_FOOTER_TITLE_GAP);
    context.fillText(truncatePdfText(context, this.footerTitle, maxTitleWidth), PDF_MARGIN, PDF_FOOTER_TEXT_Y);
    context.fillText(pageLabel, PDF_PAGE_WIDTH - PDF_MARGIN - pageLabelWidth, PDF_FOOTER_TEXT_Y);
  }

  private async flushPage(): Promise<void> {
    throwIfAborted(this.signal);
    this.pageNumber += 1;
    this.drawFooter();
    const blob = await this.canvas.convertToBlob({ type: IMAGE_MIME_TYPE, quality: PDF_PAGE_RASTER_JPEG_QUALITY });
    throwIfAborted(this.signal);
    const pageBytes = new Uint8Array(await blob.arrayBuffer());
    const screenshots = this.pageScreenshots;
    this.committedBytes += pageBytes.byteLength;
    for (const screenshot of screenshots) this.committedBytes += screenshot.bytes.byteLength;
    this.pageScreenshots = [];
    this.assertWithinBudget();
    await this.emitPage(pageBytes, screenshots);
    throwIfAborted(this.signal);
    this.resetPage();
  }

  /** Single enforcement point for the document budgets: every finished page's
   * raster and screenshot bytes are committed before this check, so no code
   * path can hand bytes to the document without passing it. */
  private assertWithinBudget(): void {
    if (this.pageNumber > PROJECT_EXPORT_LIMITS.maxPdfPages) {
      throw new ProjectExportLimitError('Project PDF exceeds the page limit.');
    }
    if (this.committedBytes > PROJECT_EXPORT_LIMITS.maxPdfBytes) {
      throw new ProjectExportLimitError('Project PDF exceeds the output size limit.');
    }
  }

  private resetPage(): void {
    if (typeof OffscreenCanvas !== 'function') {
      throw new Error('PDF export is not supported in this browser.');
    }
    this.canvas = new OffscreenCanvas(PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT);
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Unable to create a PDF rendering canvas.');
    this.context = context;
    this.context.fillStyle = '#ffffff';
    this.context.fillRect(0, 0, PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT);
    this.cursorY = PDF_MARGIN;
    this.hasContent = false;
  }
}

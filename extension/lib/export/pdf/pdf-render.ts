import { throwIfAborted } from '../../shared/abort';
import { ProjectExportLimitError } from '../project-export-contract';
import { readTypographicMetrics, type PdfFontData, type TypographicMetrics } from './pdf-fonts';
import type { PdfBlock, PdfImage, PdfOutlineEntry, PdfPage, PdfRule, PdfText } from './pdf-layout';
import { PDF_COLORS, PDF_SPEC, POINTS_PER_PIXEL, type PdfTextStyle } from './pdf-spec';

export interface PdfWriterOptions {
  title: string;
  /** Document language, e.g. `zh-Hant`. */
  language: string;
  fonts: PdfFontData;
  maxPages: number;
  maxBytes: number;
  signal?: AbortSignal;
}

type PdfKitDocument = InstanceType<typeof import('pdfkit')>;
type PdfKitModule = {
  default: new (options: Record<string, unknown>) => PdfKitDocument;
  /** The browser build ships no standard font data of its own. */
  registerStdFonts: (...fonts: unknown[]) => void;
};
type StructureElement = ReturnType<PdfKitDocument['struct']>;
/** `PDFKit.PDFOutline`'s item options, which pdfkit's own typings leave out. */
type OutlineItem = {
  addItem(title: string, options?: { expanded?: boolean; top?: number; left?: number }): OutlineItem;
};

const k = POINTS_PER_PIXEL;

/**
 * Draws laid-out pages with PDFKit and collects the file as it is produced.
 * The document is tagged: every heading, paragraph, list and figure goes into
 * the structure tree in reading order (figures with their alternative text),
 * while rules and the running footer are marked as artifacts. Headings also
 * become bookmarks.
 */
export class PdfWriter {
  private readonly parts: BlobPart[] = [];
  private bytes = 0;
  private overLimit = false;
  private pages = 0;
  private readonly metrics: Record<'regular' | 'bold', TypographicMetrics>;
  private readonly structure: StructureElement;
  /** The latest top-level bookmark, which step bookmarks nest under. */
  private bookmarkParent: OutlineItem | undefined;

  private constructor(
    private readonly document: PdfKitDocument,
    private readonly ended: Promise<void>,
    private readonly options: PdfWriterOptions,
  ) {
    this.metrics = { regular: readTypographicMetrics(options.fonts.regular), bold: readTypographicMetrics(options.fonts.bold) };
    document.on('data', (chunk: Uint8Array) => {
      this.bytes += chunk.byteLength;
      if (this.bytes > options.maxBytes) this.overLimit = true;
      else this.parts.push(chunk as Uint8Array<ArrayBuffer>);
    });
    this.structure = document.struct('Document');
    document.addStructure(this.structure);
  }

  static async create(options: PdfWriterOptions): Promise<PdfWriter> {
    const pdfkit = (await import('pdfkit')) as unknown as PdfKitModule;
    // A document opens its default font (Helvetica) when it is created, so that one must be registered.
    const { default: helvetica } = (await import('pdfkit/standard-fonts/Helvetica')) as { default: unknown };
    pdfkit.registerStdFonts(helvetica);
    throwIfAborted(options.signal);

    const document = new pdfkit.default({
      autoFirstPage: false,
      margin: 0,
      lang: options.language,
      displayTitle: true,
      tagged: true,
      pdfVersion: '1.7',
      subset: 'PDF/UA',
      info: { Title: options.title, Creator: 'Howbeam' },
    });
    const ended = new Promise<void>((resolve) => document.on('end', () => resolve()));
    document.registerFont('Regular', options.fonts.regular as unknown as ArrayBuffer);
    document.registerFont('Bold', options.fonts.bold as unknown as ArrayBuffer);
    return new PdfWriter(document, ended, options);
  }

  /** Width of `text` in layout pixels when set in `style`. */
  measure(text: string, style: PdfTextStyle): number {
    this.document.font(fontName(style)).fontSize(style.fontSize * k);
    return this.document.widthOfString(text) / k;
  }

  writePage(page: PdfPage): void {
    throwIfAborted(this.options.signal);
    this.pages += 1;
    if (this.pages > this.options.maxPages) throw new ProjectExportLimitError('Project PDF exceeds the page limit.');

    this.document.addPage({ size: [page.size.widthPoints, page.size.heightPoints], margin: 0 });
    for (const block of page.blocks) this.drawBlock(block, page);
    this.assertWithinBudget();
  }

  async finish(): Promise<Blob> {
    this.structure.end();
    this.document.end();
    await this.ended;
    throwIfAborted(this.options.signal);
    this.assertWithinBudget();
    return new Blob(this.parts, { type: 'application/pdf' });
  }

  private assertWithinBudget(): void {
    if (this.overLimit) throw new ProjectExportLimitError('Project PDF exceeds the output size limit.');
  }

  /** Adds `type` to the structure tree with `draw` as its content; the content is drawn now, on the current page. */
  private tagged(type: string, draw: () => void, options: Record<string, unknown> = {}): StructureElement {
    return this.document.struct(type, options, [draw]);
  }

  private drawBlock(block: PdfBlock, page: PdfPage): void {
    switch (block.kind) {
      case 'heading':
        this.structure.add(this.tagged(`H${block.level}`, () => block.lines.forEach((line) => this.drawText(line))));
        if (block.outline) this.addBookmark(block.outline, block.lines[0].top * k, page.size.widthPoints);
        return;
      case 'paragraph':
        this.structure.add(this.tagged('P', () => block.lines.forEach((line) => this.drawText(line))));
        return;
      case 'list':
        this.structure.add(
          this.document.struct(
            'L',
            {},
            block.items.map((item) =>
              this.document.struct('LI', {}, [
                ...(item.label ? [this.tagged('Lbl', () => this.drawText(item.label!))] : []),
                this.tagged('LBody', () => item.lines.forEach((line) => this.drawText(line))),
              ]),
            ),
          ),
        );
        return;
      case 'figure': {
        const { image } = block;
        const bbox = [image.x * k, image.y * k, (image.x + image.width) * k, (image.y + image.height) * k];
        this.structure.add(this.tagged('Figure', () => this.drawImage(image), { alt: block.alt, bbox }));
        return;
      }
      case 'artifact':
        this.document.markContent('Artifact', block.role === 'pagination' ? { type: 'Pagination', attached: ['Bottom'] } : { type: 'Layout' });
        for (const rule of block.rules) this.drawRule(rule);
        for (const text of block.texts) this.drawText(text);
        this.document.endMarkedContent();
    }
  }

  /** A viewer's outline entry that jumps to the top of the heading it names. */
  private addBookmark({ level, title }: PdfOutlineEntry, top: number, pageWidth: number): void {
    const parent = level === 2 && this.bookmarkParent ? this.bookmarkParent : (this.document.outline as unknown as OutlineItem);
    // pdfkit measures a destination from the page's right edge, so the page width puts it at the left.
    const item = parent.addItem(title, { expanded: true, top, left: pageWidth });
    if (level === 1) this.bookmarkParent = item;
  }

  private drawText({ text, x, top, style }: PdfText): void {
    if (!text) return;
    const { ascent, descent } = this.metrics[style.weight];
    const baseline = top + (style.lineHeight - (ascent + descent) * style.fontSize) / 2 + ascent * style.fontSize;
    this.document
      .font(fontName(style))
      .fontSize(style.fontSize * k)
      .fillColor(style.color)
      .text(text, x * k, baseline * k, { lineBreak: false, baseline: 'alphabetic' });
  }

  private drawRule({ x, y, width, height, color }: PdfRule): void {
    this.document.rect(x * k, y * k, width * k, height * k).fill(color);
  }

  private drawImage({ bytes, x, y, width, height }: PdfImage): void {
    const border = PDF_SPEC.imageBorderWidth;
    this.document.save();
    this.document.roundedRect(x * k, y * k, width * k, height * k, PDF_SPEC.imageRadius * k).clip();
    this.document.image(bytes as unknown as ArrayBuffer, x * k, y * k, { width: width * k, height: height * k });
    this.document.restore();
    // The border straddles the image edge: offset by half its width outward.
    this.document
      .lineWidth(border * k)
      .strokeColor(PDF_COLORS.imageBorder)
      .roundedRect((x - border / 2) * k, (y - border / 2) * k, (width + border) * k, (height + border) * k, (PDF_SPEC.imageRadius + border / 2) * k)
      .stroke();
  }
}

const fontName = (style: PdfTextStyle) => (style.weight === 'bold' ? 'Bold' : 'Regular');

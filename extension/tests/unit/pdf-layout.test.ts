import { describe, expect, it } from 'vitest';
import { PdfLayouter, type LayoutStep, type PdfBlock, type PdfPage } from '@/lib/export/pdf/pdf-layout';
import { PDF_SPEC, PDF_TEXT, POINTS_PER_PIXEL } from '@/lib/export/pdf/pdf-spec';
import { DEFAULT_PDF_EXPORT_SETTINGS, type PdfExportSettings } from '@/lib/export/pdf-export-settings';

/** 14 layout pixels per code point: a 1072px-wide A4 text column holds 76 characters. */
const measure = (text: string) => Array.from(text).length * 14;

function newLayouter(settings: Partial<PdfExportSettings> = {}, signal?: AbortSignal) {
  return new PdfLayouter({
    settings: { ...DEFAULT_PDF_EXPORT_SETTINGS, ...settings },
    measure,
    footerTitle: 'My project',
    labels: { pageNumber: (page) => `Page ${page}`, credit: 'Made with Howbeam', missingDescription: '(No description)' },
    signal,
  });
}

function step(ordinal: number, overrides: Partial<LayoutStep> = {}, size = { width: 1_000, height: 500 }): LayoutStep {
  return {
    ordinal,
    heading: `Step ${ordinal}`,
    image: { bytes: new Uint8Array([ordinal]), ...size },
    alt: `Step ${ordinal}`,
    annotations: [],
    ...overrides,
  };
}

function laidOut(layouter: PdfLayouter): PdfPage[] {
  layouter.finish();
  return layouter.takePages();
}

type Kind = PdfBlock['kind'];
const ofKind = <K extends Kind>(page: PdfPage, kind: K) => page.blocks.filter((block): block is Extract<PdfBlock, { kind: K }> => block.kind === kind);
const headings = (page: PdfPage, level?: 1 | 2 | 3) => ofKind(page, 'heading').filter((block) => !level || block.level === level);
const headingTexts = (page: PdfPage, level?: 1 | 2 | 3) => headings(page, level).flatMap((block) => block.lines.map((line) => line.text));
const paragraphTexts = (page: PdfPage) => ofKind(page, 'paragraph').flatMap((block) => block.lines.map((line) => line.text));
const listTexts = (page: PdfPage) =>
  ofKind(page, 'list').flatMap((block) => block.items.flatMap((item) => [...(item.label ? [item.label.text] : []), ...item.lines.map((line) => line.text)]));
const artifacts = (page: PdfPage) => ofKind(page, 'artifact');
const artifactTexts = (page: PdfPage, role?: 'layout' | 'pagination') =>
  artifacts(page).filter((block) => !role || block.role === role).flatMap((block) => block.texts.map((text) => text.text));
const artifactRules = (page: PdfPage) => artifacts(page).flatMap((block) => block.rules);
const figures = (page: PdfPage) => ofKind(page, 'figure');
const images = (page: PdfPage) => figures(page).map((figure) => figure.image);

describe('PdfLayouter', () => {
  describe('one step per page', () => {
    it('gives every step its own page and merges the title block into the first', () => {
      const layouter = newLayouter();
      layouter.addTitleBlock('Setup guide', 'A short description');
      layouter.addStep(step(1));
      layouter.addStep(step(2));
      layouter.addStep(step(3));
      const pages = laidOut(layouter);

      expect(pages.map((page) => page.number)).toEqual([1, 2, 3]);
      expect(headingTexts(pages[0], 1)).toEqual(['Setup guide']);
      expect(paragraphTexts(pages[0])).toEqual(['A short description']);
      expect(headingTexts(pages[0], 2)).toEqual(['1.', 'Step 1']);
      expect(headingTexts(pages[1], 2)).toEqual(['2.', 'Step 2']);
      expect(headingTexts(pages[2], 1)).toEqual([]);
    });

    it('hands pages over as they complete, not before', () => {
      const layouter = newLayouter();
      layouter.addTitleBlock('T', '');
      layouter.addStep(step(1));
      expect(layouter.takePages()).toEqual([]);

      layouter.addStep(step(2));
      expect(layouter.takePages().map((page) => page.number)).toEqual([1]);
      expect(layouter.takePages()).toEqual([]);

      layouter.finish();
      expect(layouter.takePages().map((page) => page.number)).toEqual([2]);
      expect(layouter.pagesFinished).toBe(2);
    });

    it('lays out a project with no steps as a single title page', () => {
      const layouter = newLayouter();
      layouter.addTitleBlock('Empty project', '');
      const pages = laidOut(layouter);

      expect(pages).toHaveLength(1);
      expect(headingTexts(pages[0], 1)).toEqual(['Empty project']);
    });
  });

  describe('continuous flow', () => {
    it('lets steps share a page and breaks only where a step no longer fits', () => {
      const layouter = newLayouter({ stepLayout: 'continuous' });
      layouter.addTitleBlock('T', '');
      for (const ordinal of [1, 2, 3]) layouter.addStep(step(ordinal));
      const pages = laidOut(layouter);

      expect(pages).toHaveLength(2);
      expect(headingTexts(pages[0], 2)).toEqual(['1.', 'Step 1', '2.', 'Step 2']);
      // The third step moves to a new page as a whole: its heading and screenshot stay together.
      expect(headingTexts(pages[1], 2)).toEqual(['3.', 'Step 3']);
      expect(images(pages[1])).toHaveLength(1);
    });

    it('separates flowing steps by a fixed gap', () => {
      const layouter = newLayouter({ stepLayout: 'continuous' });
      layouter.addStep(step(1));
      layouter.addStep(step(2));
      const [page] = laidOut(layouter);

      const [first, second] = images(page);
      expect(second.y - (first.y + first.height)).toBe(
        PDF_SPEC.imageGapAfter + PDF_SPEC.continuousStepGap + 52 + 22,
      );
    });

    it('does not squeeze a tall screenshot into the leftover strip of a page', () => {
      const layouter = newLayouter({ stepLayout: 'continuous' });
      layouter.addStep(step(1, {}, { width: 1_000, height: 900 }));
      layouter.addStep(step(2, {}, { width: 1_000, height: 900 }));
      const pages = laidOut(layouter);

      expect(pages).toHaveLength(2);
      for (const page of pages) expect(images(page)[0].height).toBe(900);
    });
  });

  describe('continuous flow on a short page', () => {
    it('shrinks a screenshot a little instead of leaving the title page empty', () => {
      const layouter = newLayouter({ paper: 'letter', orientation: 'landscape', stepLayout: 'continuous' });
      layouter.addTitleBlock('Landscape guide', 'A description');
      layouter.addStep(step(1, { section: { title: 'Chapter' } }, { width: 1_600, height: 900 }));
      const pages = laidOut(layouter);

      expect(pages).toHaveLength(1);
      const [image] = images(pages[0]);
      const preferred = Math.ceil((1_650 - PDF_SPEC.margin * 2 - PDF_SPEC.stepIndent) / 1_600 * 900);
      expect(image.height).toBeLessThan(preferred);
      expect(image.height).toBeGreaterThanOrEqual(preferred * PDF_SPEC.continuousImageMinShare);
      expect(image.width / image.height).toBeCloseTo(1_600 / 900);
    });

    it('still starts a new page when the screenshot would have to shrink below that share', () => {
      const layouter = newLayouter({ stepLayout: 'continuous' });
      layouter.addTitleBlock('T', '');
      layouter.addStep(step(1, {}, { width: 1_000, height: 900 }));
      layouter.addStep(step(2, {}, { width: 1_000, height: 900 }));
      const pages = laidOut(layouter);

      expect(pages).toHaveLength(2);
      expect(images(pages[1])[0].height).toBe(900);
    });
  });

  describe('screenshots', () => {
    it('scales a wide screenshot to the step column and never enlarges a small one', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1, {}, { width: 2_000, height: 1_000 }));
      layouter.addStep(step(2, {}, { width: 400, height: 300 }));
      const pages = laidOut(layouter);

      const stepColumn = pages[0].size.widthPixels - PDF_SPEC.margin * 2 - PDF_SPEC.stepIndent;
      expect(images(pages[0])[0].x).toBe(PDF_SPEC.margin + PDF_SPEC.stepIndent);
      expect(images(pages[0])[0].width).toBeCloseTo(stepColumn);
      expect(images(pages[0])[0].height).toBeCloseTo(stepColumn / 2);
      expect(images(pages[1])[0]).toMatchObject({ width: 400, height: 300 });
    });

    it('caps a tall screenshot at the maximum height', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1, {}, { width: 600, height: 4_000 }));
      const [page] = laidOut(layouter);

      expect(images(page)[0].height).toBeLessThanOrEqual(PDF_SPEC.imageMaxHeight);
      expect(images(page)[0].width / images(page)[0].height).toBeCloseTo(600 / 4_000);
    });

    it('carries the step description as the figure alternative text', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1, { alt: 'Open the settings page' }));
      const [page] = laidOut(layouter);

      expect(figures(page)[0].alt).toBe('Open the settings page');
    });
  });

  describe('sections and headings', () => {
    it('prints a section title and rule before its first step', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1, { section: { title: 'Getting started' } }));
      const [page] = laidOut(layouter);

      const order = page.blocks.map((block) => block.kind);
      expect(headingTexts(page, 2)).toEqual(['Getting started']);
      expect(headingTexts(page, 3)).toEqual(['1.', 'Step 1']);
      expect(order.indexOf('heading')).toBeLessThan(order.indexOf('figure'));
      expect(artifactRules(page).some((rule) => rule.height === PDF_SPEC.sectionRuleThickness)).toBe(true);
    });

    it('nests step headings one level under a section, and keeps steps before the first section at the top', () => {
      const layouter = newLayouter();
      layouter.addTitleBlock('Guide', '');
      layouter.addStep(step(1));
      layouter.addStep(step(2, { section: { title: 'Chapter one' } }));
      layouter.addStep(step(3));
      const pages = laidOut(layouter);

      // The title is H1, so nothing ever skips a level.
      expect(headings(pages[0]).map((block) => block.level)).toEqual([1, 2]);
      expect(headings(pages[1]).map((block) => block.level)).toEqual([2, 3]);
      expect(headings(pages[2]).map((block) => block.level)).toEqual([3]);
    });

    it('bookmarks every section and step, with steps nested under their section', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1, { heading: 'Open settings' }));
      layouter.addStep(step(2, { heading: 'Sign in', section: { title: 'Chapter one' } }));
      layouter.addStep(step(3, { heading: '' }));
      const outline = laidOut(layouter).flatMap((page) => headings(page).flatMap((block) => (block.outline ? [block.outline] : [])));

      expect(outline).toEqual([
        { level: 1, title: '1. Open settings' },
        { level: 1, title: 'Chapter one' },
        { level: 2, title: '2. Sign in' },
        { level: 2, title: '3.' },
      ]);
    });

    it('shortens a very long step heading for its bookmark without cutting a character in two', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1, { heading: '👩‍👩‍👧‍👦'.repeat(200) }));
      const [page] = laidOut(layouter);

      const title = headings(page)[0].outline!.title;
      expect([...new Intl.Segmenter().segment(title)].length).toBe(100);
      expect(title.endsWith('…')).toBe(true);
      expect(title.isWellFormed()).toBe(true);
    });

    it('moves the section title together with its step when the page has no room left', () => {
      const layouter = newLayouter();
      // 18 wrapped title lines leave the cursor where a heading still fits but the screenshot does not.
      layouter.addTitleBlock('a'.repeat(76 * 18), '');
      layouter.addStep(step(1, { section: { title: 'Chapter one' } }));
      const pages = laidOut(layouter);

      expect(pages).toHaveLength(2);
      expect(headingTexts(pages[0], 2)).toEqual([]);
      expect(headingTexts(pages[0], 3)).toEqual([]);
      expect(headingTexts(pages[1], 2)).toEqual(['Chapter one']);
      expect(headingTexts(pages[1], 3)).toEqual(['1.', 'Step 1']);
    });
  });

  describe('step heading and annotations', () => {
    it('hangs the printed number left of the title, which wraps in its own column', () => {
      const layouter = newLayouter();
      layouter.addStep(step(7, { heading: 'x'.repeat(160) }));
      const [page] = laidOut(layouter);

      const [heading] = headings(page);
      expect(heading.lines[0]).toMatchObject({ text: '7.', x: PDF_SPEC.margin });
      expect(heading.lines.slice(1).every((line) => line.x === PDF_SPEC.margin + PDF_SPEC.stepIndent)).toBe(true);
      expect(heading.lines.length).toBeGreaterThan(2);
    });

    it('lists annotations as one numbered list under the screenshot', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1, { annotations: [{ description: 'Click Sign in' }, { description: '' }] }));
      const [page] = laidOut(layouter);

      expect(ofKind(page, 'list')).toHaveLength(1);
      expect(listTexts(page)).toEqual(['1. ', 'Click Sign in', '2. ', '(No description)']);
    });

    it('starts a fresh list on the next page when the annotations run past the foot of a page', () => {
      const layouter = newLayouter();
      const annotations = Array.from({ length: 8 }, (_, index) => ({ description: `Annotation ${index + 1} ${'word '.repeat(60)}` }));
      layouter.addStep(step(1, { annotations }, { width: 1_000, height: 700 }));
      const pages = laidOut(layouter);

      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages.slice(1)) expect(ofKind(page, 'list').length).toBeGreaterThan(0);
      // Every annotation still appears exactly once, labelled where it begins.
      const labels = pages.flatMap((page) => ofKind(page, 'list').flatMap((list) => list.items.flatMap((item) => (item.label ? [item.label.text] : []))));
      expect(labels).toEqual(Array.from({ length: 8 }, (_, index) => `${index + 1}. `));
    });

    const listItems = (page: PdfPage) => ofKind(page, 'list').flatMap((list) => list.items);

    it('puts short descriptions in the columns that make the list shortest, numbered down each column', () => {
      const layouter = newLayouter();
      // 'Mark an area of the page' plus the widest label is 392px: three columns of an A4 step column would wrap
      // every one to two lines (taller overall), two keep each on one line.
      const annotations = Array.from({ length: 16 }, () => ({ description: 'Mark an area of the page' }));
      layouter.addStep(step(1, { annotations }, { width: 1_000, height: 300 }));
      const [page] = laidOut(layouter);

      const items = listItems(page);
      expect(items.map((item) => item.label!.text)).toEqual(Array.from({ length: 16 }, (_, index) => `${index + 1}. `));
      const columnX = [...new Set(items.map((item) => item.label!.x))];
      expect(columnX).toHaveLength(2);
      expect(items.slice(0, 8).every((item) => item.label!.x === columnX[0])).toBe(true);
      // Item 9 starts the second column on the row of item 1.
      expect(items[8].label!.top).toBe(items[0].label!.top);
      expect(items[15].label!.top).toBe(items[7].label!.top);
    });

    it('lines every description up after the widest number', () => {
      const layouter = newLayouter();
      const annotations = Array.from({ length: 10 }, (_, index) => ({ description: `Marker ${index + 1}` }));
      layouter.addStep(step(1, { annotations }));
      const [page] = laidOut(layouter);

      const items = listItems(page);
      const offsets = new Set(items.map((item) => item.lines[0].x - item.label!.x));
      expect(offsets).toEqual(new Set([measure('10. ')]));
    });

    it('lets a longer description wrap to two lines inside its column', () => {
      const layouter = newLayouter();
      const annotations = [...Array.from({ length: 7 }, () => ({ description: 'Short' })), { description: 'word '.repeat(10) }];
      layouter.addStep(step(1, { annotations }));
      const [page] = laidOut(layouter);

      const items = listItems(page);
      expect(new Set(items.map((item) => item.label!.x)).size).toBe(2);
      expect(items[7].lines).toHaveLength(2);
      // The columns are balanced by height, so the two-line item's column holds one marker fewer.
      expect(items.filter((item) => item.label!.x === items[7].label!.x)).toHaveLength(4);
      expect(items[4].label!.top).toBe(items[0].label!.top);
    });

    it('runs a description too long for a column across the full width, with the columns resuming after it', () => {
      const layouter = newLayouter();
      const short = Array.from({ length: 4 }, () => ({ description: 'Short' }));
      layouter.addStep(step(1, { annotations: [...short, { description: 'word '.repeat(40) }, ...short] }));
      const [page] = laidOut(layouter);

      const items = listItems(page);
      const left = PDF_SPEC.margin + PDF_SPEC.stepIndent;
      const long = items[4];
      expect(long.label!.x).toBe(left);
      expect(long.lines.length).toBeGreaterThan(2);
      expect(Math.max(...long.lines.map((line) => measure(line.text)))).toBeGreaterThan(page.size.widthPixels / 2);
      // Markers 1–4 sit in two columns above it, 6–9 in two columns below it.
      for (const group of [items.slice(0, 4), items.slice(5)]) expect(new Set(group.map((item) => item.label!.x)).size).toBe(2);
      expect(items[3].label!.top).toBeLessThan(long.label!.top);
      expect(items[5].label!.top).toBeGreaterThan(long.lines.at(-1)!.top);
    });

    it('keeps one column for a list too short to fill two rows of columns', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1, { annotations: [{ description: 'One' }, { description: 'Two' }, { description: 'Three' }] }));
      const [page] = laidOut(layouter);

      expect(new Set(listItems(page).map((item) => item.label!.x)).size).toBe(1);
    });

    it('continues the columns on the next page, every marker once and in order', () => {
      const layouter = newLayouter();
      const annotations = Array.from({ length: 60 }, (_, index) => ({ description: `Marker ${index + 1}` }));
      layouter.addStep(step(1, { annotations }, { width: 1_000, height: 700 }));
      const pages = laidOut(layouter);

      expect(pages.length).toBeGreaterThan(1);
      const labels = pages.flatMap((page) => listItems(page).map((item) => item.label!.text));
      expect(labels).toEqual(Array.from({ length: 60 }, (_, index) => `${index + 1}. `));
      for (const page of pages) {
        const lowest = Math.max(...listItems(page).map((item) => item.label!.top + PDF_TEXT.annotation.lineHeight));
        expect(lowest).toBeLessThanOrEqual(page.size.heightPixels - PDF_SPEC.footerZone);
      }
    });
  });

  describe('artifacts and the footer', () => {
    it('marks rules and the running footer as artifacts, never as reading-order content', () => {
      const layouter = newLayouter();
      layouter.addTitleBlock('T', 'D');
      layouter.addStep(step(1, { section: { title: 'S' } }));
      const [page] = laidOut(layouter);

      expect(artifacts(page).map((block) => block.role)).toEqual(['layout', 'layout', 'pagination']);
      for (const block of page.blocks) {
        if (block.kind === 'artifact') continue;
        expect(JSON.stringify(block)).not.toContain('Made with Howbeam');
      }
    });

    it('puts the title, the credit and the page number on every page', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1));
      layouter.addStep(step(2));
      const pages = laidOut(layouter);

      pages.forEach((page, index) => {
        expect(artifactTexts(page, 'pagination')).toEqual(['My project', 'Made with Howbeam', `Page ${index + 1}`]);
      });
    });

    it('drops the title and page number but keeps the rule and the credit', () => {
      const layouter = newLayouter({ showFooter: false });
      layouter.addStep(step(1));
      const [page] = laidOut(layouter);

      expect(artifactTexts(page, 'pagination')).toEqual(['Made with Howbeam']);
      expect(artifactRules(page).some((rule) => rule.height === PDF_SPEC.footerRuleThickness)).toBe(true);
    });

    it('centres the credit and right-aligns the page number to the margin', () => {
      const layouter = newLayouter();
      layouter.addStep(step(1));
      const [page] = laidOut(layouter);

      const footer = artifacts(page).find((block) => block.role === 'pagination')!.texts;
      const credit = footer.find((text) => text.text === 'Made with Howbeam')!;
      const label = footer.find((text) => text.text === 'Page 1')!;
      expect(credit.x + measure(credit.text) / 2).toBeCloseTo(page.size.widthPixels / 2);
      expect(label.x + measure(label.text)).toBeCloseTo(page.size.widthPixels - PDF_SPEC.margin);
    });

    it('truncates a long project title so it never reaches the credit', () => {
      const layouter = new PdfLayouter({
        settings: DEFAULT_PDF_EXPORT_SETTINGS,
        measure,
        footerTitle: 'x'.repeat(500),
        labels: { pageNumber: (page) => `Page ${page}`, credit: 'Made with Howbeam', missingDescription: '' },
      });
      layouter.addStep(step(1));
      const [page] = laidOut(layouter);

      const [title] = artifactTexts(page, 'pagination');
      expect(title.endsWith('…')).toBe(true);
      expect(measure(title)).toBeLessThan(page.size.widthPixels / 2);
    });
  });

  describe('paper', () => {
    it.each([
      ['a4', 'portrait', 595.28, 841.89],
      ['a4', 'landscape', 841.89, 595.28],
      ['letter', 'portrait', 612, 792],
      ['letter', 'landscape', 792, 612],
    ] as const)('lays out %s %s on a %f x %f point page', (paper, orientation, widthPoints, heightPoints) => {
      const layouter = newLayouter({ paper, orientation });
      layouter.addStep(step(1));
      const [page] = laidOut(layouter);

      // The layout pixels are the point size at 150dpi, so the two always agree.
      const { widthPixels, heightPixels } = page.size;
      expect(page.size).toMatchObject({ widthPoints, heightPoints });
      expect(widthPixels * POINTS_PER_PIXEL).toBeCloseTo(widthPoints, 6);
      expect(heightPixels * POINTS_PER_PIXEL).toBeCloseTo(heightPoints, 6);
      const bottoms = images(page).map((image) => image.y + image.height);
      expect(Math.max(...bottoms)).toBeLessThanOrEqual(heightPixels - PDF_SPEC.footerZone);
    });
  });

  it('stops when the export is cancelled', () => {
    const controller = new AbortController();
    const layouter = newLayouter({}, controller.signal);
    layouter.addStep(step(1));

    controller.abort();

    expect(() => layouter.addStep(step(2))).toThrow(/abort/i);
  });
});

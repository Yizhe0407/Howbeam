import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@/lib/shared/i18n';
import { type StepEntry } from '@/lib/storage/models';
import { jpegOfSize } from '../setup/jpeg-fixture';
import { readPdf, type StructureNode } from '../setup/pdf-extract';
import { readDiskFonts } from '../setup/pdf-fonts';

const mocks = vi.hoisted(() => ({
  composite: vi.fn(),
  loadFonts: vi.fn(),
}));

vi.mock('@/lib/export/entry-render', () => ({ compositeStepEntry: mocks.composite }));
vi.mock('@/lib/export/pdf/pdf-fonts', async (original) => ({
  ...(await original<typeof import('@/lib/export/pdf/pdf-fonts')>()),
  loadPdfFonts: mocks.loadFonts,
}));

// Shrink only the PDF budgets so the limits are reachable with a handful of pages.
const LIMITS = vi.hoisted(() => ({ maxPdfBytes: 128 * 1024 * 1024, maxPdfPages: 4_000 }));
vi.mock('@/lib/export/project-export-contract', async (original) => {
  const actual = await original<typeof import('@/lib/export/project-export-contract')>();
  return {
    ...actual,
    PROJECT_EXPORT_LIMITS: {
      ...actual.PROJECT_EXPORT_LIMITS,
      get maxPdfBytes() {
        return LIMITS.maxPdfBytes;
      },
      get maxPdfPages() {
        return LIMITS.maxPdfPages;
      },
    },
  };
});

import { ProjectExportLimitError } from '@/lib/export/project-export-contract';
import { StepImageError } from '@/lib/export/export-errors';
import { generateProjectPdf } from '@/lib/export/project-export-pdf';

function entry(id: string, order: number, description: string): StepEntry {
  return {
    kind: 'single',
    step: {
      id,
      sessionId: 'session-1',
      order,
      screenshotBlob: new Blob(['source'], { type: 'image/jpeg' }),
      bounds: null,
      devicePixelRatio: 1,
      description,
      url: 'https://example.com/settings',
      timestamp: order,
    },
  } as StepEntry;
}

/** Snapshot group: an anchor owning the screenshot plus numbered annotations. */
function groupEntry(id: string, order: number, description: string, annotations: string[]): StepEntry {
  return {
    kind: 'group',
    anchor: {
      id,
      sessionId: 'session-1',
      groupId: id,
      order,
      screenshotBlob: new Blob(['source'], { type: 'image/jpeg' }),
      bounds: null,
      devicePixelRatio: 1,
      description,
      url: 'https://example.com/settings',
      timestamp: order,
    },
    annotations: annotations.map((text, index) => ({
      id: `${id}-annotation-${index}`,
      sessionId: 'session-1',
      groupId: id,
      order: order + index + 1,
      bounds: { x: 10 * (index + 1), y: 20, width: 30, height: 40 },
      devicePixelRatio: 1,
      description: text,
      url: 'https://example.com/settings',
      timestamp: order + index + 1,
    })),
  } as StepEntry;
}

const screenshot = () => new Blob([jpegOfSize(1_200, 700)], { type: 'image/jpeg' });
const A4 = { width: 595.28, height: 841.89 };

beforeEach(() => {
  mocks.composite.mockReset().mockImplementation(async () => screenshot());
  mocks.loadFonts.mockReset().mockImplementation(readDiskFonts);
  LIMITS.maxPdfBytes = 128 * 1024 * 1024;
  LIMITS.maxPdfPages = 4_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateProjectPdf', () => {
  it('produces an A4 document with one page per step and real, selectable text in CJK, English and punctuation', async () => {
    const entries = [
      entry('step-1', 1, '點擊瀏覽器工具列上的擴充功能圖示，開啟設定頁面。'),
      entry('step-2', 2, 'Open the extension settings and enable automatic capture for every tab.'),
      entry('step-3', 3, '完成後按下「儲存」，並與團隊分享。'),
    ];

    const pdf = await generateProjectPdf(entries, { title: '安裝指南 Setup Project', description: '本指南示範 how mixed-script text stays text.' });
    const read = await readPdf(pdf);

    expect(pdf.type).toBe('application/pdf');
    expect(read.pages).toHaveLength(3);
    for (const page of read.pages) {
      expect(page.width).toBeCloseTo(A4.width, 1);
      expect(page.height).toBeCloseTo(A4.height, 1);
    }
    expect(read.title).toBe('安裝指南 Setup Project');
    expect(read.pages[0].lines.join('\n')).toContain('安裝指南 Setup Project');
    expect(read.pages[0].lines.join('\n')).toContain('本指南示範 how mixed-script text stays text.');
    expect(read.pages[0].lines.join('\n')).toContain('點擊瀏覽器工具列上的擴充功能圖示，開啟設定頁面。');
    // A long English sentence wraps at word boundaries, so compare it with the line breaks folded.
    expect(read.pages[1].lines.join(' ')).toContain('Open the extension settings and enable automatic capture for every tab.');
    expect(read.pages[2].lines.join('\n')).toContain('完成後按下「儲存」，並與團隊分享。');
  });

  it('prints the step number, a running footer with the credit and a numbered page on every page', async () => {
    const entries = [entry('step-1', 1, 'First'), entry('step-2', 2, 'Second')];

    const read = await readPdf(await generateProjectPdf(entries, { title: 'Footer test' }));

    read.pages.forEach((page, index) => {
      const text = page.lines.join('\n');
      expect(text).toContain(`${index + 1}.`);
      expect(text).toContain('Footer test');
      expect(text).toContain('Made with Howbeam');
      expect(text).toContain(`第 ${index + 1} 頁`);
    });
  });

  it('embeds the two fonts as subsets and the screenshots untouched, so a document costs kilobytes', async () => {
    const pdf = await generateProjectPdf([entry('step-1', 1, '設定 Settings'), entry('step-2', 2, 'Second')], { title: 'Size' });
    const bytes = Buffer.from(await pdf.arrayBuffer()).toString('latin1');

    expect(bytes).toMatch(/\+HowbeamSansTC-Bold/);
    expect(bytes).toMatch(/\+HowbeamSansTC-Regular/);
    expect(pdf.size).toBeLessThan(200 * 1024);
    // Both pages embed the screenshot bytes the compositor returned.
    expect(bytes.match(/\/Subtype \/Image/g)).toHaveLength(2);
  });

  it('marks the document with the interface language', async () => {
    const read = await readPdf(await generateProjectPdf([entry('step-1', 1, 'x')], { title: 'Lang' }));

    expect(read.language).toBe('zh-Hant');
  });

  it('falls back to the default title for an untitled project', async () => {
    const read = await readPdf(await generateProjectPdf([entry('step-1', 1, 'x')], { title: '   ' }));

    expect(read.title).toBe('Howbeam Project');
  });

  it('still produces a titled single page for a project with no steps', async () => {
    const read = await readPdf(await generateProjectPdf([], { title: 'Nothing yet' }));

    expect(read.pages).toHaveLength(1);
    expect(read.pages[0].lines.join('\n')).toContain('Nothing yet');
    expect(mocks.composite).not.toHaveBeenCalled();
  });

  describe('options', () => {
    const three = [entry('a', 1, 'First'), entry('b', 2, 'Second'), entry('c', 3, 'Third')];

    it.each([
      ['a4', 'landscape', 841.89, 595.28],
      ['letter', 'portrait', 612, 792],
      ['letter', 'landscape', 792, 612],
    ] as const)('lays out %s %s pages at %f x %f points', async (paper, orientation, width, height) => {
      const read = await readPdf(await generateProjectPdf(three, { title: 'Paper' }, { settings: { paper, orientation } }));

      expect(read.pages).toHaveLength(3);
      for (const page of read.pages) {
        expect(page.width).toBeCloseTo(width, 1);
        expect(page.height).toBeCloseTo(height, 1);
      }
    });

    it('lets steps share pages in continuous layout', async () => {
      const perStep = await readPdf(await generateProjectPdf(three, { title: 'Flow' }));
      const continuous = await readPdf(await generateProjectPdf(three, { title: 'Flow' }, { settings: { stepLayout: 'continuous' } }));

      expect(perStep.pages).toHaveLength(3);
      expect(continuous.pages.length).toBeLessThan(3);
      expect(continuous.pages.flatMap((page) => page.lines).join('\n')).toContain('Third');
    });

    it('drops the footer title and page number but keeps the credit', async () => {
      const read = await readPdf(await generateProjectPdf(three, { title: 'Quiet footer' }, { settings: { showFooter: false } }));
      const text = read.pages.flatMap((page) => page.lines).join('\n');

      expect(text).toContain('Made with Howbeam');
      expect(text).not.toContain('第 1 頁');
      // The title still opens the document; it is just no longer repeated per page.
      expect(text.match(/Quiet footer/g)).toHaveLength(1);
    });

  });

  it('prints section headings before their steps and numbers group annotations', async () => {
    const entries = [entry('step-1', 1, '開啟設定頁面'), groupEntry('anchor-1', 2, '標記快照重點', ['點擊登入按鈕', '輸入電子郵件'])];

    const read = await readPdf(
      await generateProjectPdf(entries, {
        title: '章節指南',
        sections: [
          { id: 'section-1', title: '第一章 前置作業', startEntryId: 'step-1' },
          { id: 'section-2', title: '第二章 快照標記', startEntryId: 'anchor-1' },
        ],
      }),
    );

    expect(read.pages).toHaveLength(2);
    const first = read.pages[0].lines.join('\n');
    expect(first.indexOf('第一章 前置作業')).toBeLessThan(first.indexOf('開啟設定頁面'));
    const second = read.pages[1].lines.join('\n');
    expect(second).toContain('第二章 快照標記');
    expect(second).toMatch(/1\. ?點擊登入按鈕/);
    expect(second).toMatch(/2\. ?輸入電子郵件/);
  });

  describe('marker columns, measured with the real fonts', () => {
    const LONG = 'Open the account settings page, choose Security, then change the password and confirm it with the code sent to your phone before saving.';
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

    /** Each page's marker numbers with where they sit, and every text run drawn on it. */
    async function laidOutMarkers(notes: string[]) {
      const read = await readPdf(await generateProjectPdf([groupEntry('mark', 1, 'Mark', notes)], { title: 'Columns' }));
      return read.pages.map((page) => {
        // The step's own number hangs in the margin; marker numbers start at the step indent.
        const markers = page.items
          .filter((item) => /^\d+\.\s*$/.test(item.text) && item.x > 60)
          .map((item) => ({ number: Number.parseInt(item.text, 10), x: Math.round(item.x), y: item.y }));
        return { markers, texts: page.items.map((item) => item.text) };
      });
    }
    type Marker = Awaited<ReturnType<typeof laidOutMarkers>>[number]['markers'][number];
    const columnsOf = (markers: Marker[], numbers: number[]) => new Set(markers.filter((marker) => numbers.includes(marker.number)).map((marker) => marker.x)).size;
    const marker = (markers: Marker[], number: number) => markers.find((candidate) => candidate.number === number)!;

    it('puts mixed short descriptions in two columns without wrapping any', async () => {
      const notes = ['Save', 'Click the blue Sign in button', 'Menu', 'Search box at the top', 'OK', 'Language switcher', 'Profile picture', 'Help', 'Close the dialog window', 'Tab'];
      const [page] = await laidOutMarkers(notes);

      expect(columnsOf(page.markers, range(1, 10))).toBe(2);
      for (const note of notes) expect(page.texts).toContain(note);
    });

    it('keeps a CJK description whole rather than squeezing it into a third column', async () => {
      const notes = ['儲存', '點擊右上角的登入按鈕', 'Menu', '搜尋框', 'OK', '語言切換 Language', '個人頭像', 'Help', '關閉對話框', '分頁 Tab'];
      const [page] = await laidOutMarkers(notes);

      expect(columnsOf(page.markers, range(1, 10))).toBe(2);
      for (const note of notes) expect(page.texts).toContain(note);
    });

    it('runs a very long description across the full width, with columns before and after it', async () => {
      const [page] = await laidOutMarkers(['Save', 'Menu', 'OK', 'Help', 'Tab', LONG, 'Back', 'Next', 'Edit', 'Done']);

      expect(columnsOf(page.markers, range(1, 5))).toBe(2);
      expect(columnsOf(page.markers, range(7, 10))).toBe(2);
      const long = marker(page.markers, 6);
      expect(long.x).toBe(Math.min(...page.markers.map((candidate) => candidate.x)));
      expect(Math.max(...range(1, 5).map((number) => marker(page.markers, number).y))).toBeLessThan(long.y);
      expect(Math.min(...range(7, 10).map((number) => marker(page.markers, number).y))).toBeGreaterThan(long.y);
    });

    it('keeps markers between long ones in one column when they are too few for two rows of columns', async () => {
      const url = 'https://example.com/a/very/long/url/without/any/spaces/that/cannot/wrap/anywhere/at/all/really';
      const [page] = await laidOutMarkers(['', 'Save', '', url, 'OK', '', 'Help', 'Tab']);

      expect(columnsOf(page.markers, range(1, 4))).toBe(1);
      expect(columnsOf(page.markers, range(5, 8))).toBe(2);
    });

    it('keeps one column when long and short descriptions alternate', async () => {
      const [page] = await laidOutMarkers(['Save', LONG, 'Menu', LONG, 'OK', LONG, 'Help']);

      expect(columnsOf(page.markers, range(1, 7))).toBe(1);
    });

    it('fits sixteen short markers under the screenshot on one page', async () => {
      const english = await laidOutMarkers([...Array.from({ length: 15 }, () => 'Mark an area of the page'), 'asdfasdfasdf']);
      const chinese = await laidOutMarkers([...Array.from({ length: 15 }, () => '標記頁面區域'), 'asdfasdfasdf']);

      expect(english).toHaveLength(1);
      expect(columnsOf(english[0].markers, range(1, 16))).toBe(2);
      expect(chinese).toHaveLength(1);
      expect(columnsOf(chinese[0].markers, range(1, 16))).toBe(3);
    });

    it('carries columns over a page break with every marker once and in order', async () => {
      const notes = Array.from({ length: 70 }, (_, index) => ['A', 'Go', 'Save', 'Edit it', 'Open menu', '搜尋框', 'Open the account settings page now'][index % 7]);
      const pages = await laidOutMarkers(notes);

      expect(pages.length).toBeGreaterThan(1);
      const numbers = pages.flatMap((page) => [...page.markers].sort((left, right) => left.x - right.x || left.y - right.y).map((candidate) => candidate.number));
      expect(numbers).toEqual(range(1, 70));
      for (const page of pages) expect(columnsOf(page.markers, range(1, 70))).toBe(3);
    });
  });

  it('wraps English at word boundaries and keeps every word', async () => {
    const description = Array.from({ length: 24 }, () => 'documentation').join(' ');

    const read = await readPdf(await generateProjectPdf([entry('step-1', 1, description)], { title: 'T' }));

    const lines = read.pages[0].lines.filter((line) => line.includes('documentation'));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toMatch(/documentation( documentation)*$/);
    expect(lines.join(' ').match(/documentation/g)).toHaveLength(24);
  });

  it('wraps a long CJK paragraph without losing or duplicating characters', async () => {
    const description = '點擊瀏覽器工具列上的擴充功能圖示開啟設定頁面'.repeat(8);

    const read = await readPdf(await generateProjectPdf([entry('step-1', 1, description)], { title: 'T' }));

    const lines = read.pages[0].lines.filter((line) => line.includes('點擊') || line.includes('頁面'));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('').replace(/\s/g, '')).toContain(description);
  });

  it('does not fail on characters the fonts do not cover', async () => {
    const read = await readPdf(await generateProjectPdf([entry('step-1', 1, 'Rocket 🚀 简体字 한국어')], { title: 'T' }));

    expect(read.pages).toHaveLength(1);
    expect(read.pages[0].lines.join('\n')).toContain('Rocket');
  });

  describe('structure and navigation', () => {
    const sections = [{ id: 's1', title: '第一章 開始', startEntryId: 'b' }];
    const project = () => [
      entry('a', 1, '開啟設定'),
      groupEntry('b', 2, 'Snapshot', ['點這裡', 'Then here']),
      entry('c', 3, '完成'),
    ];
    const flat = (nodes: StructureNode[]): StructureNode[] => nodes.flatMap((node) => [node, ...flat(node.children)]);

    it('tags the document: headings, paragraphs, lists and figures in reading order', async () => {
      const read = await readPdf(await generateProjectPdf(project(), { title: '指南', description: '說明', sections }));

      const [first, second, third] = read.structure.map((page) => page[0].children.map((node) => [node.role, node.text]));
      expect(first).toEqual([['H1', '指南'], ['P', '說明'], ['H2', '1. 開啟設定'], ['Figure', '']]);
      expect(second).toEqual([['H2', '第一章 開始'], ['H3', '2. Snapshot'], ['Figure', ''], ['L', '1. 點這裡2. Then here']]);
      expect(third).toEqual([['H3', '3. 完成'], ['Figure', '']]);
    });

    it('structures a list as items with a label and a body', async () => {
      const read = await readPdf(await generateProjectPdf(project(), { title: 'T', sections }));

      const list = flat(read.structure[1]).find((node) => node.role === 'L')!;
      // pdf.js attaches the space after a label to whatever follows it, so compare trimmed.
      expect(list.children.map((item) => [item.role, item.children.map((part) => [part.role, part.text.trim()])])).toEqual([
        ['LI', [['Lbl', '1.'], ['LBody', '點這裡']]],
        ['LI', [['Lbl', '2.'], ['LBody', 'Then here']]],
      ]);
    });

    it('gives every screenshot its step description as alternative text, and a fallback when there is none', async () => {
      const read = await readPdf(await generateProjectPdf([entry('a', 1, '開啟設定'), entry('b', 2, '')], { title: 'T' }));

      const alts = read.structure.flatMap((page) => flat(page)).filter((node) => node.role === 'Figure').map((node) => node.alt);
      expect(alts).toEqual(['開啟設定', t().export.imageAlt]);
    });

    it('keeps the running footer out of the structure: a reader skips it, a viewer still shows it', async () => {
      const read = await readPdf(await generateProjectPdf(project(), { title: 'Footer' }));

      const tagged = read.structure.flatMap((page) => flat(page)).map((node) => node.text).join('');
      expect(tagged).not.toContain('Made with Howbeam');
      expect(tagged).not.toMatch(/第 \d 頁/);
      expect(read.pages.flatMap((page) => page.lines).join('')).toContain('Made with Howbeam');
    });

    it('adds bookmarks: sections at the top, their steps nested, steps before the first section at the top', async () => {
      const read = await readPdf(await generateProjectPdf(project(), { title: 'T', sections }));

      expect(read.outline).toEqual([
        { title: '1. 開啟設定', items: [] },
        { title: '第一章 開始', items: [{ title: '2. Snapshot', items: [] }, { title: '3. 完成', items: [] }] },
      ]);
    });

    it('bookmarks a project without sections as one flat list of steps', async () => {
      const read = await readPdf(await generateProjectPdf([entry('a', 1, 'One'), entry('b', 2, 'Two')], { title: 'T' }));

      expect(read.outline).toEqual([{ title: '1. One', items: [] }, { title: '2. Two', items: [] }]);
    });

    it('declares itself a tagged PDF/UA document that shows its title', async () => {
      const pdf = await generateProjectPdf(project(), { title: 'Accessible' });
      const raw = Buffer.from(await pdf.arrayBuffer()).toString('latin1');

      expect(raw).toMatch(/\/Marked true/);
      expect(raw).toMatch(/\/StructTreeRoot/);
      expect(raw).toMatch(/\/DisplayDocTitle true/);
      expect(raw).toMatch(/\/Lang \(zh-Hant\)/);
      expect(raw).toContain('pdfuaid:part');
    });

    it('keeps one structure for a document whose steps run over several pages', async () => {
      const many = Array.from({ length: 5 }, (_, index) => entry(`s${index}`, index + 1, `Step ${index + 1}`));

      const read = await readPdf(await generateProjectPdf(many, { title: 'Long', sections: [{ id: 's', title: 'All', startEntryId: 's0' }] }));

      expect(read.pages).toHaveLength(5);
      expect(read.outline).toHaveLength(1);
      expect(read.outline[0].items).toHaveLength(5);
      for (const page of read.structure) expect(flat(page).some((node) => node.role === 'Figure')).toBe(true);
    });
  });

  describe('limits', () => {
    it('throws ProjectExportLimitError when the page count exceeds maxPdfPages', async () => {
      LIMITS.maxPdfPages = 2;
      const entries = [entry('a', 1, 'x'), entry('b', 2, 'y'), entry('c', 3, 'z')];

      await expect(generateProjectPdf(entries, { title: 'T' })).rejects.toThrow(ProjectExportLimitError);
      await expect(generateProjectPdf(entries, { title: 'T' })).rejects.toThrow('page limit');
    });

    it('fails with a clear message instead of degrading when the output exceeds maxPdfBytes', async () => {
      LIMITS.maxPdfBytes = 4_000;

      await expect(generateProjectPdf([entry('a', 1, 'x')], { title: 'T' })).rejects.toThrow(ProjectExportLimitError);
      await expect(generateProjectPdf([entry('a', 1, 'x')], { title: 'T' })).rejects.toThrow('output size limit');
    });

    it('exports a document that fits the limit', async () => {
      LIMITS.maxPdfBytes = 200 * 1024;

      const pdf = await generateProjectPdf([entry('a', 1, 'x')], { title: 'T' });

      expect(pdf.size).toBeLessThanOrEqual(200 * 1024);
    });
  });

  describe('failures', () => {
    it('names the step whose image is not a JPEG', async () => {
      mocks.composite
        .mockResolvedValueOnce(screenshot())
        .mockResolvedValueOnce(new Blob(['not an image'], { type: 'image/jpeg' }));

      const error = await generateProjectPdf([entry('a', 1, 'x'), entry('b', 2, 'y')], { title: 'T' }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(StepImageError);
      expect((error as StepImageError).ordinal).toBe(2);
    });

    it('stops when cancelled before it starts', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(generateProjectPdf([entry('a', 1, 'x')], { title: 'T' }, { signal: controller.signal })).rejects.toThrow(/abort/i);
      expect(mocks.composite).not.toHaveBeenCalled();
    });

    it('stops when cancelled between steps', async () => {
      const controller = new AbortController();
      mocks.composite.mockImplementation(async () => {
        controller.abort();
        return screenshot();
      });

      await expect(
        generateProjectPdf([entry('a', 1, 'x'), entry('b', 2, 'y')], { title: 'T' }, { signal: controller.signal }),
      ).rejects.toThrow(/abort/i);
    });

    it('reports a font that could not be loaded instead of producing a broken document', async () => {
      mocks.loadFonts.mockRejectedValue(new Error('Could not load the PDF font.'));

      await expect(generateProjectPdf([entry('a', 1, 'x')], { title: 'T' })).rejects.toThrow('Could not load the PDF font.');
    });
  });
});

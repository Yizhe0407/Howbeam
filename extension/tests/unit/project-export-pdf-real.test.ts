import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { type StepEntry } from '@/lib/storage/models';

const mocks = vi.hoisted(() => ({
  composite: vi.fn(),
}));

// The per-entry raster pipeline needs a real browser canvas and is covered by
// entry-render tests; everything downstream of it — pagination, wrapping via
// Intl.Segmenter, and REAL pdf-lib assembly — runs unmocked here.
vi.mock('@/lib/export/entry-render', () => ({
  compositeStepEntry: mocks.composite,
}));

import { PROJECT_EXPORT_LIMITS } from '@/lib/export/project-export-contract';
import { generateProjectPdf } from '@/lib/export/project-export-pdf';
import { stubPdfCanvas } from '../setup/pdf-canvas';

/**
 * A minimal but fully valid baseline JPEG (1x1 white pixel). pdf-lib parses
 * the JFIF/SOF markers of embedded JPEGs for real, so the bytes must decode —
 * a text placeholder blob would make embedJpg throw.
 */
const TINY_JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  ),
  (char) => char.charCodeAt(0),
);

function entry(id: string, order: number, description: string): StepEntry {
  return {
    kind: 'single',
    step: {
      id,
      sessionId: 'session-1',
      order,
      screenshotBlob: new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
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
      screenshotBlob: new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
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

let canvasContext: ReturnType<typeof stubPdfCanvas>;

beforeEach(() => {
  // Rasterizes pages to the tiny real JPEG above so pdf-lib embeds genuine bytes.
  canvasContext = stubPdfCanvas({
    pageBlob: new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }),
    bitmap: { width: 1_200, height: 700 },
  });
  mocks.composite.mockReset().mockResolvedValue(new Blob([TINY_JPEG.slice()], { type: 'image/jpeg' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateProjectPdf with the real pdf-lib', () => {
  it('produces a loadable A4 PDF with one page per entry across CJK, English, and emoji text', async () => {
    const entries = [
      entry('step-1', 1, '點擊瀏覽器工具列上的擴充功能圖示，開啟設定頁面。'),
      entry('step-2', 2, 'Open the extension settings and enable automatic capture for every tab.'),
      entry('step-3', 3, '完成後按下儲存 ✅ and share the project 👩‍👩‍👧‍👦 with your team 🚀'),
    ];

    const pdf = await generateProjectPdf(entries, {
      title: '安裝指南 Setup Project 🚀',
      description: '本指南示範 how mixed-script descriptions survive real PDF assembly.',
    });
    expect(pdf.type).toBe('application/pdf');

    const bytes = new Uint8Array(await pdf.arrayBuffer());
    // %PDF- header proves this is genuine pdf-lib output, not a mock artifact.
    expect(Array.from(bytes.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    expect(bytes.byteLength).toBeLessThanOrEqual(PROJECT_EXPORT_LIMITS.maxPdfBytes);

    // pdf-lib must be able to parse its own save() output.
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(entries.length);
    expect(loaded.getTitle()).toBe('安裝指南 Setup Project 🚀');
    for (let index = 0; index < loaded.getPageCount(); index++) {
      const { width, height } = loaded.getPage(index).getSize();
      expect(width).toBeCloseTo(595.28, 2);
      expect(height).toBeCloseTo(841.89, 2);
    }
    expect(mocks.composite).toHaveBeenCalledTimes(entries.length);

    // Layout invariants: every page carries a running footer with the project
    // title and a zh-Hant page number, each step prints its number, each
    // screenshot is framed with a border, and the document ends with the credit.
    const drawnText = canvasContext.fillText.mock.calls.map(([text]) => String(text));
    expect(drawnText).toContain('第 1 頁');
    expect(drawnText).toContain('第 2 頁');
    expect(drawnText).toContain('第 3 頁');
    expect(drawnText).not.toContain('第 4 頁');
    expect(drawnText.filter((text) => text.includes('安裝指南 Setup Project 🚀')).length)
      .toBeGreaterThanOrEqual(entries.length);
    expect(canvasContext.arc).not.toHaveBeenCalled();
    expect(canvasContext.strokeRect).toHaveBeenCalledTimes(entries.length);
    expect(drawnText).toContain('Made with Howbeam');

    // Hybrid embedding: each page has its rasterized background JPEG plus the
    // screenshot embedded as its own full-resolution JPEG (two DCT streams per
    // page); counting SOI markers (FF D8 FF) is a stable structural check.
    let jpegStreams = 0;
    for (let index = 0; index + 2 < bytes.length; index++) {
      if (bytes[index] === 0xff && bytes[index + 1] === 0xd8 && bytes[index + 2] === 0xff) jpegStreams += 1;
    }
    expect(jpegStreams).toBe(entries.length * 2);

    // Each number sits at the margin and its title starts at the hanging
    // indent on the same line (margin 84 + indent 66).
    const calls = canvasContext.fillText.mock.calls;
    for (const ordinal of [1, 2, 3]) {
      const number = calls.find(([text, x]) => text === `${ordinal}.` && x === 84);
      expect(number).toBeDefined();
      expect(calls.some(([, x, y]) => x === 150 && y === number![2])).toBe(true);
    }
  });

  it('emits a single-page PDF for a lone entry and keeps the title page merged with it', async () => {
    const pdf = await generateProjectPdf([entry('step-1', 1, 'Only step')], { title: 'One pager' });

    const loaded = await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()));
    expect(loaded.getPageCount()).toBe(1);
  });

  it('renders section headings before their entries and numbers group annotations', async () => {
    const entries = [
      entry('step-1', 1, '開啟設定頁面'),
      groupEntry('anchor-1', 2, '標記快照重點', ['點擊登入按鈕', '輸入電子郵件']),
    ];

    const pdf = await generateProjectPdf(entries, {
      title: '章節指南',
      sections: [
        { id: 'section-1', title: '第一章 前置作業', startEntryId: 'step-1' },
        { id: 'section-2', title: '第二章 快照標記', startEntryId: 'anchor-1' },
      ],
    });

    const loaded = await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()));
    expect(loaded.getPageCount()).toBe(entries.length);

    const drawnText = canvasContext.fillText.mock.calls.map(([text]) => String(text));
    // Section headings are emitted on the page of the entry they anchor to.
    expect(drawnText).toContain('第一章 前置作業');
    expect(drawnText).toContain('第二章 快照標記');
    // The group's annotations are listed as a numbered run under the
    // screenshot: '1. ' / '2. ' prefixes drawn separately from their text.
    expect(drawnText).toContain('1. ');
    expect(drawnText).toContain('2. ');
    expect(drawnText).toContain('點擊登入按鈕');
    expect(drawnText).toContain('輸入電子郵件');
    // Both entries print their own step number.
    expect(drawnText).toContain('1.');
    expect(drawnText).toContain('2.');
  });
});

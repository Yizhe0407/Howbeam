import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type StepEntry } from '@/lib/storage/models';

const mocks = vi.hoisted(() => ({
  composite: vi.fn(),
}));

vi.mock('@/lib/export/entry-render', () => ({
  compositeStepEntry: mocks.composite,
}));

vi.mock('@/lib/export/pdf/pdf-fonts', async (original) => (await import('../setup/pdf-fonts')).withDiskFonts(await original()));


import { PROJECT_EXPORT_LIMITS, ProjectExportLimitError, projectExportFilename, type ProjectExportMetadata } from '@/lib/export/project-export-contract';
import { generateProjectHtml as generateProjectHtmlBlob } from '@/lib/export/project-export-html';
import { generateProjectMarkdownArchive } from '@/lib/export/project-export-markdown';
import { generateProjectPdf } from '@/lib/export/project-export-pdf';
import { RedactionReviewRequiredError, StepImageError } from '@/lib/export/export-errors';
import { renderEntryImages } from '@/lib/export/project-export-render';
import { jpegOfSize } from '../setup/jpeg-fixture';
import { readPdf } from '../setup/pdf-extract';
import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';

/** The document as text; the generator itself returns a Blob. */
async function generateProjectHtml(...args: Parameters<typeof generateProjectHtmlBlob>): Promise<string> {
  return (await generateProjectHtmlBlob(...args)).text();
}

function entry(overrides: Record<string, unknown> = {}): StepEntry {
  return {
    kind: 'single',
    step: {
      id: 'step-1',
      sessionId: 'session-1',
      order: 1,
      screenshotBlob: new Blob(['source'], { type: 'image/jpeg' }),
      bounds: null,
      devicePixelRatio: 1,
      description: 'Open settings',
      url: 'https://example.com/settings',
      timestamp: 1,
      ...overrides,
    },
  } as StepEntry;
}

function groupEntry(): StepEntry {
  return {
    kind: 'group',
    anchor: {
      id: 'anchor',
      sessionId: 'session-1',
      order: 1,
      screenshotBlob: new Blob(['source'], { type: 'image/jpeg' }),
      bounds: null,
      devicePixelRatio: 1,
      description: 'Shared page',
      url: 'https://example.com/shared',
      timestamp: 1,
      groupId: 'anchor',
    },
    annotations: [
      {
        id: 'later',
        sessionId: 'session-1',
        order: 3,
        bounds: { x: 1, y: 1, width: 2, height: 2 },
        devicePixelRatio: 1,
        description: 'Second annotation',
        url: 'https://example.com/shared',
        timestamp: 3,
        groupId: 'anchor',
      },
      {
        id: 'first',
        sessionId: 'session-1',
        order: 2,
        bounds: { x: 1, y: 1, width: 2, height: 2 },
        devicePixelRatio: 1,
        description: 'First annotation',
        url: 'https://example.com/shared',
        timestamp: 2,
        groupId: 'anchor',
      },
    ],
  } as StepEntry;
}

/**
 * A Mark entry as recording really stores it: the base image has no
 * description of its own (the editor offers no field for one), only its
 * annotations carry text.
 */
function markEntry(id: string, order: number, notes: string[]): StepEntry {
  return {
    kind: 'group',
    anchor: {
      id,
      sessionId: 'session-1',
      order,
      screenshotBlob: new Blob(['source'], { type: 'image/jpeg' }),
      bounds: null,
      devicePixelRatio: 1,
      description: '',
      url: 'https://example.com/mark',
      timestamp: order,
      groupId: id,
      numbered: true,
    },
    annotations: notes.map((description, index) => ({
      id: `${id}-note-${index + 1}`,
      sessionId: 'session-1',
      order: order + index + 1,
      bounds: { x: 1, y: 1, width: 2, height: 2 },
      devicePixelRatio: 1,
      description,
      url: 'https://example.com/mark',
      timestamp: order + index + 1,
      groupId: id,
      numbered: true,
    })),
  } as StepEntry;
}

/** Steps and Mark entries interleaved, the way most real projects are recorded. */
function mixedProject(): StepEntry[] {
  return [
    entry({ id: 'step-1', order: 1, description: 'Open settings' }),
    markEntry('mark-1', 10, ['Search box', 'Language menu', 'History tab']),
    entry({ id: 'step-2', order: 20, description: 'Click history' }),
    markEntry('mark-2', 30, ['A long note that keeps going so the list has to wrap across lines', 'Edit']),
  ];
}

const MIXED_SECTIONS = [
  { id: 'find', title: 'Find the page', startEntryId: 'step-1' },
  { id: 'tour', title: 'Tour the page', startEntryId: 'mark-1' },
];

/** Renders the project's Markdown archive and returns its Markdown document. */
async function archiveMarkdown(entries: StepEntry[], metadata: ProjectExportMetadata = {}): Promise<string> {
  const archive = await generateProjectMarkdownArchive(entries, metadata);
  const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
  return strFromU8(files[archive.markdownFilename]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mocks.composite.mockReset().mockResolvedValue(new Blob(['annotated'], { type: 'image/jpeg' }));
});

describe('project export', () => {
  it('keeps the persisted-limit-derived export budgets at their established values', () => {
    expect(PROJECT_EXPORT_LIMITS).toEqual({
      maxEntries: 2_000,
      maxImageBytes: 16 * 1024 * 1024,
      // Same ×2 re-encode headroom as the image-ZIP export: both feed the
      // renderEntryImages pipeline, so a project that ZIP-exports must not fail
      // its HTML/PDF export on the identical payload.
      maxTotalImageBytes: 128 * 1024 * 1024,
      maxPdfPages: 4_000,
      // The screenshots a PDF embeds as they are, plus 16 MB for fonts and page structure.
      maxPdfBytes: 144 * 1024 * 1024,
    });
    expect(PERSISTED_STEP_LIMITS.maxStepsPerProject).toBe(2_000);
    expect(PERSISTED_STEP_LIMITS.maxScreenshotBytes).toBe(16 * 1024 * 1024);
    expect(PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes).toBe(64 * 1024 * 1024);
  });

  it('uses deterministic, traversal-safe filenames', () => {
    expect(projectExportFilename({ title: '  My / Project  ' }, 'markdown')).toBe('my-project.md');
    expect(projectExportFilename({ title: '  My / Project  ' }, 'markdown-archive')).toBe('my-project.zip');
    expect(projectExportFilename({ filename: '../../Report 2026' }, 'html')).toBe('report-2026.html');
    expect(projectExportFilename({ filename: '../../Report 2026' }, 'pdf')).toBe('report-2026.pdf');
  });

  it('keeps CJK titles as readable filename stems', () => {
    expect(projectExportFilename({ title: '登入與初始設定' }, 'pdf')).toBe('登入與初始設定.pdf');
    expect(projectExportFilename({ title: 'Chrome 擴充功能：匯出教學' }, 'html')).toBe('chrome-擴充功能-匯出教學.html');
    expect(projectExportFilename({ title: '設定/教學\\範例' }, 'markdown')).toBe('設定-教學-範例.md');
  });

  it('strips filesystem-unsafe characters and falls back for symbol-only titles', () => {
    expect(projectExportFilename({ title: 'a\\b:c*d?e"f<g>h|i' }, 'markdown')).toBe('a-b-c-d-e-f-g-h-i.md');
    expect(projectExportFilename({ title: '  ！？＊  ' }, 'markdown')).toBe('howbeam-project.md');
    expect(projectExportFilename({}, 'pdf')).toBe('howbeam-project.pdf');
  });

  it('never produces a Windows reserved device name', () => {
    for (const title of ['CON', 'nul', 'Aux', 'PRN', 'com1', 'COM9', 'LPT5', 'ＣＯＮ']) {
      const name = projectExportFilename({ title }, 'html');
      expect(name).toMatch(/^[a-z0-9]+-howbeam-project\.html$/);
    }
    expect(projectExportFilename({ title: 'console' }, 'html')).toBe('console.html');
    expect(projectExportFilename({ title: 'CON.' }, 'pdf')).toBe('con-howbeam-project.pdf');
  });

  it('keeps voiced kana, Hangul and Indic marks composed in filenames', () => {
    expect(projectExportFilename({ title: 'ガイドブック' }, 'html')).toBe('ガイドブック.html');
    expect(projectExportFilename({ title: 'ﾊﾟｿｺﾝ入門' }, 'html')).toBe('パソコン入門.html');
    expect(projectExportFilename({ title: '한국어 가이드' }, 'html')).toBe('한국어-가이드.html');
    expect(projectExportFilename({ title: 'हिन्दी' }, 'html')).toBe('हिन्दी.html');
    // Latin accents are still folded away on purpose.
    expect(projectExportFilename({ title: 'Café Déjà Vu' }, 'html')).toBe('cafe-deja-vu.html');
  });

  it('bounds the filename stem by UTF-8 bytes without splitting a code point', () => {
    const encoder = new TextEncoder();
    for (const title of ['漢'.repeat(300), 'a'.repeat(300), '😀'.repeat(300), 'é'.repeat(10) + '가'.repeat(300)]) {
      const stem = projectExportFilename({ title }, 'html').replace(/\.html$/, '');
      expect(encoder.encode(stem).length).toBeLessThanOrEqual(200);
      expect(stem.length).toBeGreaterThan(0);
      expect(stem.isWellFormed()).toBe(true);
    }
    expect([...projectExportFilename({ title: '漢'.repeat(300) }, 'html')].length).toBe(66 + '.html'.length);
  });

  it('packs one Markdown file and every composited image into a portable ZIP', async () => {
    mocks.composite
      .mockResolvedValueOnce(new Blob(['first-image'], { type: 'image/jpeg' }))
      .mockResolvedValueOnce(new Blob(['second-image'], { type: 'image/jpeg' }));

    const archive = await generateProjectMarkdownArchive(
      [entry(), groupEntry()],
      { title: 'Bundle project', filename: '../../Bundle Project' },
    );
    const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
    const markdown = strFromU8(files['bundle-project.md']);

    expect(archive.blob.type).toBe('application/zip');
    expect(archive.markdownFilename).toBe('bundle-project.md');
    expect(archive.imageCount).toBe(2);
    expect(Object.keys(files).sort()).toEqual([
      'bundle-project.md',
      'images/01.jpg',
      'images/02.jpg',
    ]);
    expect(strFromU8(files['images/01.jpg'])).toBe('first-image');
    expect(strFromU8(files['images/02.jpg'])).toBe('second-image');
    expect(markdown).toContain('![Open settings](images/01.jpg)');
    expect(markdown).toContain('![Shared page](images/02.jpg)');
    expect(markdown.indexOf('Open settings')).toBeLessThan(markdown.indexOf('![Open settings](images/01.jpg)'));
    expect(markdown.indexOf('Shared page')).toBeLessThan(markdown.indexOf('![Shared page](images/02.jpg)'));
    expect(markdown).not.toContain('Step 1');
    expect(markdown).not.toContain('Step 2');
    expect(markdown).not.toContain('Source:');
    expect(markdown).not.toContain('Annotations:');
    expect(markdown).not.toContain('data:image/');
  });

  it('builds safe Markdown through the shared composite renderer', async () => {
    const markdown = await archiveMarkdown(
      [entry({ description: '<script>alert(1)</script> [link](javascript:alert(1))' })],
      {
        title: '# unsafe',
        description: 'A <b>description</b>',
      },
    );

    expect(mocks.composite).toHaveBeenCalledWith(expect.objectContaining({ kind: 'single' }), 'image/jpeg');
    expect(markdown).toContain('# \\# unsafe');
    expect(markdown).toContain('A \\<b\\>description\\</b\\>');
    expect(markdown).toContain('\\<script\\>alert\\(1\\)\\</script\\>');
    expect(markdown).not.toContain('Source:');
    expect(markdown).not.toContain('https://example.com/settings');

    const credentialHtml = await generateProjectHtml([entry({ url: 'https://user:secret@example.com/private' })]);
    expect(credentialHtml).not.toContain('secret');
  });

  it('escapes user HTML and unsafe URLs in self-contained HTML', async () => {
    const html = await generateProjectHtml(
      [entry({ description: '<img src=x onerror=alert(1)>' })],
      {
        title: '<svg onload=alert(1)>',
        description: '"quoted" & <b>unsafe</b>',
      },
    );

    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;b&gt;unsafe&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('src="data:image/jpeg;base64,YW5ub3RhdGVk"');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'; img-src data:");
    expect(html.match(/<header class="document-header">/g)).toHaveLength(1);
    expect(html.match(/<\/header>/g)).toHaveLength(1);
    expect(html).not.toContain('<svg onload=alert(1)>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('escapes ordered-list markers and setext underlines in Markdown text', async () => {
    const markdown = await archiveMarkdown(
      [entry({ description: '1. 點擊按鈕\n10. 完成設定' })],
      { title: '版本說明', description: '總覽\n====' },
    );

    expect(markdown).toContain('1\\. 點擊按鈕');
    expect(markdown).toContain('10\\. 完成設定');
    expect(markdown).toContain('\\=\\=\\=\\=');
    expect(markdown).not.toContain('\n1. 點擊按鈕');
    expect(markdown).not.toContain('\n====');
  });

  it('keeps URLs and addresses in Markdown descriptions from becoming GFM autolinks with stray backslashes', async () => {
    const markdown = await archiveMarkdown([
      entry({ description: 'See https://cdn.example.com/a_b/track.png) and www.example.com/x_y or me@example.com' }),
    ]);

    // Each autolink trigger is neutralised, so no renderer can create a link
    // whose target swallows an escaping backslash (`track.png%5C`).
    expect(markdown).toContain('https\\://cdn.example.com/a\\_b/track.png\\)');
    expect(markdown).toContain('www\\.example.com/x\\_y');
    expect(markdown).toContain('me\\@example.com');
    expect(markdown).not.toMatch(/(?<!\\)https?:\/\//);
    expect(markdown).not.toMatch(/(?<!\\)www\./);
  });

  it('lets long unbreakable strings wrap in the HTML export', async () => {
    const html = await generateProjectHtml([entry({ description: 'x'.repeat(5_000) })], { title: 'y'.repeat(5_000) });

    expect(html).toMatch(/h1, h2, h3, p, li \{ margin: 0; overflow-wrap: anywhere; \}/);
    expect(html).toMatch(/\.step-title \{ display: grid; grid-template-columns: 2\.2em minmax\(0, 1fr\);/);
  });

  it('builds the HTML as Blob parts so no document-sized string is ever assembled', async () => {
    mocks.composite.mockImplementation(async () => new Blob([new Uint8Array(4_000_000).fill(7)], { type: 'image/jpeg' }));
    const blob = await generateProjectHtmlBlob([entry(), entry({ id: 'step-2', order: 2 })], { title: 'Big' });

    expect(blob.type).toBe('text/html;charset=utf-8');
    // Two 4 MB images -> ~10.7 MB of base64 in the output, still valid and complete.
    expect(blob.size).toBeGreaterThan(10_600_000);
    const text = await blob.text();
    expect(text.startsWith('<!doctype html>')).toBe(true);
    expect(text.endsWith('</html>\n')).toBe(true);
    expect(text.match(/<img src="data:image\/jpeg;base64,[A-Za-z0-9+/=]+" alt=/g)).toHaveLength(2);
  });

  it('renders repaired section headings in timeline order and escapes Markdown text', async () => {
    const markdown = await archiveMarkdown(
      [entry({ id: 'first', order: 1 }), groupEntry()],
      {
        title: 'Sectioned project',
        sections: [
          { id: 'later', title: 'Later <chapter>', startEntryId: 'anchor' },
          { id: 'first-section', title: '# First [chapter]', startEntryId: 'first' },
          { id: 'annotation-middle', title: 'Must not render', startEntryId: 'later' },
          { id: 'duplicate-start', title: 'Must also not render', startEntryId: 'first' },
        ],
      },
    );

    const firstHeading = markdown.indexOf('## \\# First \\[chapter\\]');
    const firstImage = markdown.indexOf('![Open settings]');
    const laterHeading = markdown.indexOf('## Later \\<chapter\\>');
    const secondImage = markdown.indexOf('![Shared page]');
    expect(firstHeading).toBeGreaterThan(-1);
    expect(firstHeading).toBeLessThan(firstImage);
    expect(firstImage).toBeLessThan(laterHeading);
    expect(laterHeading).toBeLessThan(secondImage);
    expect(markdown).not.toContain('Must not render');
    expect(markdown).not.toContain('Must also not render');
  });

  it('renders escaped section headings before matching entries in HTML', async () => {
    const metadata = {
      sections: [
        { id: 'section', title: '<img src=x onerror=alert(1)>', startEntryId: 'step-1' },
        { id: 'broken', title: '<script>broken</script>', startEntryId: 'missing' },
      ],
    };
    const html = await generateProjectHtml([entry()], metadata);
    const heading = html.indexOf('&lt;img src=x onerror=alert(1)&gt;');
    const image = html.indexOf('<figure>');

    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(image);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('broken');
  });

  it('keeps the image above ordered group annotations in HTML', async () => {
    const html = await generateProjectHtml([groupEntry()], { title: 'Project' });

    const image = html.indexOf('<figure>');
    const annotations = html.indexOf('<ol class="annotations">');
    expect(image).toBeGreaterThan(-1);
    expect(image).toBeLessThan(annotations);
    expect(html.indexOf('First annotation')).toBeLessThan(html.indexOf('Second annotation'));
    expect(html).not.toContain('Source');
    expect(html).not.toContain('<figcaption>');
    expect(html).not.toContain('Annotated screenshot for step');
    expect(html).not.toContain('Annotations');
    expect(html).not.toContain('<div class="step-index"');
    expect(html).not.toContain('<div class="step-header"');
    expect(html).not.toContain('Step 1');
  });

  it('prints the step number and description as one heading above each HTML screenshot', async () => {
    const html = await generateProjectHtml([entry(), groupEntry()], { title: 'Project' });

    const firstHeading = html.indexOf('<h3 class="step-title"><span class="step-number">1.</span><span>Open settings</span></h3>');
    const firstImage = html.indexOf('<figure>');
    expect(firstHeading).toBeGreaterThan(-1);
    expect(firstHeading).toBeLessThan(firstImage);
    expect(html).toContain('<h3 class="step-title"><span class="step-number">2.</span><span>Shared page</span></h3>');
  });

  it('rounds the corners of every HTML screenshot', async () => {
    const html = await generateProjectHtml([entry()], { title: 'Project' });

    expect(html).toMatch(/img \{[^}]*border-radius: 10px;/);
  });

  it('ends the HTML with a centred English credit whatever the interface language', async () => {
    const html = await generateProjectHtml([entry()], { title: 'Project' });

    expect(html).toContain('<footer class="document-end">Made with Howbeam</footer>\n</main>');
    expect(html).toMatch(/\.document-end \{[^}]*text-align: center;/);
    expect(html).not.toContain('以 Howbeam 製作');
  });

  it('leaves the step count out of the title block', async () => {
    const html = await generateProjectHtml([entry()], { title: 'Project' });

    expect(html).not.toContain('document-meta');
    expect(html).not.toContain('共 1 個步驟');
  });

  it('wraps a compositing failure with the failing step ordinal and stays fail-closed', async () => {
    const decodeError = new Error('InvalidStateError');
    mocks.composite.mockResolvedValueOnce(new Blob(['ok'])).mockRejectedValueOnce(decodeError);

    const failure = await generateProjectMarkdownArchive([entry(), entry({ id: 'step-2', order: 2 })]).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StepImageError);
    expect(failure).toMatchObject({ ordinal: 2, cause: decodeError });
    await expect(generateProjectHtml([entry()])).resolves.toContain('<!doctype html>');
  });

  it.each([
    ['markdown', (entries: StepEntry[]) => generateProjectMarkdownArchive(entries)],
    ['html', (entries: StepEntry[]) => generateProjectHtml(entries)],
    ['pdf', (entries: StepEntry[]) => generateProjectPdf(entries)],
  ])('refuses %s export naming every step whose masks still need review', async (_format, generate) => {
    const entries = [
      entry({ redactionReviewRequired: true }),
      entry({ id: 'step-2', order: 2 }),
      entry({ id: 'step-3', order: 3, redactions: 'corrupt' }),
    ];

    const failure = await generate(entries).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RedactionReviewRequiredError);
    expect((failure as RedactionReviewRequiredError).ordinals).toEqual([1, 3]);
    expect(mocks.composite).not.toHaveBeenCalled();
  });

  it('stops after a cancellation between sequential composites', async () => {
    const controller = new AbortController();
    mocks.composite.mockImplementationOnce(async () => {
      controller.abort();
      return new Blob(['annotated'], { type: 'image/jpeg' });
    });

    await expect(
      generateProjectHtml([entry(), entry({ id: 'step-2', order: 2 })], {}, { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mocks.composite).toHaveBeenCalledTimes(1);
  });

  it('rejects an excessive entry count before compositing any image', async () => {
    const entries = Array.from(
      { length: PROJECT_EXPORT_LIMITS.maxEntries + 1 },
      (_, index) => entry({ id: `step-${index}`, order: index }),
    );

    await expect(generateProjectHtml(entries)).rejects.toBeInstanceOf(ProjectExportLimitError);
    expect(mocks.composite).not.toHaveBeenCalled();
  });

  it('rejects an oversized composited image before allocating its ArrayBuffer', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    mocks.composite.mockResolvedValueOnce({
      size: PROJECT_EXPORT_LIMITS.maxImageBytes + 1,
      arrayBuffer,
    } as unknown as Blob);

    await expect(generateProjectMarkdownArchive([entry()])).rejects.toBeInstanceOf(ProjectExportLimitError);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('enforces the cumulative image budget before converting the overflowing image', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    mocks.composite.mockResolvedValue({
      size: PROJECT_EXPORT_LIMITS.maxImageBytes,
      arrayBuffer,
    } as unknown as Blob);
    // Eight max-size images fill the ×2 headroom budget exactly; the ninth
    // must be rejected before its bytes are converted.
    const entries = Array.from({ length: 9 }, (_, index) => entry({ id: `step-${index}`, order: index }));

    await expect(generateProjectHtml(entries)).rejects.toBeInstanceOf(ProjectExportLimitError);
    expect(mocks.composite).toHaveBeenCalledTimes(9);
    expect(arrayBuffer).toHaveBeenCalledTimes(8);
  });

  it('starts the lookahead composite before the consumer drains the current image', async () => {
    const iterator = renderEntryImages([entry(), entry({ id: 'step-2', order: 2 })]);
    const first = await iterator.next();

    // Pipelining contract: while the consumer still holds image 1, image 2 is
    // already compositing — but never more than one ahead (bounded memory).
    expect(first.done).toBe(false);
    expect(mocks.composite).toHaveBeenCalledTimes(2);

    const second = await iterator.next();
    expect(second.done).toBe(false);
    const end = await iterator.next();
    expect(end.done).toBe(true);
    expect(mocks.composite).toHaveBeenCalledTimes(2);
  });

  it('observes a failing lookahead composite when the generator is abandoned early', async () => {
    mocks.composite
      .mockResolvedValueOnce(new Blob(['first'], { type: 'image/jpeg' }))
      .mockRejectedValueOnce(new Error('late compositing failure'));

    const iterator = renderEntryImages([entry(), entry({ id: 'step-2', order: 2 })]);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await iterator.return(undefined);

    // An unobserved lookahead rejection would surface as an unhandled
    // rejection once the microtask/macrotask queues drain and fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  describe('HTML marker columns', () => {
    const listTag = async (notes: string[]) => (await generateProjectHtml([markEntry('mark', 1, notes)], { title: 'P' })).match(/<ol class="annotations"[^>]*>/)![0];

    it('picks the columns by the PDF rule at the document width, each column only as wide as its markers need', async () => {
      // Three columns would wrap every English description to two lines; two keep each on one.
      expect(await listTag(Array.from({ length: 16 }, () => 'Mark an area of the page'))).toBe('<ol class="annotations" data-columns style="columns: 14.8em 2">');
      expect(await listTag(Array.from({ length: 16 }, () => '標記頁面區域'))).toBe('<ol class="annotations" data-columns style="columns: 7.5em 3">');
    });

    it('lets a longer description wrap to two lines in its column', async () => {
      const short = Array.from({ length: 7 }, () => 'Save');
      expect(await listTag([...short, 'Open the account settings page to change the password'])).toContain('columns: 16.3em 2');
    });

    it('runs a description too long for a column across the full width', async () => {
      const long = 'Open the account settings page, choose Security, then change the password and confirm it with the code sent to your phone.';
      const html = await generateProjectHtml([markEntry('mark', 1, [...Array.from({ length: 7 }, () => 'Save'), long])], { title: 'P' });

      expect(html).toMatch(/<ol class="annotations" data-columns style="columns: [\d.]+em \d">/);
      expect(html).toContain(`<li data-span>${long}</li>`);
      expect(html.match(/<li data-span>/g)).toHaveLength(1);
    });

    const LONG = 'Open the account settings page, choose Security, then change the password and confirm it with the code sent to your phone.';
    const spanned = async (notes: string[]) => {
      const html = await generateProjectHtml([markEntry('mark', 1, notes)], { title: 'P' });
      return [...html.matchAll(/<li( data-span)?>/g)].map((match) => Boolean(match[1]));
    };

    it('runs markers between long ones across the full width when they are too few for two rows of columns', async () => {
      const url = 'https://example.com/a/very/long/url/without/any/spaces/that/cannot/wrap/anywhere/at/all/really';
      expect(await spanned(['Save', 'Menu', 'OK', url, 'Help', 'Tab', 'Back', 'Next'])).toEqual([true, true, true, true, false, false, false, false]);
    });

    it('keeps one column when long and short descriptions alternate', async () => {
      expect(await listTag(['Save', LONG, 'Menu', LONG, 'OK', LONG, 'Help'])).toBe('<ol class="annotations">');
      expect((await spanned(['Save', LONG, 'Menu', LONG, 'OK', LONG, 'Help'])).some(Boolean)).toBe(false);
    });

    it('gives every column at least two markers', async () => {
      expect(await listTag(['One', 'Two', 'Three', 'Four', 'Five'])).toContain(' 2">');
      expect(await listTag(['One', 'Two', 'Three'])).toBe('<ol class="annotations">');
    });
  });

  describe('projects that mix Steps and Mark entries', () => {
    it('gives a Mark entry its number and annotations in HTML, never the missing-description placeholder', async () => {
      const html = await generateProjectHtml(mixedProject(), { title: 'Mixed', sections: MIXED_SECTIONS });

      expect(html).not.toContain('（未填寫說明）');
      expect(html).toContain('<h3 class="step-title"><span class="step-number">1.</span><span>Open settings</span></h3>');
      expect(html).toContain('<h3 class="step-title"><span class="step-number">2.</span></h3>');
      expect(html).toContain('<h3 class="step-title"><span class="step-number">3.</span><span>Click history</span></h3>');
      expect(html).toContain('<h3 class="step-title"><span class="step-number">4.</span></h3>');
      expect(html.match(/<ol class="annotations">/g)).toHaveLength(2);
      // A section may begin at a Mark entry; its heading precedes that entry.
      expect(html.indexOf('Tour the page')).toBeLessThan(html.indexOf('<span class="step-number">2.</span>'));
      expect(html.indexOf('<span class="step-number">2.</span>')).toBeLessThan(html.indexOf('Search box'));
      expect(html.indexOf('Search box')).toBeLessThan(html.indexOf('Language menu'));
    });

    it('prints a Mark entry as a number then its annotation list in the PDF', async () => {
      mocks.composite.mockImplementation(async () => new Blob([jpegOfSize(1_200, 700)], { type: 'image/jpeg' }));

      const read = await readPdf(await generateProjectPdf(mixedProject(), { title: 'Mixed', sections: MIXED_SECTIONS }));
      const text = read.pages.flatMap((page) => page.lines).join('\n');

      expect(text).not.toContain('（未填寫說明）');
      for (const number of ['1.', '2.', '3.', '4.']) expect(text).toContain(number);
      expect(text).toContain('Tour the page');
      expect(text.indexOf('Search box')).toBeLessThan(text.indexOf('History tab'));
      expect(text.indexOf('History tab')).toBeLessThan(text.indexOf('Click history'));
    });

    it('leaves the Mark entry without a placeholder line in Markdown', async () => {
      const markdown = await archiveMarkdown(mixedProject(), { title: 'Mixed', sections: MIXED_SECTIONS });

      expect(markdown).not.toContain('（未填寫說明）');
      expect(markdown).toContain('Open settings');
      expect(markdown).toContain('1. Search box');
    });

    it('still flags a step that has no description at all', async () => {
      const blank = [entry({ id: 'blank', description: '' })];
      const html = await generateProjectHtml(blank, { title: 'Blank' });
      const markdown = await archiveMarkdown(blank, { title: 'Blank' });
      mocks.composite.mockImplementation(async () => new Blob([jpegOfSize(1_200, 700)], { type: 'image/jpeg' }));
      const pdfText = (await readPdf(await generateProjectPdf(blank, { title: 'Blank' }))).pages.flatMap((page) => page.lines).join('\n');

      expect(html).toContain('<span>（未填寫說明）</span>');
      expect(markdown).toContain('（未填寫說明）');
      expect(pdfText).toContain('（未填寫說明）');
    });
  });
});

import 'fake-indexeddb/auto';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ composite: vi.fn() }));
vi.mock('@/lib/export/entry-render', () => ({ compositeStepEntry: mocks.composite }));
vi.mock('@/lib/export/pdf/pdf-fonts', async (original) => (await import('../setup/pdf-fonts')).withDiskFonts(await original()));

import { closeDatabase } from '@/lib/storage/database';
import { createProject, updateProject } from '@/lib/storage/project-repository';
import { generateSeriesExport, generateSeriesZip } from '@/lib/export/series-export';
import { SeriesProjectExportError, SeriesTooLargeError, StepImageError } from '@/lib/export/export-errors';
import { exportFailureMessage } from '@/lib/export/export-failure';
import type { Step } from '@/lib/storage/models';
import { seedSteps } from '../setup/step-fixtures';
import { jpegBlob } from '../setup/raster-fixtures';
import { readPdf } from '../setup/pdf-extract';

function step(sessionId: string, title: string): Step {
  return {
    id: crypto.randomUUID(),
    sessionId,
    order: 0,
    screenshotBlob: jpegBlob(),
    bounds: null,
    devicePixelRatio: 1,
    title,
    description: '',
    url: 'https://example.com',
    timestamp: 1,
  };
}

async function projectWithStep(title: string, description = ''): Promise<string> {
  const id = crypto.randomUUID();
  await seedSteps([step(id, `${title} step`)]);
  await updateProject(id, { title, description });
  return id;
}

async function filesOf(blob: Blob | null | undefined): Promise<Record<string, Uint8Array>> {
  if (!blob) throw new Error('expected a ZIP');
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

beforeEach(() => {
  mocks.composite.mockReset().mockResolvedValue(jpegBlob());
});

afterAll(() => closeDatabase());

describe('series export, one file per project', () => {
  it('puts each Project in its own file, numbered in Series order', async () => {
    const hr = await projectWithStep('HR');
    const apex = await projectWithStep('APEX');

    const files = await filesOf(await generateSeriesZip([apex, hr], 'html'));

    expect(Object.keys(files)).toEqual(['01-apex.html', '02-hr.html']);
    expect(strFromU8(files['02-hr.html']!)).toContain('HR step');
  });

  it('gives each Project a Markdown folder with its own images', async () => {
    const hr = await projectWithStep('HR');

    const files = await filesOf(await generateSeriesZip([hr], 'markdown'));

    expect(Object.keys(files).sort()).toEqual(['01-hr/hr.md', '01-hr/images/01.jpg']);
    expect(strFromU8(files['01-hr/hr.md']!)).toContain('](images/01.jpg)');
  });

  it('leaves out a Project with no steps and keeps the others numbered by place', async () => {
    const empty = (await createProject({ title: 'Empty' })).id;
    const hr = await projectWithStep('HR');

    const files = await filesOf(await generateSeriesZip([empty, hr], 'html'));

    expect(Object.keys(files)).toEqual(['02-hr.html']);
  });

  it('names the ZIP after the Series', async () => {
    const hr = await projectWithStep('HR');
    const file = await generateSeriesExport({ title: 'M-Role Performance' }, [hr], 'html', 'separate');
    expect(file?.filename).toBe('m-role-performance.zip');
  });

  it('names the Project that failed', async () => {
    const hr = await projectWithStep('HR');
    mocks.composite.mockRejectedValue(new Error('decode failed'));

    const failure = await generateSeriesZip([hr], 'html').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SeriesProjectExportError);
    expect((failure as SeriesProjectExportError).cause).toBeInstanceOf(StepImageError);
    expect(exportFailureMessage('html', failure)).toMatch(/^「HR」：第 1 步的圖片無法讀取/);
  });

  it('stops when aborted', async () => {
    const hr = await projectWithStep('HR');
    const controller = new AbortController();
    controller.abort();
    await expect(generateSeriesZip([hr], 'html', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('series export, one document', () => {
  it('gives the HTML the Series title and each Project a heading, with steps one level below', async () => {
    const hr = await projectWithStep('HR', 'For HR');
    const apex = await projectWithStep('APEX');

    const file = await generateSeriesExport({ title: 'M-Role' }, [hr, apex], 'html', 'merged');
    const html = await file!.blob.text();

    expect(file!.filename).toBe('m-role.html');
    expect(html).toContain('<h1>M-Role</h1>');
    expect(html.indexOf('<h2 class="part-heading">HR</h2>')).toBeLessThan(html.indexOf('<h2 class="part-heading">APEX</h2>'));
    expect(html).toContain('<p class="part-description">For HR</p>');
    expect(html).toContain('<h4 class="step-title"><span class="step-number">1.</span><span>APEX step</span></h4>');
  });

  it('writes one Markdown document with images named by part and step', async () => {
    const hr = await projectWithStep('HR');
    const apex = await projectWithStep('APEX');

    const file = await generateSeriesExport({ title: 'M-Role' }, [hr, apex], 'markdown', 'merged');
    const files = await filesOf(file?.blob);
    const markdown = strFromU8(files['m-role.md']!);

    expect(file!.filename).toBe('m-role.zip');
    expect(Object.keys(files).sort()).toEqual(['images/01-01.jpg', 'images/02-01.jpg', 'm-role.md']);
    expect(markdown.startsWith('# M\\-Role\n\n## HR\n\n#### 1. HR step\n\n![HR step](images/01-01.jpg)')).toBe(true);
    expect(markdown).toContain('## APEX\n\n#### 1. APEX step');
  });

  it('puts each Project on its own PDF page under its own bookmark', async () => {
    const hr = await projectWithStep('HR');
    const apex = await projectWithStep('APEX');

    const file = await generateSeriesExport({ title: 'M-Role' }, [hr, apex], 'pdf', 'merged', { pdfSettings: { stepLayout: 'continuous' } });
    const pdf = await readPdf(file!.blob);

    expect(file!.filename).toBe('m-role.pdf');
    expect(pdf.pages.map((page) => page.lines[0])).toEqual(['M-Role', 'HR', 'APEX']);
    expect(pdf.outline).toEqual([
      { title: 'HR', items: [{ title: '1. HR step', items: [] }] },
      { title: 'APEX', items: [{ title: '1. APEX step', items: [] }] },
    ]);
  });

  it('skips Projects with no steps and resolves null when none has any', async () => {
    const empty = (await createProject({ title: 'Empty' })).id;
    expect(await generateSeriesExport({ title: 'S' }, [empty], 'html', 'merged')).toBeNull();

    const hr = await projectWithStep('HR');
    const html = await (await generateSeriesExport({ title: 'S' }, [empty, hr], 'html', 'merged'))!.blob.text();
    expect(html).not.toContain('Empty');
  });

  it('names the Project whose step failed', async () => {
    const hr = await projectWithStep('HR');
    const apex = await projectWithStep('APEX');
    mocks.composite.mockResolvedValueOnce(jpegBlob()).mockRejectedValueOnce(new Error('decode failed'));

    const failure = await generateSeriesExport({ title: 'S' }, [hr, apex], 'html', 'merged').catch((error: unknown) => error);

    expect(exportFailureMessage('html', failure)).toMatch(/^「APEX」：第 1 步的圖片無法讀取/);
  });

  it('refuses a Series larger than one Project may be, before rendering', async () => {
    const big = await projectWithStep('Big');
    const other = await projectWithStep('Other');
    const { runWithDatabase } = await import('@/lib/storage/database');
    await runWithDatabase(async (db) => {
      const row = (await db.get('projects', big))!;
      await db.put('projects', { ...row, storageBytes: 64 * 1024 * 1024 });
    });

    const failure = await generateSeriesExport({ title: 'S' }, [big, other], 'pdf', 'merged').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SeriesTooLargeError);
    expect(mocks.composite).not.toHaveBeenCalled();
    expect(exportFailureMessage('pdf', failure)).toBe('系列太大，無法合併成一份。請改用「各自一份」。');
  });
});

import 'fake-indexeddb/auto';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ composite: vi.fn() }));
vi.mock('@/lib/export/entry-render', () => ({ compositeStepEntry: mocks.composite }));

import { closeDatabase } from '@/lib/storage/database';
import { createProject, updateProject } from '@/lib/storage/project-repository';
import { generateSeriesZip, seriesExportFilename } from '@/lib/export/series-export';
import { SeriesProjectExportError, StepImageError } from '@/lib/export/export-errors';
import { exportFailureMessage } from '@/lib/export/export-failure';
import type { Step } from '@/lib/storage/models';
import { seedSteps } from '../setup/step-fixtures';
import { jpegBlob } from '../setup/raster-fixtures';

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

async function projectWithStep(title: string): Promise<string> {
  const id = crypto.randomUUID();
  await seedSteps([step(id, `${title} step`)]);
  await updateProject(id, { title });
  return id;
}

async function filesOf(blob: Blob | null): Promise<Record<string, Uint8Array>> {
  if (!blob) throw new Error('expected a ZIP');
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

beforeEach(() => {
  mocks.composite.mockReset().mockResolvedValue(new Blob(['annotated'], { type: 'image/jpeg' }));
});

describe('generateSeriesZip', () => {
  afterAll(() => closeDatabase());

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

  it('resolves null when no Project has steps', async () => {
    const empty = (await createProject()).id;
    expect(await generateSeriesZip([empty], 'pdf')).toBeNull();
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

describe('seriesExportFilename', () => {
  it('names the ZIP after the Series', () => {
    expect(seriesExportFilename('M-Role Performance')).toBe('m-role-performance.zip');
  });
});

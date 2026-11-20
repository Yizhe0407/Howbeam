import 'fake-indexeddb/auto';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '@/lib/storage/database';
import { createSeriesWithProjects, getProjectSummaries, updateProject } from '@/lib/storage/project-repository';
import { createSeries, getAllSeries } from '@/lib/storage/series-repository';
import { getSteps } from '@/lib/storage/step-repository';
import { ProjectArchiveError } from '@/lib/export/project-archive-contract';
import { exportProjectArchive } from '@/lib/export/project-archive-serialize';
import {
  SERIES_ARCHIVE_MIME_TYPE,
  exportStoredSeriesArchive,
  importSeriesArchive,
  isSeriesArchive,
} from '@/lib/export/series-archive';
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
  await updateProject(id, { title, description: `${title} notes` });
  return id;
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function rezip(bytes: Uint8Array, change: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(bytes);
  change(files);
  return zipSync(files, { level: 0 });
}

async function failure(source: Uint8Array): Promise<ProjectArchiveError> {
  const error = await importSeriesArchive(source).catch((caught: unknown) => caught);
  if (!(error instanceof ProjectArchiveError)) throw new Error(`expected a ProjectArchiveError, got ${String(error)}`);
  return error;
}

describe('series archive', () => {
  afterAll(() => closeDatabase());

  it('round-trips a series: title, order and every project in full', async () => {
    const hr = await projectWithStep('HR');
    const apex = await projectWithStep('APEX');
    const series = await createSeries('M-Role', [apex, hr]);

    const blob = await exportStoredSeriesArchive(series);
    const imported = await importSeriesArchive(blob);

    expect(blob.type).toBe(SERIES_ARCHIVE_MIME_TYPE);
    expect(imported.title).toBe('M-Role');
    expect(imported.projects.map((project) => project.metadata.title)).toEqual(['APEX', 'HR']);
    expect(imported.projects[0]!.metadata.description).toBe('APEX notes');
    expect(imported.projects[1]!.steps.map((entry) => entry.title)).toEqual(['HR step']);
  });

  it('restores as new projects in a new series, in one write', async () => {
    const hr = await projectWithStep('HR');
    const series = await createSeries('Restore me', [hr]);
    const imported = await importSeriesArchive(await exportStoredSeriesArchive(series));
    const before = (await getProjectSummaries()).length;

    const restored = await createSeriesWithProjects(imported.title, imported.projects.map((project) => ({
      steps: project.steps,
      initial: { title: project.metadata.title, description: project.metadata.description },
      sections: project.metadata.sections,
    })));

    expect((await getProjectSummaries()).length).toBe(before + 1);
    expect(restored.projectIds).toHaveLength(1);
    expect(restored.projectIds[0]).not.toBe(hr);
    expect((await getSteps(restored.projectIds[0]!)).map((entry) => entry.title)).toEqual(['HR step']);
    expect((await getAllSeries()).find((entry) => entry.id === restored.id)?.title).toBe('Restore me');
  });

  it('tells a series file from a project file', async () => {
    const hr = await projectWithStep('HR');
    const series = await createSeries('S', [hr]);

    expect(isSeriesArchive(await bytesOf(await exportStoredSeriesArchive(series)))).toBe(true);
    expect(isSeriesArchive(await bytesOf(await exportProjectArchive(await getSteps(hr))))).toBe(false);
    expect(isSeriesArchive(strToU8('not a zip'))).toBe(false);
  });

  it('refuses a newer version, unknown fields, and files the manifest does not list', async () => {
    const hr = await projectWithStep('HR');
    const bytes = await bytesOf(await exportStoredSeriesArchive(await createSeries('S', [hr])));
    const manifest = (files: Record<string, Uint8Array>) => JSON.parse(new TextDecoder().decode(files['series.json'])) as Record<string, unknown>;

    expect((await failure(rezip(bytes, (files) => {
      files['series.json'] = strToU8(JSON.stringify({ ...manifest(files), version: 2 }));
    }))).code).toBe('UNSUPPORTED_VERSION');
    expect((await failure(rezip(bytes, (files) => {
      files['series.json'] = strToU8(JSON.stringify({ ...manifest(files), extra: true }));
    }))).code).toBe('INVALID_ARCHIVE');
    expect((await failure(rezip(bytes, (files) => {
      files['projects/999.howbeam'] = strToU8('stray');
    }))).code).toBe('INVALID_ARCHIVE');
  });

  it('refuses a broken project inside with the project importer\'s own reason', async () => {
    const hr = await projectWithStep('HR');
    const bytes = await bytesOf(await exportStoredSeriesArchive(await createSeries('S', [hr])));

    const error = await failure(rezip(bytes, (files) => {
      files['projects/001.howbeam'] = strToU8('not a zip');
    }));

    expect(error.code).toBe('INVALID_ARCHIVE');
  });
});

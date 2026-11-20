import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase, ProjectNotFoundError } from '@/lib/storage/database';
import { createProject, deleteProjectPermanently } from '@/lib/storage/project-repository';
import {
  addProjectToSeries,
  createSeries,
  deleteSeries,
  getAllSeries,
  removeProjectFromSeries,
  renameSeries,
  reorderSeries,
  SeriesNotFoundError,
} from '@/lib/storage/series-repository';
import { getProject } from '@/lib/storage/project-repository';

async function seriesById(id: string) {
  return (await getAllSeries()).find((series) => series.id === id);
}

describe('series repository', () => {
  afterAll(() => closeDatabase());

  it('creates a Series holding its Projects in order', async () => {
    const first = await createProject({ title: 'HR' });
    const second = await createProject({ title: 'APEX' });

    const series = await createSeries('  M-Role  ', [first.id, second.id]);

    expect(await seriesById(series.id)).toMatchObject({ title: 'M-Role', projectIds: [first.id, second.id] });
  });

  it('refuses a Project that does not exist', async () => {
    await expect(createSeries('x', ['missing'])).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('moves a Project out of its old Series when it joins another', async () => {
    const project = await createProject();
    const from = await createSeries('from', [project.id]);
    const to = await createSeries('to');

    await addProjectToSeries(to.id, project.id);

    expect((await seriesById(from.id))?.projectIds).toEqual([]);
    expect((await seriesById(to.id))?.projectIds).toEqual([project.id]);
  });

  it('keeps a member where it is when it is added again', async () => {
    const first = await createProject();
    const second = await createProject();
    const series = await createSeries('s', [first.id, second.id]);

    await addProjectToSeries(series.id, first.id);

    expect((await seriesById(series.id))?.projectIds).toEqual([first.id, second.id]);
  });

  it('reorders only to a permutation of the current members', async () => {
    const first = await createProject();
    const second = await createProject();
    const series = await createSeries('s', [first.id, second.id]);

    await reorderSeries(series.id, [second.id, first.id]);
    expect((await seriesById(series.id))?.projectIds).toEqual([second.id, first.id]);

    await expect(reorderSeries(series.id, [second.id])).rejects.toThrow();
    await expect(reorderSeries(series.id, [second.id, second.id])).rejects.toThrow();
    expect((await seriesById(series.id))?.projectIds).toEqual([second.id, first.id]);
  });

  it('renames, removes a member, and dissolves without touching Projects', async () => {
    const project = await createProject({ title: 'kept' });
    const series = await createSeries('old', [project.id]);

    await renameSeries(series.id, 'new');
    expect((await seriesById(series.id))?.title).toBe('new');

    await removeProjectFromSeries(series.id, project.id);
    expect((await seriesById(series.id))?.projectIds).toEqual([]);

    await addProjectToSeries(series.id, project.id);
    await deleteSeries(series.id);
    expect(await seriesById(series.id)).toBeUndefined();
    expect((await getProject(project.id))?.title).toBe('kept');
    await expect(renameSeries(series.id, 'x')).rejects.toBeInstanceOf(SeriesNotFoundError);
  });

  it('takes a deleted Project out of its Series in the same write', async () => {
    const gone = await createProject();
    const stays = await createProject();
    const series = await createSeries('s', [gone.id, stays.id]);

    await deleteProjectPermanently(gone.id);

    expect((await seriesById(series.id))?.projectIds).toEqual([stays.id]);
  });
});

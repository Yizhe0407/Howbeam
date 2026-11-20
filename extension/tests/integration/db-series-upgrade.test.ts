import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '@/lib/storage/database';
import { getProjectSummaries } from '@/lib/storage/project-repository';
import { createSeries, getAllSeries } from '@/lib/storage/series-repository';

describe('database upgrade to version 4', () => {
  afterAll(() => closeDatabase());

  it('adds the series store and keeps existing projects', async () => {
    const legacy = await openDB('howbeam', 3, {
      upgrade(db) {
        const steps = db.createObjectStore('steps', { keyPath: 'id' });
        steps.createIndex('by-session', 'sessionId');
        const projects = db.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('by-updated-at', 'updatedAt');
      },
    });
    await legacy.put('projects', {
      id: 'p',
      title: 'Kept',
      description: '',
      sections: [],
      createdAt: 1,
      updatedAt: 1,
      contentRevision: 0,
      stepEditRevision: 0,
      metadataRevision: 0,
      stepCount: 0,
      entryCount: 0,
      storageBytes: 0,
    });
    legacy.close();

    expect(await getAllSeries()).toEqual([]);
    expect((await getProjectSummaries()).map((project) => project.title)).toEqual(['Kept']);
    const series = await createSeries('s', ['p']);
    expect((await getAllSeries()).map((entry) => entry.id)).toEqual([series.id]);
  });
});

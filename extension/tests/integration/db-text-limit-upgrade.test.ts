import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '@/lib/storage/database';
import { getSteps } from '@/lib/storage/step-repository';

describe('database upgrade to version 3', () => {
  afterAll(() => closeDatabase());

  it('cuts step titles and marker labels saved under the older limits', async () => {
    const legacy = await openDB('howbeam', 2, {
      upgrade(db) {
        const steps = db.createObjectStore('steps', { keyPath: 'id' });
        steps.createIndex('by-session', 'sessionId');
        const projects = db.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('by-updated-at', 'updatedAt');
      },
    });
    await legacy.put('steps', { id: 'step-1', sessionId: 'p', order: 0, title: '標'.repeat(500), description: '說'.repeat(500) });
    await legacy.put('steps', { id: 'anchor', sessionId: 'p', groupId: 'anchor', order: 1, title: '', description: '' });
    await legacy.put('steps', { id: 'marker', sessionId: 'p', groupId: 'anchor', order: 2, title: '', description: '註'.repeat(200) });
    legacy.close();

    const steps = await getSteps('p');

    expect(steps.map((step) => [step.id, step.title.length, step.description.length])).toEqual([
      ['step-1', 60, 500],
      ['anchor', 0, 0],
      ['marker', 0, 60],
    ]);
  });
});

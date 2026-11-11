import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const localStorageArea = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: vi.fn(async (key: string) => (values.has(key) ? { [key]: values.get(key) } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
});

vi.mock('wxt/browser', () => ({
  browser: { storage: { local: localStorageArea, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } },
}));

import { closeDatabase } from '@/lib/storage/database';
import { createProject, getProject, updateProject } from '@/lib/storage/project-repository';
import { addStepsAfter, saveStepDescription, updateStepsAtomically } from '@/lib/storage/step-repository';
import { type Step } from '@/lib/storage/models';
import { pngBlob } from '../setup/raster-fixtures';

afterAll(closeDatabase);

beforeEach(() => {
  localStorageArea.values.clear();
});

function makeStep(sessionId: string, overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(),
    sessionId,
    order: 0,
    screenshotBlob: pngBlob(),
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Project revisions', () => {
  it('bumps metadataRevision, never contentRevision, on a metadata edit', async () => {
    // Backups notice the edit; a pending structural undo (which checks contentRevision) survives it.
    const project = await createProject();
    const renamed = await updateProject(project.id, { title: '我的教學' });
    expect(renamed.metadataRevision).toBe(project.metadataRevision + 1);
    expect(renamed.contentRevision).toBe(project.contentRevision);
    const described = await updateProject(project.id, { description: 'x' });
    expect(described.metadataRevision).toBe(renamed.metadataRevision + 1);
    expect(described.contentRevision).toBe(project.contentRevision);
  });

  it('bumps stepEditRevision, never contentRevision, when a step is edited in place', async () => {
    const project = await createProject();
    const step = makeStep(project.id);
    await addStepsAfter([step], null);
    const added = (await getProject(project.id))!;
    await saveStepDescription(step.id, '新說明');
    await updateStepsAtomically(project.id, [{ id: step.id, changes: { crop: null, imageEdits: [] } }]);
    const edited = (await getProject(project.id))!;
    expect(edited.contentRevision).toBe(added.contentRevision);
    expect(edited.stepEditRevision).toBe(added.stepEditRevision + 2);
    expect(edited).toMatchObject({ stepCount: added.stepCount, entryCount: added.entryCount, storageBytes: added.storageBytes });

    await addStepsAfter([makeStep(project.id, { order: 1 })], null);
    const grown = (await getProject(project.id))!;
    expect(grown.contentRevision).toBe(added.contentRevision + 1);
    expect(grown.stepEditRevision).toBe(edited.stepEditRevision);
  });

});

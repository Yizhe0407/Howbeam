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

import { closeDatabase, isPristineProject } from '@/lib/storage/database';
import { createProject, discardPristineProject, getProject, updateProject } from '@/lib/storage/project-repository';
import { addStepsAfter, saveStepDescription, updateStepsAtomically } from '@/lib/storage/step-repository';
import { type Step } from '@/lib/storage/models';
import { ACTIVE_PROJECT_ID_KEY, getActiveProjectId, setActiveProjectId } from '@/lib/storage/storage';
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

describe('isPristineProject', () => {
  it('recognises the exact empty shell createProject leaves behind', async () => {
    const project = await createProject();
    expect(isPristineProject(project)).toBe(true);
  });

  it('stops matching once the user names, describes, or tags the project', async () => {
    const named = await createProject({ title: '我的教學' });
    const described = await createProject({ description: '說明' });
    const tagged = await createProject({ tags: ['入門'] });

    expect(isPristineProject(named)).toBe(false);
    expect(isPristineProject(described)).toBe(false);
    expect(isPristineProject(tagged)).toBe(false);
  });

  it('stops matching once anything was recorded into the project', async () => {
    const project = await createProject();
    await addStepsAfter([makeStep(project.id)], null);

    expect(isPristineProject((await getProject(project.id))!)).toBe(false);
  });
});

describe('discardPristineProject', () => {
  it('deletes a pristine project and compare-and-clears the matching selection', async () => {
    const project = await createProject();
    await setActiveProjectId(project.id);

    await expect(discardPristineProject(project.id)).resolves.toBe(true);

    await expect(getProject(project.id)).resolves.toBeUndefined();
    await expect(getActiveProjectId()).resolves.toBeNull();
  });

  it('leaves a different selection untouched', async () => {
    const project = await createProject();
    await setActiveProjectId('project-other');

    await expect(discardPristineProject(project.id)).resolves.toBe(true);

    expect(localStorageArea.values.get(ACTIVE_PROJECT_ID_KEY)).toBe('project-other');
  });

  it('never deletes a project the user meanwhile touched', async () => {
    const project = await createProject();
    await updateProject(project.id, { title: '我的教學' });
    await setActiveProjectId(project.id);

    await expect(discardPristineProject(project.id)).resolves.toBe(false);

    await expect(getProject(project.id)).resolves.toMatchObject({ id: project.id, title: '我的教學' });
    await expect(getActiveProjectId()).resolves.toBe(project.id);
  });

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
    await saveStepDescription(step.id, '新說明', step.description);
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

  it('treats an already-deleted project as a no-op', async () => {
    await expect(discardPristineProject('project-gone')).resolves.toBe(false);
  });
});

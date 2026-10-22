// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { act, renderHook } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectMutations } from '@/components/editor/use-project-mutations';
import type { PendingUndoAction, UndoAction } from '@/lib/editor/editor-app-model';
import { closeDatabase } from '@/lib/storage/database';
import { entryId, type Project, type Step, type StepEntry } from '@/lib/storage/models';
import { ensureProject, getProject } from '@/lib/storage/project-repository';
import {
  addProjectSectionAtomically,
  getProjectStructureSnapshot,
  renameProjectSectionAtomically,
} from '@/lib/storage/project-structure';
import { getSteps } from '@/lib/storage/step-repository';
import { t } from '@/lib/shared/i18n';
import { jpegBlob } from '../setup/raster-fixtures';
import { seedSteps } from '../setup/step-fixtures';

/**
 * The editor's structural edits against real storage: each one goes through
 * the hook's lock/flush/compare-and-swap contract, and its undo closure is run
 * back to check it restores exactly what was there.
 */

afterAll(closeDatabase);

// fake-indexeddb clones with Node's structuredClone, which cannot carry jsdom's
// Blob; the stored screenshots use Node's own.
vi.stubGlobal('Blob', NodeBlob);

let sessionId: string;

function single(id: string, order: number, overrides: Partial<Step> = {}): Step {
  return {
    id,
    sessionId,
    order,
    screenshotBlob: jpegBlob(),
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    devicePixelRatio: 1,
    description: `about ${id}`,
    url: 'https://example.com',
    timestamp: 1,
    ...overrides,
  };
}

/** A snapshot: its anchor row, then one annotation row per id. */
function snapshot(anchorId: string, order: number, annotationIds: string[], numbered = true): Step[] {
  return [
    single(anchorId, order, { groupId: anchorId, bounds: null, numbered }),
    ...annotationIds.map((id, index) =>
      single(id, order + 1 + index, { groupId: anchorId, screenshotBlob: undefined, numbered })),
  ];
}

const uid = (name: string) => `${sessionId}-${name}`;

/** The editor around the hook: what it shows, what is selected, the one undo it offers. */
function createEditor() {
  let undo: UndoAction | null = null;
  let undoIds = 0;
  const editor = {
    selectedEntryId: null as string | null,
    operationError: null as string | null,
    get undo() {
      return undo;
    },
  };

  async function run(action: (mutations: ReturnType<typeof useProjectMutations>) => Promise<void>, view?: StepEntry[]) {
    const fresh = await getProjectStructureSnapshot(sessionId);
    const entries = view ?? fresh.entries;
    const project: Project = fresh.project;
    const { result } = renderHook(() => useProjectMutations({
      sessionId,
      project,
      entries,
      selectedEntryId: editor.selectedEntryId,
      runOperation: (_label, operation) => operation(),
      editingBlocked: () => false,
      showOptimistic: () => () => undefined,
      flushDescriptions: async () => undefined,
      adoptCommitted: () => undefined,
      requireSelectedEntry: (expected?: string) => {
        const wanted = expected ?? editor.selectedEntryId;
        const entry = entries.find((candidate) => entryId(candidate) === wanted);
        if (!entry) throw new Error(`no entry ${wanted}`);
        return entry;
      },
      setSelectedEntryId: (next) => {
        editor.selectedEntryId = typeof next === 'function' ? next(editor.selectedEntryId) : next;
      },
      setZoomOpen: () => undefined,
      setOperationError: (message) => {
        editor.operationError = message;
      },
      undoAction: undo,
      offeredUndo: () => undo,
      offerUndo: (pending: PendingUndoAction, projectId: string) => {
        undo = { ...pending, id: ++undoIds, projectId };
      },
      takeUndo: () => {
        const taken = undo;
        undo = null;
        return taken;
      },
      returnUndo: (taken) => {
        undo = taken;
      },
      finalizeUndo: () => undefined,
      clearUndo: () => {
        undo = null;
      },
    }));
    await act(() => action(result.current));
  }

  return { editor, run };
}

/** What a reader sees: entry ids, with each snapshot's annotations. */
async function layout(): Promise<unknown[]> {
  const { entries } = await getProjectStructureSnapshot(sessionId);
  return entries.map((entry) =>
    entry.kind === 'single' ? entry.step.id : [entry.anchor.id, entry.annotations.map((annotation) => annotation.id)]);
}

async function sections() {
  return ((await getProject(sessionId))?.sections ?? []).map(({ title, startEntryId }) => ({ title, startEntryId }));
}

async function addSection(startEntryId: string, title: string) {
  const project = await getProject(sessionId);
  await addProjectSectionAtomically(sessionId, startEntryId, title, project!.contentRevision);
}

beforeEach(async () => {
  sessionId = crypto.randomUUID();
  await ensureProject(sessionId);
  await seedSteps([
    single(uid('a'), 0),
    ...snapshot(uid('g'), 1, [uid('g1'), uid('g2')]),
    single(uid('c'), 4),
  ]);
});

describe('delete step', () => {
  it('removes the entry, selects the next one, and undo puts it back unchanged', async () => {
    const { editor, run } = createEditor();
    editor.selectedEntryId = uid('a');

    await run((mutations) => mutations.deleteEntry());

    expect(await layout()).toEqual([[uid('g'), [uid('g1'), uid('g2')]], uid('c')]);
    expect(editor.selectedEntryId).toBe(uid('g'));
    expect(editor.undo?.message).toBe(t().editor.mutations.deleteStep.done(1));

    await run((mutations) => mutations.handleUndo());

    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g1'), uid('g2')]], uid('c')]);
    expect((await getSteps(sessionId)).find((step) => step.id === uid('a'))?.description).toBe(`about ${uid('a')}`);
    expect(editor.selectedEntryId).toBe(uid('a'));
    expect(editor.undo).toBeNull();
  });

  it('moves a section that started at the deleted entry, and undo moves it back', async () => {
    await addSection(uid('g'), 'Setup');
    const { editor, run } = createEditor();
    editor.selectedEntryId = uid('g');

    await run((mutations) => mutations.deleteEntry());

    expect(await sections()).toEqual([{ title: 'Setup', startEntryId: uid('c') }]);

    await run((mutations) => mutations.handleUndo());

    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g1'), uid('g2')]], uid('c')]);
    expect(await sections()).toEqual([{ title: 'Setup', startEntryId: uid('g') }]);
  });
});

describe('reorder', () => {
  it('reorders entries, and undo restores the previous order', async () => {
    const { run } = createEditor();
    const { entries } = await getProjectStructureSnapshot(sessionId);

    await run((mutations) => mutations.handleReorderEntries([entries[2], entries[0], entries[1]]));

    expect(await layout()).toEqual([uid('c'), uid('a'), [uid('g'), [uid('g1'), uid('g2')]]]);

    await run((mutations) => mutations.handleUndo());

    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g1'), uid('g2')]], uid('c')]);
  });

  it('refuses a reorder made on a list that is no longer what storage holds', async () => {
    const { editor, run } = createEditor();
    const { entries } = await getProjectStructureSnapshot(sessionId);
    const staleView = entries.slice(0, 2);

    await run((mutations) => mutations.handleReorderEntries([staleView[1], staleView[0]]), staleView);

    expect(editor.operationError).toBe(t().editor.mutations.conflict);
    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g1'), uid('g2')]], uid('c')]);
  });

  it('reorders a snapshot’s annotations, and undo restores them', async () => {
    const { editor, run } = createEditor();
    editor.selectedEntryId = uid('g');
    const steps = await getSteps(sessionId);
    const annotation = (id: string) => steps.find((step) => step.id === id)!;

    await run((mutations) => mutations.handleReorderAnnotations(uid('g'), [annotation(uid('g2')), annotation(uid('g1'))]));

    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g2'), uid('g1')]], uid('c')]);

    await run((mutations) => mutations.handleUndo());

    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g1'), uid('g2')]], uid('c')]);
  });
});

describe('delete annotation', () => {
  it('keeps the snapshot when other annotations remain, and undo restores the annotation in place', async () => {
    const { editor, run } = createEditor();
    editor.selectedEntryId = uid('g');
    const first = (await getSteps(sessionId)).find((step) => step.id === uid('g1'))!;

    await run((mutations) => mutations.handleDeleteAnnotation(first));

    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g2')]], uid('c')]);
    expect(editor.undo?.message).toBe(t().editor.mutations.deleteAnnotation.done(1));

    await run((mutations) => mutations.handleUndo());

    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g1'), uid('g2')]], uid('c')]);
  });

  it('removes the whole snapshot with its last annotation, and undo brings it back with its section', async () => {
    await seedSteps(snapshot(uid('h'), 5, [uid('h1')]));
    await addSection(uid('h'), 'Wrap-up');
    const { editor, run } = createEditor();
    editor.selectedEntryId = uid('h');
    const only = (await getSteps(sessionId)).find((step) => step.id === uid('h1'))!;

    await run((mutations) => mutations.handleDeleteAnnotation(only));

    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g1'), uid('g2')]], uid('c')]);
    expect(await sections()).toEqual([]);
    expect(editor.selectedEntryId).toBe(uid('c'));

    await run((mutations) => mutations.handleUndo());

    expect(await layout()).toEqual([uid('a'), [uid('g'), [uid('g1'), uid('g2')]], uid('c'), [uid('h'), [uid('h1')]]]);
    expect(await sections()).toEqual([{ title: 'Wrap-up', startEntryId: uid('h') }]);
  });
});

describe('snapshot numbering', () => {
  it('turns numbering off, and undo turns it back on', async () => {
    const { run } = createEditor();
    const numberedOf = async () => (await getSteps(sessionId)).find((step) => step.id === uid('g'))?.numbered;

    await run((mutations) => mutations.setEntriesNumbered([uid('g')], false));

    expect(await numberedOf()).toBe(false);

    await run((mutations) => mutations.handleUndo());

    expect(await numberedOf()).toBe(true);
  });

  it('offers no undo for a mixed selection, which has no single value to restore', async () => {
    await seedSteps(snapshot(uid('h'), 5, [uid('h1')], false));
    const { editor, run } = createEditor();

    await run((mutations) => mutations.setEntriesNumbered([uid('g'), uid('h')], true));

    expect(editor.undo).toBeNull();
  });
});

describe('sections', () => {
  it('deletes a section, and undo re-creates it at the same start with the same title', async () => {
    await addSection(uid('c'), 'Finish');
    const sectionId = (await getProject(sessionId))!.sections[0].id;
    const { editor, run } = createEditor();

    await run((mutations) => mutations.deleteSection(sectionId));

    expect(await sections()).toEqual([]);
    expect(editor.undo?.message).toBe(t().editor.mutations.deleteSection.done('Finish'));

    await run((mutations) => mutations.handleUndo());

    expect(await sections()).toEqual([{ title: 'Finish', startEntryId: uid('c') }]);
  });

  it('renames a section without offering an undo', async () => {
    await addSection(uid('c'), 'Finish');
    const sectionId = (await getProject(sessionId))!.sections[0].id;
    const { editor, run } = createEditor();

    await run((mutations) => mutations.renameSection(sectionId, 'Done'));

    expect(await sections()).toEqual([{ title: 'Done', startEntryId: uid('c') }]);
    expect(editor.undo).toBeNull();
  });
});

describe('undo after the project changed', () => {
  it('refuses to undo over a later change and leaves the data as it is', async () => {
    await addSection(uid('c'), 'Finish');
    const { editor, run } = createEditor();
    editor.selectedEntryId = uid('a');
    await run((mutations) => mutations.deleteEntry());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Another tab renames the section meanwhile.
    const project = (await getProject(sessionId))!;
    await renameProjectSectionAtomically(sessionId, project.sections[0].id, 'Renamed', project.contentRevision);

    await run((mutations) => mutations.handleUndo());

    expect(editor.operationError).toBe(t().editor.undo.conflict);
    expect(editor.undo).toBeNull();
    expect(await layout()).toEqual([[uid('g'), [uid('g1'), uid('g2')]], uid('c')]);
    expect(await sections()).toEqual([{ title: 'Renamed', startEntryId: uid('c') }]);
  });
});

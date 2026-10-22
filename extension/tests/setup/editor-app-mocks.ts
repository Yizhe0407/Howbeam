import { vi } from 'vitest';

/**
 * Shared mock tables for the EditorApp integration suites
 * (EditorAppStructure / editor-section-undo). vi.mock factories must stay
 * file-local (vitest hoists them per test file), so each suite wires its own
 * factories to tables produced here:
 *
 *   const database = await vi.hoisted(async () =>
 *     (await import('../setup/editor-app-mocks')).makeEditorDatabaseMocks());
 *
 * The tables are supersets; suites use the slice they care about.
 */
export function makeEditorDatabaseMocks() {
  const entryId = (entry: any) => (entry.kind === 'single' ? entry.step.id : entry.anchor.id);

  return {
    addProjectSectionAtomically: vi.fn(),
    deleteProjectSectionAtomically: vi.fn(),
    entryId,
    getProject: vi.fn(),
    getProjectStructureSnapshot: vi.fn(),
    renameProjectSectionAtomically: vi.fn(),
    setProjectEntriesNumberedAtomically: vi.fn(),
    updateProject: vi.fn(),
  };
}

export type EditorDatabaseMocks = ReturnType<typeof makeEditorDatabaseMocks>;

/** Mock table for @/lib/recording/use-recording-session in editor suites. */
export function makeRecordingSessionMocks() {
  return {
    useRecordingSession: vi.fn(),
  };
}

// @vitest-environment jsdom

import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';
import { TooltipProvider } from '@/components/ui/tooltip';

// The editor renders controls (EditorHeader, ...) that use the
// shadcn Tooltip, which requires a TooltipProvider ancestor — wrap every
// render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const database = await vi.hoisted(async () => (await import('../setup/editor-app-mocks')).makeEditorDatabaseMocks());

const recordingSession = await vi.hoisted(async () => (await import('../setup/editor-app-mocks')).makeRecordingSessionMocks());

vi.mock('wxt/browser', async () => {
  const { makeExtensionPageRuntimeMock } = await import('../setup/browser-mocks');
  return {
    browser: {
      runtime: makeExtensionPageRuntimeMock({ extensionHost: 'howbeam' }),
      permissions: { request: vi.fn() },
    },
  };
});

vi.mock('@/lib/storage/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/models')>()),
  entryId: database.entryId,
}));
vi.mock('@/lib/storage/project-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/project-repository')>()),
  getProject: database.getProject,
  updateProject: database.updateProject,
}));
vi.mock('@/lib/storage/project-structure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/project-structure')>()),
  getProjectStructureSnapshot: database.getProjectStructureSnapshot,
  deleteProjectSectionAtomically: database.deleteProjectSectionAtomically,
  renameProjectSectionAtomically: database.renameProjectSectionAtomically,
  addProjectSectionAtomically: database.addProjectSectionAtomically,
}));
vi.mock('@/lib/recording/use-recording-session', () => ({
  useRecordingSession: recordingSession.useRecordingSession,
}));
vi.mock('@/lib/editor/editor-autosave', () => ({
  EditorSaveProvider: ({ children }: any) => children,
  useEditorSaveRegistry: () => ({ flushAll: vi.fn().mockResolvedValue(undefined) }),
  DraftConfirmationRequiredError: class DraftConfirmationRequiredError extends Error {},
}));
vi.mock('@/lib/export/export-images', () => ({ exportImagesAsZip: vi.fn() }));

vi.mock('@/components/editor/EditorHeader', () => ({ default: () => null }));
vi.mock('@/components/editor/StepRail', () => ({
  default: (props: any) => (
    <aside aria-label="StepRail test double">
      <button type="button" onClick={() => void props.onDeleteSection('section-1')}>
        刪除第一個章節
      </button>
      <button type="button" onClick={() => props.onStartSection('entry-2')}>
        從第二步開始新章節
      </button>
      <button type="button" onClick={() => props.onRenameSection('section-1')}>
        重新命名第一個章節
      </button>
    </aside>
  ),
}));
vi.mock('@/components/editor/StepStage', () => ({ default: () => null }));
vi.mock('@/components/shared/EmptyState', () => ({ default: () => <div>EmptyState</div> }));
vi.mock('@/components/editor/Lightbox', () => ({ default: () => null }));
vi.mock('@/components/editor/ExportPopover', () => ({ default: ({ trigger }: { trigger: unknown }) => trigger }));

import EditorApp from '@/entrypoints/editor/App';

const entries = [
  {
    kind: 'single',
    step: {
      id: 'entry-1',
      sessionId: 'project-1',
      order: 0,
      bounds: null,
      devicePixelRatio: 1,
      description: '第一步',
      url: 'https://example.test/one',
      timestamp: 1,
      screenshotBlob: new Blob(['one'], { type: 'image/png' }),
    },
  },
  {
    kind: 'single',
    step: {
      id: 'entry-2',
      sessionId: 'project-1',
      order: 1,
      bounds: null,
      devicePixelRatio: 1,
      description: '第二步',
      url: 'https://example.test/two',
      timestamp: 2,
      screenshotBlob: new Blob(['two'], { type: 'image/png' }),
    },
  },
] as any[];

const section = { id: 'section-1', title: '準備', startEntryId: 'entry-1' };

function makeProject(contentRevision: number, sections: any[]) {
  return {
    id: 'project-1',
    title: '章節還原測試',
    description: '',
    sections,
    createdAt: 1,
    updatedAt: 2,
    contentRevision,
  };
}

const idleRecording = {
  sessionId: null,
  operation: null,
  isRecording: false,
  recapture: null,
  recaptureResult: null,
  itemCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  recordingSession.useRecordingSession.mockReturnValue({
    sessionId: 'project-1',
    tabId: 17,
    error: null,
    dataError: null,
    recording: idleRecording,
  });
  window.history.replaceState({}, '', '/editor.html?sessionId=project-1');
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('section delete undo', () => {
  it('offers an undo that re-creates the deleted section at its original position', async () => {
    let snapshotSections: any[] = [section];
    let snapshotRevision = 7;
    database.getProjectStructureSnapshot.mockImplementation(async () => ({
      project: makeProject(snapshotRevision, snapshotSections),
      entries,
      entryIds: entries.map(database.entryId),
    }));
    database.deleteProjectSectionAtomically.mockImplementation(async () => {
      snapshotSections = [];
      snapshotRevision = 8;
      return { project: makeProject(8, []), entries, entryIds: entries.map(database.entryId) };
    });
    database.addProjectSectionAtomically.mockImplementation(async () => {
      snapshotSections = [{ ...section, id: 'section-restored' }];
      snapshotRevision = 9;
      return { project: makeProject(9, snapshotSections), entries, entryIds: entries.map(database.entryId) };
    });

    render(<EditorApp />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除第一個章節' }));

    await waitFor(() => expect(database.deleteProjectSectionAtomically).toHaveBeenCalledOnce());
    expect(database.deleteProjectSectionAtomically).toHaveBeenCalledWith('project-1', 'section-1', 7);

    // The destructive edit must offer the same undo affordance as every other
    // structural mutation.
    expect(await screen.findByText('已刪除章節「準備」')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', {  name: '還原'  }));

    await waitFor(() => expect(database.addProjectSectionAtomically).toHaveBeenCalledOnce());
    // Restore re-creates the section against the post-delete revision, bound
    // to the same start entry and title — i.e. the same display position.
    expect(database.addProjectSectionAtomically).toHaveBeenCalledWith('project-1', 'entry-1', '準備', 8);

    await waitFor(() => expect(screen.queryByText('已刪除章節「準備」')).toBeNull());
  });

  it('drops the undo instead of restoring over a newer revision', async () => {
    silenceIntentionalErrorLogs();
    let snapshotSections: any[] = [section];
    let snapshotRevision = 7;
    database.getProjectStructureSnapshot.mockImplementation(async () => ({
      project: makeProject(snapshotRevision, snapshotSections),
      entries,
      entryIds: entries.map(database.entryId),
    }));
    database.deleteProjectSectionAtomically.mockImplementation(async () => {
      snapshotSections = [];
      snapshotRevision = 8;
      return { project: makeProject(8, []), entries, entryIds: entries.map(database.entryId) };
    });

    render(<EditorApp />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除第一個章節' }));
    expect(await screen.findByText('已刪除章節「準備」')).toBeTruthy();

    // Another writer moves the Project forward before the user clicks 還原.
    snapshotRevision = 12;
    fireEvent.click(screen.getByRole('button', {  name: '還原'  }));

    await waitFor(() => expect(screen.queryByText('已刪除章節「準備」')).toBeNull());
    expect(database.addProjectSectionAtomically).not.toHaveBeenCalled();
    expect(await screen.findByText('專案已被其他操作修改，為避免覆蓋最新內容，無法還原。')).toBeTruthy();
  });
});

describe('section dialog', () => {
  async function nameSection(title: string, submit: string) {
    const field = await screen.findByRole('textbox', { name: '章節名稱' });
    fireEvent.change(field, { target: { value: title } });
    fireEvent.click(screen.getByRole('button', { name: submit }));
  }

  it('adds the section named in the dialog, then offers an undo that deletes it again', async () => {
    let snapshotSections: any[] = [section];
    let snapshotRevision = 7;
    database.getProjectStructureSnapshot.mockImplementation(async () => ({
      project: makeProject(snapshotRevision, snapshotSections),
      entries,
      entryIds: entries.map(database.entryId),
    }));
    database.addProjectSectionAtomically.mockImplementation(async () => {
      snapshotSections = [section, { id: 'section-2', title: '操作', startEntryId: 'entry-2' }];
      snapshotRevision = 8;
      return { project: makeProject(8, snapshotSections), entries, entryIds: entries.map(database.entryId) };
    });
    database.deleteProjectSectionAtomically.mockImplementation(async () => {
      snapshotSections = [section];
      snapshotRevision = 9;
      return { project: makeProject(9, snapshotSections), entries, entryIds: entries.map(database.entryId) };
    });

    render(<EditorApp />);

    fireEvent.click(await screen.findByRole('button', { name: '從第二步開始新章節' }));
    expect(screen.getByRole('dialog', { name: '新增章節' })).toBeTruthy();
    expect(screen.getByText('從第 2 步開始新章節')).toBeTruthy();

    await nameSection('操作', '建立');
    await waitFor(() => expect(database.addProjectSectionAtomically).toHaveBeenCalledWith('project-1', 'entry-2', '操作', 7));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('已新增章節「操作」')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '還原' }));
    await waitFor(() => expect(database.deleteProjectSectionAtomically).toHaveBeenCalledWith('project-1', 'section-2', 8));
  });

  it('keeps the dialog open with the reason when adding fails', async () => {
    silenceIntentionalErrorLogs();
    database.getProjectStructureSnapshot.mockImplementation(async () => ({
      project: makeProject(7, [section]),
      entries,
      entryIds: entries.map(database.entryId),
    }));
    database.addProjectSectionAtomically.mockRejectedValue(new Error('storage failed'));

    render(<EditorApp />);

    fireEvent.click(await screen.findByRole('button', { name: '從第二步開始新章節' }));
    await nameSection('操作', '建立');

    const dialog = await screen.findByRole('dialog', { name: '新增章節' });
    await waitFor(() => expect(dialog.textContent).toContain('新增章節失敗，已重新載入目前資料。'));
    expect((screen.getByRole('textbox', { name: '章節名稱' }) as HTMLInputElement).value).toBe('操作');
  });

  it('renames from the current title through the same dialog', async () => {
    database.getProjectStructureSnapshot.mockImplementation(async () => ({
      project: makeProject(7, [section]),
      entries,
      entryIds: entries.map(database.entryId),
    }));
    database.renameProjectSectionAtomically.mockImplementation(async () => ({
      project: makeProject(8, [{ ...section, title: '前置作業' }]),
      entries,
      entryIds: entries.map(database.entryId),
    }));

    render(<EditorApp />);

    fireEvent.click(await screen.findByRole('button', { name: '重新命名第一個章節' }));
    expect(screen.getByRole('dialog', { name: '重新命名章節' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '章節名稱' }) as HTMLInputElement).value).toBe('準備');

    await nameSection('前置作業', '儲存');
    await waitFor(() => expect(database.renameProjectSectionAtomically).toHaveBeenCalledWith('project-1', 'section-1', '前置作業', 7));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

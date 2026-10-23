// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';
import { t } from '@/lib/shared/i18n';

const database = await vi.hoisted(async () => (await import('../setup/editor-app-mocks')).makeEditorDatabaseMocks());

const recordingSession = await vi.hoisted(async () => (await import('../setup/editor-app-mocks')).makeRecordingSessionMocks());

const browserApi = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  requestPermission: vi.fn(),
  tabsQuery: vi.fn(),
  tabsGet: vi.fn(),
  tabsUpdate: vi.fn(),
  windowsUpdate: vi.fn(),
  /** The editor page's handoff listener, captured on mount. */
  messageListener: null as null | ((message: unknown, sender: unknown) => unknown),
}));

const editorSave = vi.hoisted(() => ({
  flushAll: vi.fn(),
}));

const rendered = vi.hoisted(() => ({
  stepRailProps: null as any,
  stepStageProps: null as any,
}));

vi.mock('wxt/browser', async () => {
  const { makeExtensionPageRuntimeMock } = await import('../setup/browser-mocks');
  return {
    browser: {
      runtime: makeExtensionPageRuntimeMock({
        sendMessage: browserApi.sendMessage,
        onMessage: (listener) => {
          browserApi.messageListener = listener;
        },
        extensionHost: 'howbeam',
      }),
      tabs: {
        create: vi.fn(),
        get: browserApi.tabsGet,
        query: browserApi.tabsQuery,
        sendMessage: vi.fn(),
        update: browserApi.tabsUpdate,
      },
      windows: { update: browserApi.windowsUpdate },
      permissions: { request: browserApi.requestPermission },
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
  setProjectEntriesNumberedAtomically: database.setProjectEntriesNumberedAtomically,
}));
vi.mock('@/lib/recording/use-recording-session', () => ({
  useRecordingSession: recordingSession.useRecordingSession,
}));
vi.mock('@/lib/editor/editor-autosave', () => ({
  EditorSaveProvider: ({ children }: any) => children,
  useEditorSaveRegistry: () => ({ flushAll: editorSave.flushAll }),
  DraftConfirmationRequiredError: class DraftConfirmationRequiredError extends Error {},
}));
vi.mock('@/lib/export/export-images', () => ({ exportImagesAsZip: vi.fn() }));

vi.mock('@/components/editor/EditorHeader', () => ({ default: () => null }));
vi.mock('@/components/editor/StepRail', () => ({
  default: (props: any) => {
    rendered.stepRailProps = props;
    return (
      <aside
        aria-label="StepRail test double"
        data-reorder-disabled={String(props.reorderDisabled)}
      >
        <output data-testid="rail-selected">{props.selectedEntryId}</output>
        <output data-testid="rail-sections">
          {(props.sections ?? []).map((section: any) => `${section.title}:${section.startEntryId}`).join('|')}
        </output>
        <button type="button" onClick={() => props.onSelect('entry-2')}>
          開啟 entry-2
        </button>
        <button type="button" onClick={() => props.onContinueRecording?.()}>
          接續錄製
        </button>
        <button type="button" onClick={() => props.onContinueRecording?.('entry-1')}>
          在 entry-1 後接續錄製
        </button>
      </aside>
    );
  },
}));
vi.mock('@/components/editor/StepStage', () => ({
  default: (props: any) => {
    rendered.stepStageProps = props;
    const id = database.entryId(props.entry);
    return (
      <main
        aria-label="StepStage test double"
        data-entry-id={id}
        data-editing-disabled={String(props.editingDisabled)}
      >
        <button type="button" onClick={() => void props.onSetNumbered(id, false)}>
          關閉目前快照編號
        </button>
        <button type="button" disabled={props.editingDisabled} onClick={() => void props.onRecapture()}>
          準備補拍
        </button>
      </main>
    );
  },
}));
vi.mock('@/components/shared/EmptyState', () => ({ default: () => <div>EmptyState</div> }));
vi.mock('@/components/editor/Lightbox', () => ({ default: () => null }));
vi.mock('@/components/editor/ExportPopover', () => ({ default: ({ trigger }: { trigger: unknown }) => trigger }));

import EditorApp from '@/entrypoints/editor/App';
import { notifyProjectsChanged } from '@/lib/storage/change-notifier';
import { ProjectNotFoundError } from '@/lib/storage/database';
// Resolves to the mocked module above, so `instanceof` in the handoff matches.
import { DraftConfirmationRequiredError } from '@/lib/editor/editor-autosave';
import { itemAt } from '../setup/item-at';

const entries = [
  {
    kind: 'group',
    anchor: {
      id: 'entry-1',
      sessionId: 'project-1',
      order: 0,
      bounds: null,
      devicePixelRatio: 1,
      description: '第一個快照',
      url: 'https://example.test/one',
      timestamp: 1,
      groupId: 'entry-1',
      numbered: true,
      screenshotBlob: new Blob(['one'], { type: 'image/png' }),
    },
    annotations: [],
  },
  {
    kind: 'single',
    step: {
      id: 'entry-2',
      sessionId: 'project-1',
      order: 1,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      devicePixelRatio: 1,
      description: '第二步',
      url: 'https://example.test/two',
      timestamp: 2,
      screenshotBlob: new Blob(['two'], { type: 'image/png' }),
    },
  },
  {
    kind: 'single',
    step: {
      id: 'entry-3',
      sessionId: 'project-1',
      order: 2,
      bounds: { x: 5, y: 6, width: 7, height: 8 },
      devicePixelRatio: 1,
      description: '第三步',
      url: 'https://example.test/three',
      timestamp: 3,
      screenshotBlob: new Blob(['three'], { type: 'image/png' }),
    },
  },
] as any[];

const project = {
  id: 'project-1',
  title: '結構測試教學',
  description: '',
  sections: [
    { id: 'section-1', title: '準備', startEntryId: 'entry-1' },
    { id: 'section-2', title: '完成', startEntryId: 'entry-3' },
  ],
  createdAt: 1,
  updatedAt: 2,
  contentRevision: 7,
  stepEditRevision: 0,
  metadataRevision: 3,
};

const idleRecording = {
  sessionId: null,
  operation: null,
  isRecording: false,
  recapture: null,
  recaptureResult: null,
  itemCount: 0,
};

function editorSessionResult() {
  return {
    sessionId: 'project-1',
    tabId: 17,
    error: null,
    recording: idleRecording,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rendered.stepRailProps = null;
  rendered.stepStageProps = null;
  editorSave.flushAll.mockResolvedValue(undefined);
  recordingSession.useRecordingSession.mockImplementation((explicitSessionId?: string | null) => {
    if (explicitSessionId === 'project-1') return editorSessionResult();
    if (explicitSessionId === undefined) {
      return {
        ...editorSessionResult(),
        sessionId: 'global-project',
        recording: { ...idleRecording, sessionId: 'global-project' },
      };
    }
    return {
      sessionId: null,
      tabId: null,
      error: null,
      recording: { ...idleRecording, sessionId: 'global-project' },
    };
  });
  database.getProject.mockResolvedValue(project);
  database.getProjectStructureSnapshot.mockResolvedValue({
    project,
    entries,
    entryIds: entries.map(database.entryId),
  });
  browserApi.messageListener = null;
  browserApi.sendMessage.mockReset();
  browserApi.requestPermission.mockReset();
  browserApi.requestPermission.mockResolvedValue(true);
  database.setProjectEntriesNumberedAtomically.mockResolvedValue({
    project: { ...project, contentRevision: 8 },
    entries,
    entryIds: entries.map(database.entryId),
    affectedEntryIds: ['entry-1'],
  });
  window.history.replaceState({}, '', '/editor.html?sessionId=project-1');
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('Editor App structure wiring', () => {
  it('passes the active entry and Project sections to StepRail, and switches one entry at a time', async () => {
    render(<EditorApp />);

    await waitFor(() => expect(screen.getByTestId('rail-selected').textContent).toBe('entry-1'));
    expect(screen.getByTestId('rail-sections').textContent).toBe('準備:entry-1|完成:entry-3');
    expect(rendered.stepRailProps.sections).toEqual(project.sections);

    fireEvent.click(screen.getByRole('button', { name: '開啟 entry-2' }));

    await waitFor(() => expect(screen.getByTestId('rail-selected').textContent).toBe('entry-2'));
    expect(screen.getByLabelText('StepStage test double').getAttribute('data-entry-id')).toBe('entry-2');
  });

  it('uses a fresh structure snapshot revision for StepStage onSetNumbered atomic writes', async () => {
    const freshProject = { ...project, contentRevision: 41 };
    database.getProjectStructureSnapshot.mockResolvedValue({
      project: freshProject,
      entries,
      entryIds: entries.map(database.entryId),
    });
    browserApi.sendMessage.mockReset();
  browserApi.requestPermission.mockReset();
  browserApi.requestPermission.mockResolvedValue(true);
  database.setProjectEntriesNumberedAtomically.mockResolvedValue({
      project: { ...project, contentRevision: 42 },
      entries,
      entryIds: entries.map(database.entryId),
      affectedEntryIds: ['entry-1'],
    });
    render(<EditorApp />);

    await screen.findByRole('button', { name: '關閉目前快照編號' });
    fireEvent.click(screen.getByRole('button', { name: '關閉目前快照編號' }));

    await waitFor(() => expect(database.setProjectEntriesNumberedAtomically).toHaveBeenCalledOnce());
    expect(database.getProjectStructureSnapshot).toHaveBeenCalledWith('project-1');
    expect(database.setProjectEntriesNumberedAtomically).toHaveBeenCalledWith(
      'project-1',
      ['entry-1'],
      false,
      41,
    );
    expect(database.getProjectStructureSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      itemAt(database.setProjectEntriesNumberedAtomically.mock.invocationCallOrder, 0),
    );
  });

  it('preflights recapture without trusting the step URL and starts only after confirmation', async () => {
    silenceIntentionalErrorLogs();
    browserApi.sendMessage.mockImplementation(async (message: any) => {
      if (message.type === 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION') {
        return {
          ok: true,
          sourceUrl: 'https://fresh.example/recapture',
          sourceOrigin: 'https://fresh.example',
          permissionPattern: 'https://fresh.example/*',
        };
      }
      if (message.type === 'START_STEP_RECAPTURE') return { ok: true, runId: 'recapture-1' };
      return { ok: true };
    });
    render(<EditorApp />);

    await screen.findByRole('button', { name: '準備補拍' });
    await rendered.stepRailProps.onSelect('entry-2', { additive: false, range: false });
    await waitFor(() => expect(
      screen.getByLabelText('StepStage test double').getAttribute('data-entry-id'),
    ).toBe('entry-2'));
    fireEvent.click(screen.getByRole('button', { name: '準備補拍' }));

    expect(await screen.findByText('https://fresh.example')).toBeTruthy();
    // The grant is a security decision, so it blocks the editor in a modal
    // rather than a banner the user can scroll away from.
    const permissionDialog = screen.getByRole('dialog');
    expect(permissionDialog.textContent).toContain('補拍前需要存取來源網站');
    expect(permissionDialog.textContent).toContain('https://fresh.example');
    expect(browserApi.requestPermission).not.toHaveBeenCalled();
    expect(browserApi.sendMessage).toHaveBeenCalledWith({
      type: 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION',
      sessionId: 'project-1',
      target: { kind: 'single', stepId: 'entry-2' },
    });

    fireEvent.click(screen.getByRole('button', { name: '允許並開始' }));
    await waitFor(() => expect(browserApi.sendMessage).toHaveBeenCalledWith({
      type: 'START_STEP_RECAPTURE',
      sessionId: 'project-1',
      target: { kind: 'single', stepId: 'entry-2' },
    }));
    expect(browserApi.requestPermission).toHaveBeenCalledWith({ origins: ['https://fresh.example/*'] });
  });

  it('does not offer the elsewhere path in the recapture permission dialog', async () => {
    browserApi.sendMessage.mockImplementation(async (message: any) => {
      if (message.type === 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION') {
        return {
          ok: true,
          sourceUrl: 'https://fresh.example/recapture',
          sourceOrigin: 'https://fresh.example',
          permissionPattern: 'https://fresh.example/*',
        };
      }
      return { ok: true };
    });
    render(<EditorApp />);

    await screen.findByRole('button', { name: '準備補拍' });
    await rendered.stepRailProps.onSelect('entry-2', { additive: false, range: false });
    await waitFor(() => expect(
      screen.getByLabelText('StepStage test double').getAttribute('data-entry-id'),
    ).toBe('entry-2'));
    fireEvent.click(screen.getByRole('button', { name: '準備補拍' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '允許並開始' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '改在其他頁面接續' })).toBeNull();
    expect(dialog.textContent).not.toContain('新步驟會接在最後。');
  });

  it('shows the safe missing-id error and never falls back to a global Project without a sessionId URL', async () => {
    window.history.replaceState({}, '', '/editor.html');
    render(<EditorApp />);

    expect(await screen.findByRole('heading', { name: '找不到這個專案' })).toBeTruthy();
    expect(screen.getByText(/編輯器網址不完整/)).toBeTruthy();
    expect(recordingSession.useRecordingSession).toHaveBeenCalledWith(null);
    expect(recordingSession.useRecordingSession).not.toHaveBeenCalledWith(undefined);
    expect(database.getProject).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('StepRail test double')).toBeNull();
  });
});

describe('Editor App and changes from other tabs', () => {
  it('locks editing and says so when the Project is deleted in another tab', async () => {
    render(<EditorApp />);
    await waitFor(() => expect(screen.getByLabelText('StepStage test double').getAttribute('data-editing-disabled')).toBe('false'));

    silenceIntentionalErrorLogs();
    database.getProject.mockResolvedValue(undefined);
    database.getProjectStructureSnapshot.mockRejectedValue(new ProjectNotFoundError('project-1'));
    notifyProjectsChanged();

    expect(await screen.findByText(/專案已被刪除/)).toBeTruthy();
    expect(screen.getByLabelText('StepStage test double').getAttribute('data-editing-disabled')).toBe('true');
    await expect(rendered.stepStageProps.onTitleChange('新名稱')).rejects.toThrow();
    expect(database.updateProject).not.toHaveBeenCalled();
  });

  it('shows a title another tab saved', async () => {
    render(<EditorApp />);
    await waitFor(() => expect(rendered.stepStageProps?.projectTitle).toBe('結構測試教學'));

    database.getProjectStructureSnapshot.mockClear();
    database.getProject.mockResolvedValue({ ...project, title: '別的分頁改的標題', metadataRevision: project.metadataRevision + 1 });
    notifyProjectsChanged();

    await waitFor(() => expect(rendered.stepStageProps.projectTitle).toBe('別的分頁改的標題'));
    // Only the title changed, so the structure is not read again.
    expect(database.getProjectStructureSnapshot).not.toHaveBeenCalled();
  });

  it('sends a title edit as a single metadata update', async () => {
    database.updateProject.mockResolvedValue({ ...project, title: '新名稱', metadataRevision: 4 });
    render(<EditorApp />);
    await waitFor(() => expect(rendered.stepStageProps).not.toBeNull());

    await act(() => rendered.stepStageProps.onTitleChange('新名稱'));

    expect(database.updateProject).toHaveBeenCalledWith('project-1', { title: '新名稱' });
  });
});

describe('Editor continuation on another page (改在其他頁面接續)', () => {
  function mockContinuationPreflight(): void {
    browserApi.sendMessage.mockImplementation(async (message: any) => {
      if (message.type === 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION') {
        return {
          ok: true,
          sourceUrl: 'https://example.test/three',
          sourceOrigin: 'https://example.test',
          permissionPattern: 'https://example.test/*',
        };
      }
      if (message.type === 'START_RECORDING') {
        return { ok: true, sessionId: 'project-1', runId: 'run-elsewhere' };
      }
      return { ok: true };
    });
  }

  async function openContinuationDialog(): Promise<HTMLElement> {
    render(<EditorApp />);
    fireEvent.click(await screen.findByRole('button', { name: '接續錄製' }));
    return await screen.findByRole('dialog');
  }

  it('offers the secondary elsewhere path with the append hint next to the source-locked default', async () => {
    mockContinuationPreflight();
    const dialog = await openContinuationDialog();

    expect(dialog.textContent).toContain('接續錄製前需要存取來源網站');
    expect(dialog.textContent).toContain('https://example.test');
    expect(dialog.textContent).toContain('新步驟會接在最後。');
    expect(within(dialog).getByRole('button', { name: '允許並開始' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '改在其他頁面接續' })).toBeTruthy();
  });

  it('carries the chosen insertion point into the recording that starts', async () => {
    mockContinuationPreflight();
    browserApi.requestPermission.mockResolvedValue(true);
    render(<EditorApp />);
    fireEvent.click(await screen.findByRole('button', { name: '在 entry-1 後接續錄製' }));
    const dialog = await screen.findByRole('dialog');

    expect(dialog.textContent).toContain('新步驟會插在第 1 步後面。');
    expect(browserApi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION', afterEntryId: 'entry-1' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '允許並開始' }));
    await waitFor(() => expect(browserApi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'START_RECORDING', insertAfterEntryId: 'entry-1' }),
    ));
  });

  it('opens an explicit tab picker that skips preselecting the last-step URL tab', async () => {
    mockContinuationPreflight();
    browserApi.tabsQuery.mockResolvedValue([
      { id: 21, windowId: 3, url: 'chrome://settings/', lastAccessed: 990 },
      { id: 22, windowId: 3, url: 'chrome-extension://howbeam/editor.html', lastAccessed: 995 },
      // Most recently used recordable tab, but it shows the project's last-step
      // URL — the page the user just recorded — so it must not be preselected.
      { id: 26, windowId: 3, url: 'https://example.test/three', title: '來源頁面', lastAccessed: 900 },
      { id: 24, windowId: 4, url: 'https://recent.example/app', title: '最近的分頁', lastAccessed: 800 },
      { id: 23, windowId: 3, url: 'https://old.example/page', title: '較舊的分頁', lastAccessed: 100 },
      { id: 25, windowId: 4, lastAccessed: 999 },
    ]);
    const dialog = await openContinuationDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: '改在其他頁面接續' }));

    const picker = await screen.findByRole('radiogroup', { name: '選擇要接續錄製的分頁' });
    const options = within(picker).getAllByRole('radio');
    // Recordable tabs only, most recently used first.
    expect(options.map((option) => option.textContent)).toEqual([
      '來源頁面example.test',
      '最近的分頁recent.example',
      '較舊的分頁old.example',
    ]);
    expect(within(picker).getByRole('radio', { name: /最近的分頁/ }).getAttribute('aria-checked')).toBe('true');
    expect(within(picker).getByRole('radio', { name: /來源頁面/ }).getAttribute('aria-checked')).toBe('false');
    // Nothing starts until the user confirms a pick.
    expect(browserApi.tabsUpdate).not.toHaveBeenCalled();
    expect(browserApi.sendMessage.mock.calls.map(([message]: any[]) => message.type))
      .not.toContain('START_RECORDING');
  });

  it('starts a plain recording in the picked tab after explicit confirmation', async () => {
    mockContinuationPreflight();
    browserApi.tabsQuery.mockResolvedValue([
      { id: 26, windowId: 3, url: 'https://example.test/three', title: '來源頁面', lastAccessed: 900 },
      { id: 24, windowId: 4, url: 'https://recent.example/app', title: '最近的分頁', lastAccessed: 800 },
      { id: 23, windowId: 3, url: 'https://old.example/page', title: '較舊的分頁', lastAccessed: 100 },
    ]);
    browserApi.tabsUpdate.mockResolvedValue({ id: 23, windowId: 3, active: true });
    browserApi.windowsUpdate.mockResolvedValue({ id: 3 });
    browserApi.tabsGet.mockResolvedValue({
      id: 23,
      windowId: 3,
      active: true,
      url: 'https://old.example/page',
    });
    const dialog = await openContinuationDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '改在其他頁面接續' }));
    const picker = await screen.findByRole('radiogroup', { name: '選擇要接續錄製的分頁' });

    // The user overrides the preselection with an explicit pick.
    fireEvent.click(within(picker).getByRole('radio', { name: /較舊的分頁/ }));
    expect(within(picker).getByRole('radio', { name: /較舊的分頁/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    await waitFor(() => expect(browserApi.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      sessionId: 'project-1',
      mode: 'steps',
    }));
    const startCall = browserApi.sendMessage.mock.calls
      .map(([message]: any[]) => message)
      .find((message: any) => message.type === 'START_RECORDING');
    expect(startCall.continuation).toBeUndefined();
    expect(browserApi.windowsUpdate).toHaveBeenCalledWith(3, { focused: true });
    expect(browserApi.tabsUpdate).toHaveBeenCalledWith(23, { active: true });
    expect(browserApi.tabsUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      browserApi.sendMessage.mock.invocationCallOrder.at(-1)!,
    );
    // The elsewhere path records under the grants the run already holds; it
    // must never raise the source-origin permission prompt.
    expect(browserApi.requestPermission).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the dialog open with a clear error when no recordable tab exists', async () => {
    mockContinuationPreflight();
    browserApi.tabsQuery.mockResolvedValue([
      { id: 21, windowId: 3, url: 'chrome://settings/', lastAccessed: 990 },
      { id: 22, windowId: 3, url: 'chrome-extension://howbeam/editor.html', lastAccessed: 995 },
      { id: 25, windowId: 4, lastAccessed: 999 },
    ]);
    const dialog = await openContinuationDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: '改在其他頁面接續' }));

    await within(dialog).findByText('找不到可錄製的一般網頁分頁，請先開啟要接續錄製的網站。');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(browserApi.tabsUpdate).not.toHaveBeenCalled();
    expect(browserApi.sendMessage.mock.calls.map(([message]: any[]) => message.type))
      .not.toContain('START_RECORDING');
  });

  it('opens the dialog in elsewhere-only mode when the Project has no continuation source', async () => {
    browserApi.sendMessage.mockImplementation(async (message: any) => {
      if (message.type === 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION') {
        return { ok: false, code: 'SOURCE_NOT_FOUND', message: '這個專案還沒有可接續的來源頁面。' };
      }
      if (message.type === 'START_RECORDING') {
        return { ok: true, sessionId: 'project-1', runId: 'run-elsewhere' };
      }
      return { ok: true };
    });
    browserApi.tabsQuery.mockResolvedValue([
      { id: 31, windowId: 5, url: 'https://elsewhere.example/start', lastAccessed: 700 },
    ]);
    browserApi.tabsUpdate.mockResolvedValue({ id: 31, windowId: 5, active: true });
    browserApi.windowsUpdate.mockResolvedValue({ id: 5 });
    browserApi.tabsGet.mockResolvedValue({
      id: 31,
      windowId: 5,
      active: true,
      url: 'https://elsewhere.example/start',
    });
    const dialog = await openContinuationDialog();

    // Not a terminal error: the zero-step Project keeps the elsewhere path.
    expect(dialog.textContent).toContain('這個專案還沒有可接續的來源頁面。');
    expect(within(dialog).queryByRole('button', { name: '允許並開始' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: '改在其他頁面接續' }));

    // With no last-step URL to avoid, the picker preselects the sole tab.
    const picker = await screen.findByRole('radiogroup', { name: '選擇要接續錄製的分頁' });
    expect(within(picker).getByRole('radio', { name: /elsewhere\.example/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    await waitFor(() => expect(browserApi.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      sessionId: 'project-1',
      mode: 'steps',
    }));
    expect(browserApi.requestPermission).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

/**
 * The page half of the single-editor-tab contract. The background reuses this
 * tab based purely on these answers, so what the page replies is the whole
 * decision — mocked opener tests cannot stand in for it.
 */
describe('editor handoff answers (單一編輯器分頁)', () => {
  async function mountEditor() {
    render(<EditorApp />);
    await waitFor(() => expect(screen.getByTestId('rail-selected').textContent).toBe('entry-1'));
    await waitFor(() => expect(browserApi.messageListener).not.toBeNull());
    expect(browserApi.sendMessage).toHaveBeenCalledWith({ type: 'REGISTER_EXTENSION_PAGE' });
  }

  function handoff(message: unknown, sender: unknown = {}): Promise<unknown> | undefined {
    return browserApi.messageListener?.(message, sender) as Promise<unknown> | undefined;
  }

  it('reports ready and switches entry itself when it already shows the target Project', async () => {
    await mountEditor();

    const reply = await act(async () =>
      handoff({ type: 'EDITOR_HANDOFF', sessionId: 'project-1', entryId: 'entry-3' }));

    expect(reply).toEqual({ ok: true, ready: true });
    expect(editorSave.flushAll).toHaveBeenCalled();
    expect(screen.getByTestId('rail-selected').textContent).toBe('entry-3');
  });

  it('consents to being navigated to another Project once its descriptions are saved', async () => {
    await mountEditor();

    const reply = await act(async () => handoff({ type: 'EDITOR_HANDOFF', sessionId: 'project-2' }));

    expect(reply).toEqual({ ok: true, ready: false });
    expect(editorSave.flushAll).toHaveBeenCalled();
    // Navigation belongs to the background alone; the page still shows project-1.
    expect(screen.getByTestId('rail-selected').textContent).toBe('entry-1');
  });

  it('refuses to leave another Project while a draft awaits confirmation', async () => {
    silenceIntentionalErrorLogs();
    await mountEditor();
    // The confirmation error carries its own zh-Hant explanation of what to
    // resolve, and the reply must relay exactly that rather than a generic one.
    const draftConfirmation = new DraftConfirmationRequiredError();
    draftConfirmation.message = '覆寫已儲存的說明前，需要先確認要保留哪一份草稿。';
    editorSave.flushAll.mockRejectedValue(draftConfirmation);

    const reply = await act(async () => handoff({ type: 'EDITOR_HANDOFF', sessionId: 'project-2' }));

    expect(reply).toEqual({ ok: false, error: draftConfirmation.message });
  });

  it('refuses with a retry message when saving genuinely failed', async () => {
    silenceIntentionalErrorLogs();
    await mountEditor();
    editorSave.flushAll.mockRejectedValue(new Error('IndexedDB is unavailable'));

    const reply = await act(async () => handoff({ type: 'EDITOR_HANDOFF', sessionId: 'project-2' }));

    expect(reply).toEqual({ ok: false, error: t().editor.descriptionSaveRetry });
  });

  it('still reports ready for its own Project when the save is blocked, because nothing will navigate', async () => {
    silenceIntentionalErrorLogs();
    await mountEditor();
    editorSave.flushAll.mockRejectedValue(new Error('IndexedDB is unavailable'));

    const reply = await act(async () => handoff({ type: 'EDITOR_HANDOFF', sessionId: 'project-1' }));

    expect(reply).toEqual({ ok: true, ready: true });
  });

  it.each<[string, unknown, unknown]>([
    ['another message type', { type: 'HOWBEAM_STOP' }, {}],
    ['a handoff without a Project', { type: 'EDITOR_HANDOFF' }, {}],
    ['a handoff relayed from a tab rather than the background', { type: 'EDITOR_HANDOFF', sessionId: 'project-2' }, { tab: { id: 9 } }],
  ])('leaves %s untouched instead of answering it', async (_label, message, sender) => {
    await mountEditor();

    expect(handoff(message, sender)).toBeUndefined();
  });
});

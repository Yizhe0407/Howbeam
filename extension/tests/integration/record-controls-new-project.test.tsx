// @vitest-environment jsdom
import { t } from '@/lib/shared/i18n';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  getProjectSummaries: vi.fn(),
}));

vi.mock('wxt/browser', async () => {
  const { makePopupBrowserMock } = await import('../setup/browser-mocks');
  return {
    browser: makePopupBrowserMock({
      sendMessage: mocks.sendMessage,
      tabsQuery: mocks.query,
      storageGet: mocks.storageGet,
      storageSet: mocks.storageSet,
    }),
  };
});
// Only the storage primitives are mocked: the real project-actions transaction
// (create → send → verify → rollback with the live-run probe) runs under test.
vi.mock('@/lib/storage/project-repository', () => ({
  createProject: mocks.createProject,
  getProject: mocks.getProject,
  getProjectSummaries: mocks.getProjectSummaries,
}));

import RecordControls from '@/components/popup/RecordControls';
import { ACTIVE_PROJECT_ID_KEY } from '@/lib/storage/storage';
import { makeRecordingState } from '../setup/recording-state';
import { TooltipProvider } from '@/components/ui/tooltip';

// The mode picker uses the shadcn Tooltip, which requires a TooltipProvider
// ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const IDLE_RECORDING = makeRecordingState();

const SELECTED_PROJECT_WITH_CONTENT = {
  id: 'project-old',
  title: '既有教學',
  entryCount: 3,
  stepCount: 3,
};

/** Marks `project` as the current UI selection. */
function selectProjectInStorage(project: { id: string } & Record<string, unknown>) {
  mocks.storageGet.mockResolvedValue({ [ACTIVE_PROJECT_ID_KEY]: project.id });
  mocks.getProject.mockImplementation(async (id: string) => (id === project.id ? project : undefined));
}

beforeEach(() => {
  mocks.getProjectSummaries.mockResolvedValue([]);
  mocks.query.mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  mocks.storageGet.mockResolvedValue({});
  mocks.storageSet.mockResolvedValue(undefined);
  mocks.getProject.mockResolvedValue(undefined);
  mocks.createProject.mockResolvedValue({ id: 'project-new' });
  mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'project-new', runId: 'run-1' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('popup start always records into a fresh project', () => {
  it('asks the background for a Project of its own even when one with content is selected', async () => {
    selectProjectInStorage(SELECTED_PROJECT_WITH_CONTENT);
    const onStarted = vi.fn();
    render(<RecordControls recording={IDLE_RECORDING} onStarted={onStarted} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(mocks.sendMessage).toHaveBeenCalledWith({ type: 'START_RECORDING', target: { kind: 'new' }, mode: 'steps' });
    // The background creates the Project with the first capture; the popup creates and selects nothing.
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.storageSet).not.toHaveBeenCalledWith(expect.objectContaining({ [ACTIVE_PROJECT_ID_KEY]: expect.anything() }));
  });

  it('shows why the start was refused, with nothing to roll back', async () => {
    silenceIntentionalErrorLogs();
    selectProjectInStorage(SELECTED_PROJECT_WITH_CONTENT);
    mocks.sendMessage.mockResolvedValue({ ok: false, error: 'background.cannotStartHere' });
    const onStarted = vi.fn();
    render(<RecordControls recording={IDLE_RECORDING} onStarted={onStarted} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    expect((await screen.findByRole('alert')).textContent).toContain(t().background.cannotStartHere);
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  // The idle form no longer reads the selected project just to narrate the new-project-per-recording model.
  it('does not read the selected project just to narrate the data model', async () => {
    selectProjectInStorage(SELECTED_PROJECT_WITH_CONTENT);
    render(<RecordControls recording={IDLE_RECORDING} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    expect(screen.queryByText(/接續錄製/)).toBeNull();
    expect(mocks.getProject).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '開始錄製' })).toBeTruthy();
  });
});

describe('popup mode picker', () => {
  it('keeps each mode explanation out of the layout but on the radio as its description', async () => {
    render(<RecordControls recording={IDLE_RECORDING} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    const steps = screen.getByRole('radio', { name: /步驟/ });
    const snapshot = screen.getByRole('radio', { name: /標註/ });
    expect(steps.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(steps.getAttribute('aria-describedby')!)?.textContent).toBe(
      '每次點擊都會擷取一張截圖，自動編號成一連串操作步驟。',
    );
    expect(document.getElementById(snapshot.getAttribute('aria-describedby')!)?.textContent).toBe(
      '鎖定目前畫面，在同一張截圖上加入多個標註點。',
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

// jsdom lacks the pointer-capture and scrolling APIs Radix Select calls.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

describe('popup record target picker', () => {
  const RECENT = [
    { id: 'project-old', title: '既有教學', entryCount: 3, stepCount: 3, updatedAt: 2 },
    { id: 'project-b', title: '', entryCount: 0, stepCount: 0, updatedAt: 1 },
  ];

  async function pickTarget(name: string | RegExp) {
    fireEvent.keyDown(screen.getByRole('combobox', { name: '錄到哪裡' }), { key: 'Enter' });
    const option = await screen.findByRole('option', { name });
    option.focus();
    fireEvent.keyDown(option, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  }

  it('is absent until a project exists', async () => {
    render(<RecordControls recording={IDLE_RECORDING} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    await waitFor(() => expect(mocks.getProjectSummaries).toHaveBeenCalled());

    expect(screen.queryByRole('combobox', { name: '錄到哪裡' })).toBeNull();
  });

  it('defaults to a new project, so starting unchanged still creates one', async () => {
    mocks.getProjectSummaries.mockResolvedValue(RECENT);
    render(<RecordControls recording={IDLE_RECORDING} />);

    expect((await screen.findByRole('combobox', { name: '錄到哪裡' })).textContent).toContain('新專案');
    fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'new' } })));
  });

  it('appends to the chosen project without creating one', async () => {
    mocks.getProjectSummaries.mockResolvedValue(RECENT);
    mocks.getProject.mockImplementation(async (id: string) => RECENT.find((project) => project.id === id));
    const onStarted = vi.fn();
    render(<RecordControls recording={IDLE_RECORDING} onStarted={onStarted} />);
    await screen.findByRole('combobox', { name: '錄到哪裡' });

    await pickTarget(/^既有教學.*3 個步驟$/);
    fireEvent.click(screen.getByRole('button', { name: '接續錄製' }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'START_RECORDING',
      target: { kind: 'project', projectId: 'project-old' },
      mode: 'steps',
    });
  });

  it('labels an untitled project with the untitled placeholder', async () => {
    mocks.getProjectSummaries.mockResolvedValue(RECENT);
    render(<RecordControls recording={IDLE_RECORDING} />);
    await screen.findByRole('combobox', { name: '錄到哪裡' });

    fireEvent.keyDown(screen.getByRole('combobox', { name: '錄到哪裡' }), { key: 'Enter' });

    expect(await screen.findByRole('option', { name: /^未命名專案.*0 個步驟$/ })).toBeTruthy();
  });
});

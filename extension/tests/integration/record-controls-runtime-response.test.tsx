// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  discardPristineProject: vi.fn(),
  getProjectSummaries: vi.fn(),
}));

vi.mock('wxt/browser', async () => {
  const { makePopupBrowserMock } = await import('../setup/browser-mocks');
  return { browser: makePopupBrowserMock({ sendMessage: mocks.sendMessage, tabsQuery: mocks.query }) };
});
// Only the storage primitives are mocked; the real project-actions flow runs.
vi.mock('@/lib/storage/project-repository', () => ({
  createProject: mocks.createProject,
  getProject: mocks.getProject,
  discardPristineProject: mocks.discardPristineProject,
  getProjectSummaries: mocks.getProjectSummaries,
}));

import RecordControls from '@/components/popup/RecordControls';
import { makeRecordingState } from '../setup/recording-state';
import { TooltipProvider } from '@/components/ui/tooltip';

// The mode picker uses the shadcn Tooltip, which requires a TooltipProvider
// ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const IDLE_RECORDING = makeRecordingState();

beforeEach(() => {
  mocks.getProjectSummaries.mockResolvedValue([]);
  mocks.query.mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  mocks.createProject.mockResolvedValue({ id: 'project-a' });
  mocks.getProject.mockResolvedValue(undefined);
  mocks.discardPristineProject.mockResolvedValue(true);
  mocks.sendMessage.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('record controls runtime responses', () => {
  it.each([
    ['missing', null],
    ['incomplete success', { ok: true, sessionId: 'project-a' }],
    ['malformed failure', { ok: false, error: 503 }],
  ])('shows a transport error for a %s START_RECORDING response', async (_case, response) => {
    silenceIntentionalErrorLogs();
    mocks.sendMessage.mockResolvedValue(response);
    const onStarted = vi.fn();
    render(<RecordControls recording={IDLE_RECORDING} onStarted={onStarted} />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^開始/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('無法連接錄製功能');
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('resumes a paused run from its status, and shows the whole run\'s count', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true });
    const paused = makeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'paused',
      mode: 'snapshot',
      sessionId: 'project-a',
      runId: 'run-1',
      tabId: 7,
      itemCount: 1,
      runItemCount: 4,
    });
    render(<RecordControls recording={paused} onStarted={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '繼續錄製' }));

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith({ type: 'RESUME_RECORDING', runId: 'run-1' }));
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), permissionsContains: vi.fn(), storageGet: vi.fn() }));

vi.mock('wxt/browser', async () => {
  const { makePopupBrowserMock } = await import('../setup/browser-mocks');
  return {
    browser: makePopupBrowserMock({
      tabsQuery: mocks.query,
      permissionsContains: mocks.permissionsContains,
      storageGet: mocks.storageGet,
    }),
  };
});

import RecordControls from '@/components/popup/RecordControls';
import type { RecordingState, RecoverableRecordingError } from '@/lib/storage/recording-state';
import { makeRecordingState } from '../setup/recording-state';
import { TooltipProvider } from '@/components/ui/tooltip';

// The mode picker uses the shadcn Tooltip, which requires a TooltipProvider
// ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

function recoveryState(recoverableError: RecoverableRecordingError): RecordingState {
  return makeRecordingState({
    phase: 'error',
    sessionId: 'session-1',
    error: recoverableError.message,
    recoverableError,
  });
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.query.mockResolvedValue([{ id: 1, url: 'https://example.com' }]);
  mocks.permissionsContains.mockReset();
  mocks.permissionsContains.mockResolvedValue(false);
  mocks.storageGet.mockReset();
  mocks.storageGet.mockResolvedValue({});
});

afterEach(cleanup);

describe('record controls recovery', () => {
  it('says why a live run is on hold, for a user who is not on the recorded tab', () => {
    render(
      <RecordControls
        recording={makeRecordingState({
          operation: 'recording',
          isRecording: true,
          phase: 'recording',
          sessionId: 'session-1',
          runId: 'run-1',
          tabId: 4,
          error: '無法在剛才切換到的分頁錄製',
          recoverableError: { code: 'RECORDING_WAITING_FOLLOW_FAILED', message: '無法在剛才切換到的分頁錄製' },
        })}
        onOpenEditor={vi.fn()}
      />,
    );

    expect(screen.getByText('無法在剛才切換到的分頁錄製')).toBeTruthy();
  });

  it('offers completion through the editor after the source tab closes', () => {
    const onOpenEditor = vi.fn();
    render(
      <RecordControls
        recording={recoveryState({ code: 'RECORDED_TAB_CLOSED', message: 'closed' })}
        onOpenEditor={onOpenEditor}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '完成並開啟編輯器' }));
    expect(onOpenEditor).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /^開始/ })).toBeNull();
  });

  it('offers a retry and stable pending state after automatic navigation fails', async () => {
    render(
      <RecordControls
        recording={recoveryState({ code: 'EDITOR_OPEN_FAILED', message: 'failed' })}
        onOpenEditor={vi.fn()}
        openingEditor
      />,
    );

    // The opening state shows once it proves slow; until then the button only ignores clicks.
    expect((await screen.findByRole('button', { name: '正在開啟編輯器' })).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /^開始/ })).toBeNull();
  });

  // Regression: the starting phase used to fall through to the idle form with an enabled start button, allowing a duplicate START_RECORDING.
  it('shows a dedicated disabled state while START_RECORDING is in flight', () => {
    const starting: RecordingState = {
      ...recoveryState({ code: 'unused', message: 'unused' }),
      isRecording: true,
      phase: 'starting',
      runId: 'run-1',
      error: null,
      recoverableError: null,
    };
    render(<RecordControls recording={starting} />);

    expect(screen.queryByRole('button', { name: '開始錄製' })).toBeNull();
    expect(screen.getByRole('button', { name: '正在連接頁面' }).hasAttribute('disabled')).toBe(true);
  });

  it('names the snapshot preparation while a snapshot run is starting', () => {
    const starting: RecordingState = {
      ...recoveryState({ code: 'unused', message: 'unused' }),
      isRecording: true,
      phase: 'starting',
      mode: 'snapshot',
      runId: 'run-1',
      error: null,
      recoverableError: null,
    };
    render(<RecordControls recording={starting} />);

    expect(screen.queryByRole('button', { name: '開始錄製' })).toBeNull();
    expect(screen.getByRole('button', { name: '正在建立乾淨底圖' }).hasAttribute('disabled')).toBe(true);
  });
});

// @vitest-environment jsdom
import { cleanup, render as rtlRender, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { setLocale } from '@/lib/shared/i18n';

function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(ui, { wrapper: TooltipProvider });
}

vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: vi.fn() } } }));
vi.mock('@/lib/runtime/actions', () => ({ openLibrary: vi.fn(), resetSession: vi.fn() }));
vi.mock('@/lib/project/project-actions', () => ({ ensureSelectedProject: vi.fn() }));
vi.mock('@/lib/storage/project-repository', () => ({ getProject: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/recording/use-recording-session', () => ({
  useRecordingSession: () => ({
    recording: { phase: 'idle', mode: 'steps', itemCount: 0 },
    sessionId: 'project-current',
    isRecording: false,
    steps: [],
    error: null,
    recoverableError: null,
  }),
}));
vi.mock('@/components/popup/RecordControls', () => ({ default: () => null }));

import EditorHeader from '@/components/editor/EditorHeader';
import PopupApp from '@/entrypoints/popup/App';

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  setLocale('zh-TW');
});

describe('English UI', () => {
  it('renders the popup in English', () => {
    render(<PopupApp />);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Library/ })).toBeTruthy();
    // Idle, the popup only starts recordings: finishing one opens the editor, and clearing lives in the editor.
    expect(screen.queryByRole('button', { name: /Open editor/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear steps' })).toBeNull();
  });

  it('renders the editor header in English', () => {
    render(
      <EditorHeader
        operationActive
        operation="recording"
        hasSteps={false}
        sessionId="project"
        publish={{ runExport: (task) => task(), getProjectEntries: () => [] }}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Location' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Howbeam library' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Editor' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
    expect(screen.getByText('Recording')).toBeTruthy();
  });
});

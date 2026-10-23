// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendMessage: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  discardPristineProject: vi.fn(),
  getProjectSummaries: vi.fn(),
  permissionsContains: vi.fn(),
  permissionsRequest: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  storageRemove: vi.fn(),
}));

vi.mock('wxt/browser', async () => {
  const { makePopupBrowserMock } = await import('../setup/browser-mocks');
  return {
    browser: makePopupBrowserMock({
      sendMessage: mocks.sendMessage,
      tabsQuery: mocks.query,
      permissionsContains: mocks.permissionsContains,
      permissionsRequest: mocks.permissionsRequest,
      storageGet: mocks.storageGet,
      storageSet: mocks.storageSet,
      storageRemove: mocks.storageRemove,
    }),
  };
});
// Only the storage primitives are mocked; the real project-actions flow runs.
vi.mock('@/lib/storage/project-repository', () => ({
  createProject: mocks.createProject,
  getProject: mocks.getProject,
  discardPristineProject: mocks.discardPristineProject,
  getProjectSummaries: mocks.getProjectSummaries,
}));

import RecordControls from '@/components/popup/RecordControls';
import { CROSS_TAB_DECLINE_STORAGE_KEY } from '@/lib/runtime/cross-tab-recording';
import { makeRecordingState } from '../setup/recording-state';
import { TooltipProvider } from '@/components/ui/tooltip';
import { itemAt } from '../setup/item-at';

// The mode picker uses the shadcn Tooltip, which requires a TooltipProvider
// ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const ALL_URLS = { origins: ['<all_urls>'] };
const HINT_TEXT = /目前僅錄製單一分頁/;
const ENABLE_BUTTON = '啟用跨分頁錄製';

const IDLE_RECORDING = makeRecordingState();

/** Renders the idle form and waits for the mount probes to settle. */
async function renderIdleControls() {
  render(<RecordControls recording={IDLE_RECORDING} />);
  await waitFor(() => expect(mocks.permissionsContains).toHaveBeenCalled());
  await waitFor(() => expect(mocks.storageGet).toHaveBeenCalled());
}

async function clickStartAndWaitForSend(times: number) {
  fireEvent.click(screen.getByRole('button', { name: '開始錄製' }));
  await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(times));
}

beforeEach(() => {
  mocks.getProjectSummaries.mockResolvedValue([]);
  mocks.query.mockResolvedValue([{ id: 7, url: 'https://example.com' }]);
  mocks.createProject.mockResolvedValue({ id: 'project-a' });
  mocks.getProject.mockResolvedValue(undefined);
  mocks.discardPristineProject.mockResolvedValue(true);
  mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'project-a', runId: 'run-1' });
  mocks.permissionsContains.mockResolvedValue(false);
  mocks.permissionsRequest.mockResolvedValue(true);
  const stored: Record<string, unknown> = {};
  mocks.storageGet.mockImplementation(async (key: string) => ({ [key]: stored[key] }));
  mocks.storageSet.mockImplementation(async (items: Record<string, unknown>) => void Object.assign(stored, items));
  mocks.storageRemove.mockImplementation(async (key: string) => void delete stored[key]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('cross-tab permission ask at recording start', () => {
  it('asks for the grant on the first steps start, before touching the active tab', async () => {
    await renderIdleControls();
    // Only the ordering of the start-click work matters, not the mount probe.
    mocks.query.mockClear();

    await clickStartAndWaitForSend(1);

    expect(mocks.permissionsRequest).toHaveBeenCalledExactlyOnceWith(ALL_URLS);
    expect(mocks.query).toHaveBeenCalled();
    // Firefox invariant: permissions.request must be the first await of the
    // click handler, ahead of the tabs.query pre-flight.
    expect(mocks.permissionsRequest.mock.invocationCallOrder[0]).toBeLessThan(
      itemAt(mocks.query.mock.invocationCallOrder, 0),
    );
  });

  it('remembers a decline, keeps recording single-tab, and never asks again', async () => {
    mocks.permissionsRequest.mockResolvedValue(false);
    await renderIdleControls();

    await clickStartAndWaitForSend(1);

    expect(mocks.permissionsRequest).toHaveBeenCalledTimes(1);
    // The selection write for the fresh project also goes through storage.set,
    // so assert the decline record specifically rather than an only-call.
    expect(mocks.storageSet).toHaveBeenCalledWith({
      [CROSS_TAB_DECLINE_STORAGE_KEY]: {
        version: 1,
        declined: true,
        declinedAt: expect.any(Number),
      },
    });

    await clickStartAndWaitForSend(2);
    expect(mocks.permissionsRequest).toHaveBeenCalledTimes(1);
  });

  it('does not ask again in a later session once the decline flag is stored', async () => {
    mocks.storageGet.mockResolvedValue({
      [CROSS_TAB_DECLINE_STORAGE_KEY]: { version: 1, declined: true, declinedAt: 123 },
    });
    await renderIdleControls();

    await clickStartAndWaitForSend(1);
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
  });

  it('skips the ask entirely when the grant is already present', async () => {
    mocks.permissionsContains.mockResolvedValue(true);
    await renderIdleControls();

    expect(screen.queryByText(HINT_TEXT)).toBeNull();
    await clickStartAndWaitForSend(1);
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
  });

  it('never asks for the grant when starting a snapshot run', async () => {
    await renderIdleControls();

    fireEvent.click(screen.getByRole('radio', { name: '標註' }));
    expect(screen.queryByText(HINT_TEXT)).toBeNull();

    await clickStartAndWaitForSend(1);
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
  });

  it('offers an inline enable link even after a decline; a grant clears the flag and the hint', async () => {
    mocks.storageGet.mockResolvedValue({
      [CROSS_TAB_DECLINE_STORAGE_KEY]: { version: 1, declined: true, declinedAt: 123 },
    });
    await renderIdleControls();

    expect(screen.getByText(HINT_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ENABLE_BUTTON }));

    await waitFor(() => expect(screen.queryByText(HINT_TEXT)).toBeNull());
    expect(mocks.permissionsRequest).toHaveBeenCalledExactlyOnceWith(ALL_URLS);
    expect(mocks.storageRemove).toHaveBeenCalledExactlyOnceWith(CROSS_TAB_DECLINE_STORAGE_KEY);
    // The affordance is an opt-in, never a recording trigger.
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the quiet hint when the inline enable link is declined', async () => {
    mocks.permissionsRequest.mockResolvedValue(false);
    await renderIdleControls();

    fireEvent.click(screen.getByRole('button', { name: ENABLE_BUTTON }));

    await waitFor(() => expect(mocks.storageSet).toHaveBeenCalled());
    expect(screen.getByText(HINT_TEXT)).toBeTruthy();
    // The decline is remembered, so the next start proceeds without an ask.
    await clickStartAndWaitForSend(1);
    expect(mocks.permissionsRequest).toHaveBeenCalledTimes(1);
  });

  it('parks the chosen project so the permission-resumed start appends to it', async () => {
    mocks.getProjectSummaries.mockResolvedValue([
      { id: 'project-old', title: '既有教學', entryCount: 3, stepCount: 3, updatedAt: 1 },
    ]);
    mocks.getProject.mockResolvedValue({ id: 'project-old', title: '既有教學' });
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
    await renderIdleControls();
    fireEvent.keyDown(await screen.findByRole('combobox', { name: '錄到哪裡' }), { key: 'Enter' });
    const option = await screen.findByRole('option', { name: /^既有教學.*3 個步驟$/ });
    option.focus();
    fireEvent.keyDown(option, { key: 'Enter' });

    fireEvent.click(await screen.findByRole('button', { name: '接續錄製' }));
    await waitFor(() => expect(mocks.permissionsRequest).toHaveBeenCalled());

    expect(mocks.storageSet).toHaveBeenCalledWith({
      'howbeam:pending-start:v1': expect.objectContaining({ mode: 'steps', tabId: 7, projectId: 'project-old' }),
    });
  });
});

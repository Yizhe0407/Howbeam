// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  permissionsRequest: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { sendMessage: mocks.sendMessage },
    permissions: { request: mocks.permissionsRequest },
    tabs: { query: vi.fn(), get: vi.fn(), update: vi.fn() },
    windows: { update: vi.fn() },
  },
}));

import { usePermissionFlow } from '@/components/editor/use-permission-flow';

const selectedEntry = {
  kind: 'single',
  step: { id: 's1', sessionId: 'g1' },
} as never;

const preflightSuccess = {
  ok: true,
  sourceUrl: 'https://example.com/page',
  sourceOrigin: 'https://example.com',
  permissionPattern: 'https://example.com/*',
};

function renderFlow(overrides: Record<string, unknown> = {}) {
  const options = {
    sessionId: 'g1',
    operationActive: false,
    whenIdle: () => Promise.resolve(),
    flushDescriptions: vi.fn().mockResolvedValue(undefined),
    requireSelectedEntry: vi.fn(() => selectedEntry),
    setOperationError: vi.fn(),
    entryMode: () => 'steps',
    ...overrides,
  };
  const { result } = renderHook(() => usePermissionFlow(options as never));
  return { result, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.sendMessage.mockResolvedValue(preflightSuccess);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('starting a flow', () => {
  it('lets queued edits finish before it checks the source page', async () => {
    let finishQueued!: () => void;
    const queued = new Promise<void>((resolve) => { finishQueued = resolve; });
    const { result } = renderFlow({ whenIdle: () => queued });

    let started!: Promise<void>;
    act(() => { started = result.current.handleRecapture(); });
    // Held from the click, so no new edit can start meanwhile, but nothing is asked yet.
    expect(result.current.isPermissionFlowLocked()).toBe(true);
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      finishQueued();
      await started;
    });
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(result.current.preparedPermission).not.toBeNull();
  });
});

describe('confirmPreparedPermission', () => {
  it('surfaces a selection-guard failure through setOperationError instead of an unhandled rejection', async () => {
    // The guard passes during preflight (no expected id) and throws on the
    // confirm step, where the prepared entry id is re-validated.
    const requireSelectedEntry = vi.fn((expectedEntryId?: string) => {
      if (expectedEntryId !== undefined) throw new Error('找不到目前選取的步驟。');
      return selectedEntry;
    });
    const { result, options } = renderFlow({ requireSelectedEntry });

    await act(() => result.current.handleRecapture());
    expect(result.current.preparedPermission).not.toBeNull();

    // The caller voids this promise (App.tsx onConfirm), so it must resolve.
    await act(async () => {
      await expect(result.current.confirmPreparedPermission()).resolves.toBeUndefined();
    });

    expect(requireSelectedEntry).toHaveBeenCalledWith('s1');
    expect(mocks.permissionsRequest).not.toHaveBeenCalled();
    expect(options.setOperationError).toHaveBeenLastCalledWith('找不到目前選取的步驟。');
    // The failed confirm settles the flow instead of leaving it locked.
    expect(result.current.preparedPermission).toBeNull();
    expect(result.current.permissionPending).toBe(false);
  });

  it('requests the host permission when the guards pass', async () => {
    const { result, options } = renderFlow();

    await act(() => result.current.handleRecapture());
    expect(result.current.preparedPermission).not.toBeNull();

    mocks.permissionsRequest.mockResolvedValue(true);
    mocks.sendMessage.mockResolvedValue({ ok: true, runId: 'run-1', tabId: 3, reusedTab: false });
    await act(() => result.current.confirmPreparedPermission());

    expect(mocks.permissionsRequest).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'START_STEP_RECAPTURE', sessionId: 'g1' }),
    );
    expect(options.setOperationError).toHaveBeenLastCalledWith(null);
    expect(result.current.preparedPermission).toBeNull();
  });
});

describe('continuation recording mode', () => {
  function answerStartWith(sessionId: string) {
    mocks.sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === 'START_RECORDING' ? { ok: true, sessionId, runId: 'run-1' } : preflightSuccess,
    );
  }

  it.each([
    ['steps', 'snapshot'],
    ['snapshot', 'steps'],
  ] as const)('defaults to the last entry (%s) and starts in the mode the user picked (%s)', async (lastEntryMode, picked) => {
    answerStartWith('g1');
    mocks.permissionsRequest.mockResolvedValue(true);
    const { result } = renderFlow({ entryMode: () => lastEntryMode });

    await act(() => result.current.handleContinueRecording());
    expect(result.current.continuationMode).toBe(lastEntryMode);

    act(() => result.current.setContinuationMode(picked));
    await act(() => result.current.confirmPreparedPermission());

    expect(mocks.sendMessage).toHaveBeenLastCalledWith({
      type: 'START_RECORDING',
      sessionId: 'g1',
      mode: picked,
      continuation: {},
    });
  });
});

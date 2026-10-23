// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

const mocks = vi.hoisted(() => ({ resetSession: vi.fn() }));

vi.mock('@/lib/runtime/actions', () => ({ resetSession: mocks.resetSession }));

import ResetButton from '@/components/shared/ResetButton';

// ResetButton uses the shadcn Tooltip, which requires a TooltipProvider
// ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

beforeEach(() => {
  mocks.resetSession.mockReset();
  mocks.resetSession.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('ResetButton', () => {
  async function confirmReset() {
    fireEvent.click(screen.getByRole('button', { name: '清空步驟' }));
    const dialog = await screen.findByRole('dialog', { name: '清空所有步驟？' });
    const confirmButton = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === '清空步驟');
    if (!confirmButton) throw new Error('找不到確認清空按鈕');
    fireEvent.click(confirmButton);
  }

  it('awaits the reset completion callback before leaving the pending state', async () => {
    let finishRefresh: (() => void) | undefined;
    const onReset = vi.fn(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));

    render(<ResetButton hasSteps sessionId="project-1" onReset={onReset} />);
    await confirmReset();

    await waitFor(() => expect(mocks.resetSession).toHaveBeenCalledWith('project-1'));
    expect(onReset).toHaveBeenCalledOnce();
    // The pending label shows once the reset proves slow.
    expect((await screen.findByRole('button', { name: '處理中' })).hasAttribute('disabled')).toBe(true);

    finishRefresh?.();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '清空所有步驟？' })).toBeNull());
  });

  it('does not refresh when the reset fails and exposes a recoverable error', async () => {
    mocks.resetSession.mockRejectedValueOnce(new Error('failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onReset = vi.fn();

    render(<ResetButton hasSteps sessionId="project-1" onReset={onReset} />);
    await confirmReset();

    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('清空失敗'));
    expect(onReset).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '清空所有步驟？' })).toBeTruthy();
    consoleError.mockRestore();
  });
});

describe('ResetButton dialog target', () => {
  it('names the project in the confirmation when given its title', async () => {
    render(<ResetButton hasSteps sessionId="project-1" projectTitle="安全教學" />);
    fireEvent.click(screen.getByRole('button', { name: '清空步驟' }));
    expect(await screen.findByRole('dialog', { name: '清空「安全教學」的所有步驟？' })).toBeTruthy();
  });
});

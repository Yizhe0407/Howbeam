// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditableTitle from '@/components/shared/EditableTitle';

afterEach(cleanup);

const LONG = '新進員工到職第一天要完成的帳號申請、權限設定與內部系統登入完整操作教學';

function renderTitle(props: Partial<Parameters<typeof EditableTitle>[0]> = {}) {
  const onCommit = vi.fn().mockResolvedValue(undefined);
  render(<EditableTitle value={LONG} onCommit={onCommit} fallback="未命名專案" label="專案名稱" maxLength={80} {...props} />);
  return { onCommit };
}

describe('EditableTitle', () => {
  it('shows the whole title as wrapping text, not a one-line field that cuts it off', () => {
    renderTitle();
    expect(screen.getByText(LONG).closest('button')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps a clamped title readable in full from its tooltip', () => {
    renderTitle({ clamp: true });
    const text = screen.getByText(LONG);
    expect(text.className).toContain('line-clamp-2');
    expect(text.closest('button')?.getAttribute('title')).toBe(LONG);
  });

  it('turns into a focused field on click and commits the edit on Enter', async () => {
    const { onCommit } = renderTitle();
    fireEvent.click(screen.getByText(LONG));
    const field = screen.getByRole('textbox', { name: '專案名稱' });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: '入職\n教學' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('入職 教學'));
  });

  it('shows the fallback for an unnamed project and does not commit it untouched', () => {
    const { onCommit } = renderTitle({ value: '' });
    fireEvent.click(screen.getByText('未命名專案'));
    fireEvent.blur(screen.getByRole('textbox', { name: '專案名稱' }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('未命名專案')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SectionTitleDialog, { type SectionDialogRequest } from '@/components/editor/SectionTitleDialog';

const ADD: SectionDialogRequest = { kind: 'add', startEntryId: 'entry-3', step: 3 };
const RENAME: SectionDialogRequest = { kind: 'rename', sectionId: 'section-1', title: '準備' };

function renderDialog(request: SectionDialogRequest | null, onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn();
  const view = render(<SectionTitleDialog request={request} onClose={onClose} onSubmit={onSubmit} />);
  return { ...view, onClose, onSubmit };
}

function field(): HTMLInputElement {
  return screen.getByRole('textbox', { name: '章節名稱' }) as HTMLInputElement;
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

afterEach(cleanup);

describe('SectionTitleDialog', () => {
  it('stays closed without a request', () => {
    renderDialog(null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says where a new section starts and focuses the name field', () => {
    renderDialog(ADD);

    expect(screen.getByRole('dialog', { name: '新增章節' })).toBeTruthy();
    expect(screen.getByText('從第 3 步開始新章節')).toBeTruthy();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe('');
    expect(button('建立').disabled).toBe(true);
  });

  it('creates the section with the name cleaned the way storage keeps it', async () => {
    const { onSubmit } = renderDialog(ADD);

    fireEvent.change(field(), { target: { value: '  條目頁面\t  ' } });
    expect(button('建立').disabled).toBe(false);
    fireEvent.submit(field().closest('form')!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(ADD, '條目頁面'));
  });

  it('keeps a blank name from being created', () => {
    const { onSubmit } = renderDialog(ADD);

    fireEvent.change(field(), { target: { value: '   ' } });
    expect(button('建立').disabled).toBe(true);
    fireEvent.submit(field().closest('form')!);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renames from the current name and only saves a real change', async () => {
    const { onSubmit } = renderDialog(RENAME);

    expect(screen.getByRole('dialog', { name: '重新命名章節' })).toBeTruthy();
    expect(field().value).toBe('準備');
    expect(button('儲存').disabled).toBe(true);

    fireEvent.change(field(), { target: { value: '前置作業' } });
    fireEvent.click(button('儲存'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(RENAME, '前置作業'));
  });

  it('stays open with the typed name and a reason when saving fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('conflict'));
    const { onClose } = renderDialog(ADD, onSubmit);

    fireEvent.change(field(), { target: { value: '條目頁面' } });
    fireEvent.click(button('建立'));

    expect(await screen.findByText('新增章節失敗，已重新載入目前資料。')).toBeTruthy();
    expect(field().value).toBe('條目頁面');
    expect(field().disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cannot be dismissed while saving', async () => {
    let finish: (() => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const { onClose } = renderDialog(ADD, onSubmit);

    fireEvent.change(field(), { target: { value: '條目頁面' } });
    fireEvent.click(button('建立'));
    await waitFor(() => expect(field().disabled).toBe(true));

    expect(button('取消').disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    finish?.();
  });

  it('cancels with the button or Escape', () => {
    const { onClose } = renderDialog(ADD);

    fireEvent.click(button('取消'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('starts fresh for every request', () => {
    const { rerender } = renderDialog(RENAME);
    fireEvent.change(field(), { target: { value: '沒存的草稿' } });

    rerender(<SectionTitleDialog request={ADD} onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(field().value).toBe('');
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectSectionHeading, {
  SectionTitleForm,
  type ProjectSectionHeadingProps,
} from '@/components/editor/ProjectSectionHeading';

function createProps(overrides: Partial<ProjectSectionHeadingProps> = {}): ProjectSectionHeadingProps {
  return {
    section: {
      id: 'section-1',
      title: '開始使用',
      startEntryId: 'entry-1',
    },
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

function openMenu() {
  fireEvent.click(button('章節操作'));
}

afterEach(() => {
  cleanup();
});

describe('ProjectSectionHeading', () => {
  it('以一行可存取的二級標題顯示章節，操作收在選單裡', () => {
    render(<ProjectSectionHeading {...createProps()} />);

    expect(screen.getByRole('region', { name: '章節：開始使用' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '開始使用', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新命名' })).toBeNull();

    openMenu();
    expect(button('重新命名')).toBeTruthy();
    expect(button('刪除章節')).toBeTruthy();
  });

  it('從選單重新命名，以 Enter 儲存去除空白後、最多 200 字的名稱', async () => {
    const onRename = vi.fn();
    render(<ProjectSectionHeading {...createProps({ onRename })} />);

    openMenu();
    fireEvent.click(button('重新命名'));
    const input = screen.getByRole('textbox', { name: '章節名稱' });
    expect((input as HTMLInputElement).value).toBe('開始使用');
    fireEvent.change(input, { target: { value: `  ${'新'.repeat(205)}  ` } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('section-1', '新'.repeat(200)));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '章節名稱' })).toBeNull());
  });

  it('以 Escape 取消重新命名且不呼叫 callback', () => {
    const onRename = vi.fn();
    render(<ProjectSectionHeading {...createProps({ onRename })} />);

    openMenu();
    fireEvent.click(button('重新命名'));
    const input = screen.getByRole('textbox', { name: '章節名稱' });
    fireEvent.change(input, { target: { value: '不應儲存' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '開始使用', level: 2 })).toBeTruthy();
  });

  it('重新命名失敗時保留輸入框與已輸入的名稱', async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('conflict'));
    render(<ProjectSectionHeading {...createProps({ onRename })} />);

    openMenu();
    fireEvent.click(button('重新命名'));
    const input = screen.getByRole('textbox', { name: '章節名稱' });
    fireEvent.change(input, { target: { value: '新名稱' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onRename).toHaveBeenCalledOnce());
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByRole('textbox', { name: '章節名稱' }) as HTMLInputElement).value).toBe('新名稱');
  });

  it('從選單直接把刪除交給 callback，不使用元件內確認流程', async () => {
    const onDelete = vi.fn();
    render(<ProjectSectionHeading {...createProps({ onDelete })} />);

    openMenu();
    fireEvent.click(button('刪除章節'));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('section-1'));
  });

  it('在外部 disabled 與刪除進行中停用選單，避免重複送出', async () => {
    let resolveDelete: (() => void) | undefined;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));
    const { rerender } = render(<ProjectSectionHeading {...createProps({ onDelete })} />);

    openMenu();
    fireEvent.click(button('刪除章節'));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(button('章節操作').disabled).toBe(true);

    resolveDelete?.();
    await waitFor(() => expect(button('章節操作').disabled).toBe(false));

    rerender(<ProjectSectionHeading {...createProps({ disabled: true })} />);
    expect(button('章節操作').disabled).toBe(true);
  });
});

describe('SectionTitleForm', () => {
  function renderForm(overrides: Partial<React.ComponentProps<typeof SectionTitleForm>> = {}) {
    const props = { onSubmit: vi.fn(), onCancel: vi.fn(), ...overrides };
    render(<SectionTitleForm {...props} />);
    return { ...props, input: screen.getByRole('textbox', { name: '章節名稱' }) as HTMLInputElement };
  }

  it('自動聚焦，並以 Enter 送出整理後的名稱', async () => {
    const { input, onSubmit } = renderForm();
    expect(document.activeElement).toBe(input);
    expect(screen.getByText('Enter 確認 · Esc 取消')).toBeTruthy();

    fireEvent.change(input, { target: { value: '  條目頁面  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('條目頁面'));
  });

  it('空白名稱按 Enter 時提示錯誤而不送出', () => {
    const { input, onSubmit } = renderForm();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('章節名稱不可為空白');
  });

  it('空白時離開欄位等於取消；有名稱時離開欄位就送出', async () => {
    const empty = renderForm();
    fireEvent.blur(empty.input);
    expect(empty.onCancel).toHaveBeenCalledOnce();
    expect(empty.onSubmit).not.toHaveBeenCalled();
    cleanup();

    const named = renderForm();
    fireEvent.change(named.input, { target: { value: '查看紀錄' } });
    fireEvent.blur(named.input);
    await waitFor(() => expect(named.onSubmit).toHaveBeenCalledWith('查看紀錄'));
  });

  it('Escape 只取消一次，之後的 blur 不再送出或取消', () => {
    const { input, onSubmit, onCancel } = renderForm();
    fireEvent.change(input, { target: { value: '不要' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('IME 組字中的 Enter 不會送出', () => {
    const { input, onSubmit } = renderForm();
    fireEvent.change(input, { target: { value: 'ㄓㄤ' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

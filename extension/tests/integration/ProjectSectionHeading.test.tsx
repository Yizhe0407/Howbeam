// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectSectionHeading, {
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

  it('從選單重新命名時只請求開啟對話框', () => {
    const onRename = vi.fn();
    render(<ProjectSectionHeading {...createProps({ onRename })} />);

    openMenu();
    fireEvent.click(button('重新命名'));

    expect(onRename).toHaveBeenCalledWith('section-1');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('heading', { name: '開始使用', level: 2 })).toBeTruthy();
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

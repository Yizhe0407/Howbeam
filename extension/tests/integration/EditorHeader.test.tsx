// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Step } from '@/lib/storage/models';
import { TooltipProvider } from '@/components/ui/tooltip';

// EditorHeader's buttons use the shadcn Tooltip, which requires a
// TooltipProvider ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const mocks = vi.hoisted(() => ({ navigateInPlace: vi.fn(), resetSession: vi.fn() }));

vi.mock('@/lib/runtime/actions', () => ({ resetSession: mocks.resetSession }));
vi.mock('@/lib/runtime/page-navigation', () => ({ navigateInPlace: mocks.navigateInPlace }));

import EditorHeader from '@/components/editor/EditorHeader';

const steps = [{ id: 'step-1' }] as Step[];

function renderHeader(overrides: Partial<React.ComponentProps<typeof EditorHeader>> = {}) {
  return render(
    <EditorHeader
      operationActive={false}
      steps={steps}
      sessionId="project-1"
      projectTitle="新增成員"
      onOpenPublish={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resetSession.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('EditorHeader', () => {
  // Regression: used to render every action twice (icon-only below `sm`, labelled from `sm` up).
  it('offers exactly one control per action', () => {
    renderHeader();

    expect(screen.getAllByRole('button', { name: 'Howbeam 專案庫' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '設定' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '匯出' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '重置目前錄製' })).toHaveLength(1);
  });

  it('keeps the accessible name complete while the visible label collapses below sm', () => {
    renderHeader();

    const button = screen.getByRole('button', { name: '匯出' });
    // The icon is always rendered; only the text label is width-dependent, so
    // the name has to come from `aria-label` rather than the hidden span.
    expect(button.querySelector('svg')).toBeTruthy();
    expect(button.getAttribute('aria-label')).toBe('匯出');
    expect(within(button).getByText('匯出').className).toContain('hidden sm:inline');
  });

  it('places the project in the breadcrumb as the page heading', () => {
    renderHeader();

    const breadcrumb = screen.getByRole('navigation', { name: '目前位置' });
    const heading = within(breadcrumb).getByRole('heading', { level: 1, name: '新增成員' });
    expect(heading.id).toBe('howbeam-editor-title');
    expect(heading.closest('li')?.getAttribute('aria-current')).toBe('page');
  });

  it('names the location even before the project loads, and for an untitled project', () => {
    renderHeader({ projectTitle: null });
    expect(screen.getByRole('heading', { level: 1, name: '編輯器' })).toBeTruthy();
    cleanup();
    renderHeader({ projectTitle: '  ' });
    expect(screen.getByRole('heading', { level: 1, name: '未命名專案' })).toBeTruthy();
  });

  it('returns to the library in the same tab from the Howbeam crumb', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Howbeam 專案庫' }));

    await waitFor(() => expect(mocks.navigateInPlace).toHaveBeenCalledWith('library'));
  });

  it('opens settings in the same tab from the gear', async () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: '設定' }));

    await waitFor(() => expect(mocks.navigateInPlace).toHaveBeenCalledWith('options'));
  });

  it('saves descriptions before leaving, and stays when they cannot be saved', async () => {
    const beforeNavigate = vi.fn().mockResolvedValue(false);
    renderHeader({ beforeNavigate });

    fireEvent.click(screen.getByRole('button', { name: 'Howbeam 專案庫' }));

    await waitFor(() => expect(beforeNavigate).toHaveBeenCalledOnce());
    expect(mocks.navigateInPlace).not.toHaveBeenCalled();

    beforeNavigate.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    await waitFor(() => expect(mocks.navigateInPlace).toHaveBeenCalledWith('options'));
  });

  it.each<[string, Partial<React.ComponentProps<typeof EditorHeader>>]>([
    ['an operation is running', { operationActive: true }],
    ['editing is disabled', { editingDisabled: true }],
    ['the project has no steps', { steps: [] }],
    ['no publish handler is wired', { onOpenPublish: undefined }],
  ])('disables 匯出 when %s', (_label, overrides) => {
    renderHeader(overrides);

    expect((screen.getByRole('button', { name: '匯出' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables 匯出 once there is something to export', () => {
    renderHeader();

    expect((screen.getByRole('button', { name: '匯出' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

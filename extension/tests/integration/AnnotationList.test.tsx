// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Step } from '@/lib/storage/models';
import { TooltipProvider } from '@/components/ui/tooltip';
import { t } from '@/lib/shared/i18n';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

// AnnotationList's delete button uses the shadcn Tooltip, which requires a
// TooltipProvider ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

vi.mock('@/lib/editor/editor-autosave', () => ({
  useStepDescriptionAutosave: (step: Step) => ({
    description: step.description,
    setDescription: vi.fn(),
    recoveries: [],
    restoreRecovery: vi.fn(),
    discardRecovery: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    confirmOverwrite: vi.fn().mockResolvedValue(undefined),
  }),
}));

import AnnotationList from '@/components/editor/AnnotationList';

function makeAnnotation(): Step {
  return {
    id: 'annotation-1',
    sessionId: 'session-1',
    order: 0,
    bounds: { x: 10, y: 10, width: 20, height: 20 },
    devicePixelRatio: 1,
    description: '標註內容',
    url: 'https://example.com/',
    timestamp: 1,
    groupId: 'snapshot-1',
  };
}

afterEach(cleanup);

describe('AnnotationList', () => {
  it('不在已儲存的標註說明下方顯示打勾圖示或已儲存文字', () => {
    const { container } = render(
      <AnnotationList
        annotations={[makeAnnotation()]}
        onChange={vi.fn()}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText('標註 1 說明')).toBeTruthy();
    expect(screen.queryByText('已儲存')).toBeNull();
    expect(container.querySelector('.lucide-check')).toBeNull();
  });

  it('says a snapshot has no markers yet', () => {
    render(<AnnotationList annotations={[]} onChange={vi.fn()} onDelete={vi.fn()} onReorder={vi.fn()} />);

    expect(screen.getByText(t().editor.annotations.empty)).toBeTruthy();
  });

  it('reports a failed delete and retries it from the notice', async () => {
    silenceIntentionalErrorLogs();
    const onDelete = vi.fn().mockRejectedValueOnce('locked').mockResolvedValueOnce(undefined);
    render(<AnnotationList annotations={[makeAnnotation()]} onChange={vi.fn()} onDelete={onDelete} onReorder={vi.fn()} />);

    fireEvent.click(screen.getByLabelText(t().editor.annotations.delete(1)));
    fireEvent.click(await screen.findByText(t().editor.annotations.retryDelete));

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(t().editor.annotations.deleteFailed)).toBeNull());
  });

  it('switches numbering, and locks it while editing is disabled', () => {
    const onSetNumbered = vi.fn();
    const { rerender } = render(
      <AnnotationList annotations={[makeAnnotation()]} onSetNumbered={onSetNumbered} onChange={vi.fn()} onDelete={vi.fn()} onReorder={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('switch'));
    expect(onSetNumbered).toHaveBeenCalledWith(true);

    rerender(
      <AnnotationList annotations={[makeAnnotation()]} onSetNumbered={onSetNumbered} editingDisabled onChange={vi.fn()} onDelete={vi.fn()} onReorder={vi.fn()} />,
    );
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(t().editor.annotations.delete(1)) as HTMLButtonElement).disabled).toBe(true);
  });
});

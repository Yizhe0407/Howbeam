// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { StepEntry } from '@/lib/storage/models';
import { t } from '@/lib/shared/i18n';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';

const composite = vi.hoisted(() => ({ compositeStepEntry: vi.fn() }));
vi.mock('@/lib/export/entry-render', () => composite);

import StepActions from '@/components/editor/StepActions';

function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(ui, { wrapper: TooltipProvider });
}

function entry(overrides: Record<string, unknown> = {}): StepEntry {
  return {
    kind: 'single',
    step: {
      id: 'step-1',
      sessionId: 'project-a',
      order: 0,
      screenshotBlob: new Blob(['image']),
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      devicePixelRatio: 1,
      description: '',
      url: 'https://example.com',
      timestamp: 1,
      ...overrides,
    },
  } as StepEntry;
}

const clipboardWrite = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  composite.compositeStepEntry.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  clipboardWrite.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: clipboardWrite } });
  vi.stubGlobal('ClipboardItem', class {
    constructor(readonly items: Record<string, Blob>) {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepActions', () => {
  it('copies the annotated image as PNG', async () => {
    render(<StepActions entry={entry()} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByLabelText(t().editor.actions.copyImage));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(composite.compositeStepEntry).toHaveBeenCalledWith(entry(), 'image/png');
  });

  it('will not copy an image whose masks wait for review', () => {
    render(<StepActions entry={entry({ redactionReviewRequired: true })} onDelete={vi.fn()} />);

    expect((screen.getByLabelText(t().editor.actions.copyImage) as HTMLButtonElement).disabled).toBe(true);
  });

  it('falls back to the copy failure notice when the clipboard gives no reason', async () => {
    silenceIntentionalErrorLogs();
    clipboardWrite.mockRejectedValue('denied');
    render(<StepActions entry={entry()} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByLabelText(t().editor.actions.copyImage));

    expect(await screen.findByText(t().editor.actions.copyFailed)).toBeTruthy();
  });

  it('reports a failed delete and keeps the button usable', async () => {
    silenceIntentionalErrorLogs();
    const onDelete = vi.fn().mockRejectedValue(new Error('The step changed meanwhile.'));
    render(<StepActions entry={entry()} onDelete={onDelete} />);
    const remove = screen.getByLabelText(t().editor.actions.deleteStep) as HTMLButtonElement;

    fireEvent.click(remove);

    expect(await screen.findByText('The step changed meanwhile.')).toBeTruthy();
    expect(remove.disabled).toBe(false);
  });

  it('starts a retake, and holds it back while a reason forbids one', async () => {
    const onRecapture = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<StepActions entry={entry()} onDelete={vi.fn()} onRecapture={onRecapture} />);

    fireEvent.click(screen.getByLabelText(t().editor.actions.recapture));
    await waitFor(() => expect(onRecapture).toHaveBeenCalledTimes(1));

    rerender(<StepActions entry={entry()} onDelete={vi.fn()} onRecapture={onRecapture} recaptureDisabledReason="busy" />);
    expect((screen.getByLabelText(t().editor.actions.recapture) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables every action while operations are blocked', () => {
    render(<StepActions entry={entry()} onDelete={vi.fn()} onRecapture={vi.fn()} operationsDisabled />);

    for (const label of [t().editor.actions.copyImage, t().editor.actions.recapture, t().editor.actions.deleteStep]) {
      expect((screen.getByLabelText(label) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

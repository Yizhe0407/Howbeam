// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepEntry } from '@/lib/storage/models';
import { t } from '@/lib/shared/i18n';

vi.mock('@/components/editor/EntryThumbnail', () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

import Lightbox from '@/components/editor/Lightbox';

function entry(id: string, reviewRequired = false): StepEntry {
  return {
    kind: 'single',
    step: {
      id,
      sessionId: 'project-a',
      order: 0,
      screenshotBlob: new Blob(['image']),
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      devicePixelRatio: 1,
      description: '',
      url: 'https://example.com',
      timestamp: 1,
      ...(reviewRequired ? { redactionReviewRequired: true } : {}),
    },
  } as StepEntry;
}

const entries = [entry('a'), entry('b'), entry('c')];

afterEach(cleanup);

describe('Lightbox', () => {
  it('shows nothing while closed', () => {
    render(<Lightbox entries={entries} index={null} onClose={vi.fn()} onNavigate={vi.fn()} />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves with the arrow keys and closes on Escape', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<Lightbox entries={entries} index={1} onClose={onClose} onNavigate={onNavigate} />);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onNavigate.mock.calls).toEqual([[entries[2]], [entries[0]]]);
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('stops at the first and the last entry', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<Lightbox entries={entries} index={0} onClose={vi.fn()} onNavigate={onNavigate} />);

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect((screen.getByLabelText(t().editor.lightbox.previous) as HTMLButtonElement).disabled).toBe(true);

    rerender(<Lightbox entries={entries} index={2} onClose={vi.fn()} onNavigate={onNavigate} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect((screen.getByLabelText(t().editor.lightbox.next) as HTMLButtonElement).disabled).toBe(true);

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('says the image is hidden while its masks wait for review', () => {
    render(<Lightbox entries={[entry('a', true)]} index={0} onClose={vi.fn()} onNavigate={vi.fn()} />);

    expect(screen.getByRole('alert').textContent).toBe(t().editor.privacyReviewRequiredHidden);
  });
});

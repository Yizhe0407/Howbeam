// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProjectSummaries: vi.fn(),
  getAllSeries: vi.fn(),
  listeners: new Set<() => void>(),
}));

vi.mock('@/lib/storage/project-repository', () => ({ getProjectSummaries: mocks.getProjectSummaries }));
vi.mock('@/lib/storage/series-repository', () => ({ getAllSeries: mocks.getAllSeries }));
vi.mock('@/lib/storage/change-notifier', () => ({
  subscribeProjectsChanged: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
  subscribeSeriesChanged: () => () => undefined,
}));

import RecordTargetPicker from '@/components/popup/RecordTargetPicker';
import { TooltipProvider } from '@/components/ui/tooltip';

const summary = (id: string, title: string) => ({ id, title, entryCount: 1, stepCount: 1, updatedAt: 1 });

beforeEach(() => {
  mocks.listeners.clear();
  mocks.getProjectSummaries.mockReset().mockResolvedValue([summary('a', '專案 A'), summary('b', '專案 B')]);
  mocks.getAllSeries.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

describe('RecordTargetPicker', () => {
  it('keeps a still-existing selection', async () => {
    const onChange = vi.fn();
    render(<RecordTargetPicker value="a" onChange={onChange} />, { wrapper: TooltipProvider });
    await screen.findByRole('combobox', { name: '錄到哪裡' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('falls back to 新專案 when the selected project is deleted while open', async () => {
    const onChange = vi.fn();
    render(<RecordTargetPicker value="a" onChange={onChange} />, { wrapper: TooltipProvider });
    await screen.findByRole('combobox', { name: '錄到哪裡' });

    mocks.getProjectSummaries.mockResolvedValue([summary('b', '專案 B')]);
    act(() => mocks.listeners.forEach((listener) => listener()));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = render(<RecordTargetPicker value={null} onChange={vi.fn()} />, { wrapper: TooltipProvider });
    await screen.findByRole('combobox', { name: '錄到哪裡' });
    unmount();
    expect(mocks.listeners.size).toBe(0);
  });
});

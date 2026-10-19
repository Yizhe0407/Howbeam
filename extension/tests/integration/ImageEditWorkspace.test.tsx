// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ImageEdit } from '@/lib/storage/image-edit-model';
import { IMAGE_ITEM_LIMITS } from '@/lib/editor/image-edit-items';
import type { ScreenshotStep, StepEntry } from '@/lib/storage/models';
import { StepImageEditConflictError } from '@/lib/storage/step-repository';

const storage = vi.hoisted(() => ({
  save: vi.fn(),
  isStale: vi.fn(),
  loadLatest: vi.fn(),
  listeners: [] as Array<() => void>,
}));

vi.mock('@/lib/editor/save-entry-image-edits', () => ({
  saveEntryImageEdits: storage.save,
  isEntryImageStale: storage.isStale,
  loadLatestEntry: storage.loadLatest,
}));
vi.mock('@/lib/storage/change-notifier', () => ({
  subscribeProjectsChanged: (listener: () => void) => {
    storage.listeners.push(listener);
    return () => { storage.listeners = storage.listeners.filter((candidate) => candidate !== listener); };
  },
}));
vi.mock('@/lib/editor/use-image-css-size', () => ({ useImageCssSize: () => ({ width: 400, height: 200 }) }));
vi.mock('@/components/editor/EntryThumbnail', () => ({
  default: ({ overlay }: { overlay?: ReactNode }) => <div data-testid="image">{overlay}</div>,
}));

import ImageEditWorkspace from '@/components/editor/ImageEditWorkspace';

beforeAll(() => {
  // jsdom has no layout: 1 CSS px of image == 1 client px.
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.setPointerCapture = () => undefined;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
});

beforeEach(() => {
  storage.save.mockReset();
  storage.isStale.mockReset();
  storage.loadLatest.mockReset();
  storage.listeners = [];
});
afterEach(cleanup);

function entry(changes: Partial<ScreenshotStep> = {}): StepEntry {
  return {
    kind: 'single',
    step: {
      id: 'step-1',
      sessionId: 'session-1',
      order: 0,
      bounds: null,
      devicePixelRatio: 1,
      description: '',
      url: 'https://example.test',
      timestamp: 0,
      screenshotBlob: new Blob(['image']),
      ...changes,
    } as ScreenshotStep,
  };
}

const mask = (id: string) => ({ id, kind: 'solid' as const, bounds: { x: 100, y: 50, width: 80, height: 40 } });
const box = (id: string): ImageEdit => ({ id, kind: 'rect', bounds: { x: 5, y: 5, width: 30, height: 30 }, width: 2, color: '#ff4747', fill: 'none' });

function open(opened: StepEntry) {
  const onClose = vi.fn();
  render(<ImageEditWorkspace entry={opened} number={1} onClose={onClose} />, { wrapper: TooltipProvider });
  return { onClose };
}

const toolButton = (name: string) =>
  within(screen.getByRole('toolbar', { name: '圖片編輯工具' })).getByRole('button', { name }) as HTMLButtonElement;
const layer = () => document.querySelector('[data-howbeam-image-edit-layer]') as HTMLElement;
const editItem = (id: string) => document.querySelector(`[data-howbeam-edit-item="${id}"]`);

function drawMask() {
  fireEvent.click(toolButton('遮罩'));
  fireEvent.pointerDown(layer(), { clientX: 10, clientY: 10, button: 0 });
  fireEvent.pointerMove(layer(), { clientX: 60, clientY: 40 });
  fireEvent.pointerUp(layer(), { clientX: 60, clientY: 40 });
}

describe('ImageEditWorkspace and other tabs', () => {
  it('refuses to save over masks another tab saved, shows them and says so', async () => {
    const theirs = entry({ redactions: [mask('their-mask')], imageEditRevision: 1 });
    storage.save.mockRejectedValueOnce(new StepImageEditConflictError('step-1', 0, 1));
    storage.loadLatest.mockResolvedValue(theirs);
    const { onClose } = open(entry());

    drawMask();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));

    expect(await screen.findByText(/另一個分頁剛修改了這張圖片/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(editItem('their-mask')).toBeTruthy();
    expect(storage.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), { imageEditRevision: 0, confirmReview: false });

    // The next save builds on what the other tab stored.
    storage.save.mockResolvedValue(2);
    drawMask();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [, saved, base] = storage.save.mock.calls.at(-1)!;
    expect(base).toEqual({ imageEditRevision: 1, confirmReview: false });
    expect(saved.redactions.map((redaction: { id: string }) => redaction.id)).toContain('their-mask');
  });

  it('picks up edits another tab saved while nothing here is unsaved', async () => {
    storage.isStale.mockResolvedValue(true);
    storage.loadLatest.mockResolvedValue(entry({ redactions: [mask('their-mask')], imageEditRevision: 3 }));
    open(entry());

    await act(async () => { storage.listeners.forEach((listener) => listener()); });

    expect(await screen.findByText('已載入另一個分頁儲存的最新圖片編輯。')).toBeTruthy();
    expect(editItem('their-mask')).toBeTruthy();
  });
});

describe('ImageEditWorkspace mask review', () => {
  it('confirms pending masks with Done, and only with Done', async () => {
    storage.save.mockResolvedValue(1);
    const pending = entry({ redactions: [mask('kept')], redactionReviewRequired: true });

    const escaped = open(pending);
    expect(screen.getByText(/這張圖片的遮罩需要重新確認/)).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(escaped.onClose).toHaveBeenCalled());
    expect(storage.save).not.toHaveBeenCalled();
    cleanup();

    const confirmed = open(pending);
    fireEvent.click(screen.getByRole('button', { name: '確認遮罩' }));
    await waitFor(() => expect(confirmed.onClose).toHaveBeenCalled());
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.save.mock.calls[0][2]).toEqual({ imageEditRevision: 0, confirmReview: true });
  });
});

describe('ImageEditWorkspace limits', () => {
  it('stops adding drawings at the storage limit and says why', () => {
    const full = Array.from({ length: IMAGE_ITEM_LIMITS.maxEdits }, (_, index) => box(`box-${index}`));
    open(entry({ imageEdits: full }));

    expect(screen.getByText(`已達每張圖片 ${IMAGE_ITEM_LIMITS.maxEdits} 個編輯項目的上限，請先刪除部分項目再新增。`)).toBeTruthy();
    expect((toolButton('外框')).disabled).toBe(true);
    // Masks have their own limit, so they can still be added.
    expect((toolButton('遮罩')).disabled).toBe(false);
  });

  it('stops adding masks at the storage limit', () => {
    const masks = Array.from({ length: IMAGE_ITEM_LIMITS.maxMasks }, (_, index) => mask(`mask-${index}`));
    open(entry({ redactions: masks }));

    expect(screen.getByText(`已達每張圖片 ${IMAGE_ITEM_LIMITS.maxMasks} 個遮罩的上限，請先刪除部分遮罩再新增。`)).toBeTruthy();
    expect((toolButton('遮罩')).disabled).toBe(true);
    fireEvent.keyDown(layer(), { key: 'm' });
    expect(toolButton('遮罩').getAttribute('aria-pressed')).toBe('false');
  });
});

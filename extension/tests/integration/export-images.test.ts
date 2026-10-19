import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  download: vi.fn(),
  composite: vi.fn(async () => {
    mocks.active++;
    mocks.maxActive = Math.max(mocks.maxActive, mocks.active);
    await Promise.resolve();
    mocks.active--;
    return new Blob(['annotated'], { type: 'image/jpeg' });
  }),
}));

vi.mock('wxt/browser', () => ({ browser: { downloads: { download: mocks.download } } }));
vi.mock('@/lib/export/entry-render', () => ({
  compositeStepEntry: mocks.composite,
}));

import {
  IMAGE_ZIP_EXPORT_LIMITS,
  ImageZipExportLimitError,
  RedactionReviewRequiredError,
  exportImagesAsZip,
  localDateStamp,
} from '@/lib/export/export-images';
import { type Step } from '@/lib/storage/models';

function step(order: number): Step {
  return {
    id: String(order),
    sessionId: 'session',
    order,
    screenshotBlob: new Blob([`image-${order}`], { type: 'image/jpeg' }),
    bounds: null,
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: order,
  };
}

it('keeps the persisted-limit-derived ZIP export budgets at their established values', () => {
  expect(IMAGE_ZIP_EXPORT_LIMITS).toEqual({
    maxEntries: 2_000,
    maxImageBytes: 16 * 1024 * 1024,
    maxTotalImageBytes: 128 * 1024 * 1024,
  });
});

beforeEach(() => {
  mocks.active = 0;
  mocks.maxActive = 0;
  mocks.download.mockReset().mockResolvedValue(1);
  mocks.composite.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('image export', () => {
  it('formats the filename date in local calendar time', () => {
    expect(localDateStamp(new Date(2026, 0, 2, 0, 5))).toBe('2026-01-02');
  });

  it('composites sequentially and always releases the object URL', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:archive');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const result = await exportImagesAsZip([step(0), step(1), step(2)]);

    expect(mocks.composite).toHaveBeenCalledTimes(3);
    expect(mocks.composite).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'single' }), 'image/jpeg');
    expect(mocks.maxActive).toBe(1);
    expect(mocks.download).toHaveBeenCalledWith({
      url: 'blob:archive',
      filename: expect.stringMatching(/^howbeam-images-\d{4}-\d{2}-\d{2}\.zip$/),
      saveAs: true,
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:archive');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(result).toEqual({
      filename: expect.stringMatching(/^howbeam-images-\d{4}-\d{2}-\d{2}\.zip$/),
      itemCount: 3,
    });
  });

  it('releases the object URL when starting the download fails', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:archive');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    mocks.download.mockRejectedValue(new Error('download failed'));

    await expect(exportImagesAsZip([step(0)])).rejects.toThrow('download failed');

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:archive');
  });

  it('stops between image composites when the export is cancelled', async () => {
    const controller = new AbortController();
    mocks.composite.mockImplementationOnce(async () => {
      controller.abort();
      return new Blob(['cancelled']);
    });

    await expect(exportImagesAsZip([step(0), step(1)], undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(mocks.composite).toHaveBeenCalledTimes(1);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('refuses export while any screenshot owner needs privacy review', async () => {
    const pending = step(0);
    pending.redactions = [{ id: 'mask', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 4 } }];
    pending.redactionReviewRequired = true;

    await expect(exportImagesAsZip([step(1), pending])).rejects.toMatchObject({
      name: 'RedactionReviewRequiredError',
      ordinals: [2],
    });
    await expect(exportImagesAsZip([pending])).rejects.toBeInstanceOf(RedactionReviewRequiredError);
    expect(mocks.composite).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });


  it('resolves null without downloading when no entry can be exported', async () => {
    await expect(exportImagesAsZip([])).resolves.toBeNull();
    await expect(exportImagesAsZip([{ ...step(0), screenshotBlob: undefined }])).resolves.toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('rejects an excessive image count before compositing or creating a download', async () => {
    const steps = Array.from({ length: IMAGE_ZIP_EXPORT_LIMITS.maxEntries + 1 }, (_, index) => step(index));

    await expect(exportImagesAsZip(steps)).rejects.toBeInstanceOf(ImageZipExportLimitError);
    expect(mocks.composite).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('rejects an oversized composited image before allocating its ArrayBuffer', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    mocks.composite.mockResolvedValueOnce({
      size: IMAGE_ZIP_EXPORT_LIMITS.maxImageBytes + 1,
      arrayBuffer,
    } as unknown as Blob);

    await expect(exportImagesAsZip([step(0)])).rejects.toBeInstanceOf(ImageZipExportLimitError);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('enforces the cumulative image budget before buffering the overflowing image', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    mocks.composite.mockResolvedValue({
      size: IMAGE_ZIP_EXPORT_LIMITS.maxImageBytes,
      arrayBuffer,
    } as unknown as Blob);
    const overflowAt = IMAGE_ZIP_EXPORT_LIMITS.maxTotalImageBytes / IMAGE_ZIP_EXPORT_LIMITS.maxImageBytes + 1;

    await expect(
      exportImagesAsZip(Array.from({ length: overflowAt }, (_, index) => step(index))),
    ).rejects.toBeInstanceOf(ImageZipExportLimitError);
    expect(mocks.composite).toHaveBeenCalledTimes(overflowAt);
    expect(arrayBuffer).toHaveBeenCalledTimes(overflowAt - 1);
    expect(mocks.download).not.toHaveBeenCalled();
  });

});

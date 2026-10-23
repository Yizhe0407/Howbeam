// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DownloadDelta = { id: number; state?: { current: string } };
type DownloadListener = (delta: DownloadDelta) => void;

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  listeners: [] as Array<(delta: { id: number; state?: { current: string } }) => void>,
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    downloads: {
      download: mocks.download,
      onChanged: {
        addListener: mocks.addListener,
        removeListener: mocks.removeListener,
      },
    },
  },
}));

import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import { DownloadFailedError } from '@/lib/export/export-errors';
import { itemAt } from '../setup/item-at';

beforeEach(() => {
  mocks.listeners.length = 0;
  mocks.download.mockReset().mockResolvedValue(7);
  mocks.addListener.mockReset().mockImplementation((listener: DownloadListener) => {
    mocks.listeners.push(listener);
  });
  mocks.removeListener.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('download utilities', () => {
  describe('downloadBlobViaBrowser', () => {
    it('wraps a rejected or id-less download as DownloadFailedError and releases the URL', async () => {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:publication');
      const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const rejection = new Error('Invalid filename');
      mocks.download.mockRejectedValueOnce(rejection);

      const failure = await downloadBlobViaBrowser(new Blob(['x']), 'con.pdf').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DownloadFailedError);
      expect((failure as Error).cause).toBe(rejection);

      mocks.download.mockResolvedValueOnce(undefined);
      await expect(downloadBlobViaBrowser(new Blob(['x']), 'a.pdf')).rejects.toBeInstanceOf(DownloadFailedError);
      expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    });

    it('queues through the downloads API and holds the URL until the transfer settles', async () => {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:publication');
      const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      await downloadBlobViaBrowser(new Blob(['pdf']), 'project.pdf');

      expect(mocks.download).toHaveBeenCalledWith({ url: 'blob:publication', filename: 'project.pdf', saveAs: true });
      // Queued is not settled: the blob must survive until a terminal state.
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(mocks.listeners).toHaveLength(1);

      itemAt(mocks.listeners, 0)({ id: 6, state: { current: 'complete' } });
      expect(revokeObjectURL).not.toHaveBeenCalled();
      itemAt(mocks.listeners, 0)({ id: 7, state: { current: 'complete' } });
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:publication');
      expect(mocks.removeListener).toHaveBeenCalledOnce();
    });

    it('rejects and releases the URL when the browser refuses to queue the download', async () => {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:publication');
      const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      mocks.download.mockRejectedValue(new Error('download failed'));

      await expect(downloadBlobViaBrowser(new Blob(['pdf']), 'project.pdf')).rejects.toThrow('download failed');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:publication');
    });

    it('rejects and releases the URL when no download id is returned', async () => {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:publication');
      const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      mocks.download.mockResolvedValue(undefined);

      await expect(downloadBlobViaBrowser(new Blob(['pdf']), 'project.pdf')).rejects.toThrow('瀏覽器沒有開始下載');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:publication');
    });

    it('does not allocate an object URL when already aborted', async () => {
      const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unused');
      const controller = new AbortController();
      controller.abort();

      await expect(
        downloadBlobViaBrowser(new Blob(['pdf']), 'project.pdf', { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(mocks.download).not.toHaveBeenCalled();
    });
  });
});

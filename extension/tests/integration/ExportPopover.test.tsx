// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';
import ExportPopover from '@/components/editor/ExportPopover';
import { DownloadFailedError, RedactionReviewRequiredError, StepImageError } from '@/lib/export/export-errors';
import { EditingBlockedError } from '@/lib/editor/editor-app-model';
import { DEFAULT_PDF_EXPORT_SETTINGS } from '@/lib/export/pdf-export-settings';
import { type StepEntry } from '@/lib/storage/models';

const mocks = vi.hoisted(() => ({
  generateProjectHtml: vi.fn(),
  generateProjectMarkdownArchive: vi.fn(),
  generateProjectPdf: vi.fn(),
  projectExportFilename: vi.fn((_metadata: unknown, format: string) => `project.${format === 'markdown-archive' ? 'zip' : format === 'markdown' ? 'md' : format}`),
  downloadBlobViaBrowser: vi.fn(),
}));

vi.mock('@/lib/export/project-export-html', () => ({ generateProjectHtml: mocks.generateProjectHtml }));
vi.mock('@/lib/export/project-export-markdown', () => ({ generateProjectMarkdownArchive: mocks.generateProjectMarkdownArchive }));
vi.mock('@/lib/export/project-export-pdf', () => ({ generateProjectPdf: mocks.generateProjectPdf }));
vi.mock('@/lib/export/project-export-contract', () => ({
  projectExportFilename: mocks.projectExportFilename,
}));

vi.mock('@/lib/export/download-utils', () => ({
  downloadBlobViaBrowser: mocks.downloadBlobViaBrowser,
  throwIfDownloadAborted: (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
  },
}));

const projectEntries = [{ kind: 'single' }] as unknown as readonly StepEntry[];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPopover(overrides: {
  projectEntries?: readonly StepEntry[];
  runExport?: (task: () => Promise<unknown>) => Promise<unknown>;
  getProjectEntries?: (signal: AbortSignal) => unknown;
  metadata?: { title?: string; filename?: string };
  onExportImages?: (signal: AbortSignal) => unknown;
} = {}) {
  // Settles once the export's turn as the editor's data operation is over.
  const settled = vi.fn();
  const runExport = vi.fn(overrides.runExport ?? ((task: () => Promise<unknown>) => task().finally(settled)));
  const getProjectEntries = vi.fn(
    overrides.getProjectEntries ?? (() => overrides.projectEntries ?? projectEntries),
  );
  render(
    <ExportPopover
      trigger={<button type="button">匯出</button>}
      runExport={runExport as never}
      getProjectEntries={getProjectEntries as never}
      metadata={overrides.metadata ?? { title: '核准教學' }}
      onExportImages={overrides.onExportImages}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '匯出' }));
  return { runExport, settled, getProjectEntries };
}

function chooseFormat(name: string) {
  fireEvent.click(screen.getByRole('radio', { name }));
}

describe('ExportPopover', () => {
  it('opens a panel anchored to the trigger with the four formats and PDF selected', () => {
    renderPopover({ onExportImages: vi.fn() });

    expect(screen.getByRole('dialog', { name: '匯出' })).toBeTruthy();
    for (const name of ['PDF', 'HTML', 'Markdown', '圖片']) {
      expect(screen.getByRole('radio', { name })).toBeTruthy();
    }
    expect(screen.getByRole('radio', { name: 'PDF' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: /下載 PDF/ })).toBeTruthy();
  });

  it('shows the PDF options only while PDF is the selected format', () => {
    renderPopover();

    expect(screen.getByRole('group', { name: 'PDF 選項' })).toBeTruthy();
    chooseFormat('Markdown');
    expect(screen.queryByRole('group', { name: 'PDF 選項' })).toBeNull();
    expect(screen.getByRole('button', { name: /下載 Markdown/ })).toBeTruthy();
  });

  it('downloads a Markdown ZIP using one provider snapshot and current metadata', async () => {
    const snapshotEntries = [{ kind: 'multiple' }] as unknown as readonly StepEntry[];
    const snapshotMetadata = { title: '目前教學', filename: 'current-project' };
    const archiveBlob = new Blob(['zip'], { type: 'application/zip' });
    mocks.generateProjectMarkdownArchive.mockResolvedValue({
      blob: archiveBlob,
      markdownFilename: 'current-project.md',
      imageCount: 1,
    });
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    const { getProjectEntries } = renderPopover({
      getProjectEntries: () => ({ entries: snapshotEntries, metadata: snapshotMetadata }),
      metadata: { title: '過期的畫面標題', filename: 'stale-project' },
    });

    chooseFormat('Markdown');
    fireEvent.click(screen.getByRole('button', { name: /下載 Markdown/ }));

    await waitFor(() => expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledOnce());
    const signal = getProjectEntries.mock.calls[0][0] as AbortSignal;
    expect(getProjectEntries).toHaveBeenCalledOnce();
    expect(mocks.generateProjectMarkdownArchive).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, { signal });
    expect(mocks.projectExportFilename).toHaveBeenCalledWith(snapshotMetadata, 'markdown-archive');
    expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledWith(archiveBlob, 'project.zip', { signal });
    // The browser shows the download itself, so the panel adds no notice of its own.
    await waitFor(() => expect(screen.getByRole('button', { name: /^下載/ }).hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('downloads a PDF with the default options when none were changed', async () => {
    const snapshotEntries = [{ kind: 'multiple' }] as unknown as readonly StepEntry[];
    const snapshotMetadata = { title: '原子 PDF 教學', filename: 'atomic-pdf-project' };
    const pdfBlob = new Blob(['pdf'], { type: 'application/pdf' });
    mocks.generateProjectPdf.mockResolvedValue(pdfBlob);
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    const { getProjectEntries } = renderPopover({
      getProjectEntries: () => ({ entries: snapshotEntries, metadata: snapshotMetadata }),
    });

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    await waitFor(() => expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledOnce());
    const signal = getProjectEntries.mock.calls[0][0] as AbortSignal;
    expect(mocks.generateProjectPdf).toHaveBeenCalledWith(snapshotEntries, snapshotMetadata, {
      signal,
      settings: DEFAULT_PDF_EXPORT_SETTINGS,
    });
    expect(mocks.projectExportFilename).toHaveBeenCalledWith(snapshotMetadata, 'pdf');
    expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledWith(pdfBlob, 'project.pdf', { signal });
    // The browser shows the download itself, so the panel adds no notice of its own.
    await waitFor(() => expect(screen.getByRole('button', { name: /^下載/ }).hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('passes the chosen PDF options to the PDF export', async () => {
    mocks.generateProjectPdf.mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }));
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    renderPopover();

    chooseFormat('Letter');
    chooseFormat('橫向');
    chooseFormat('連續排版');
    fireEvent.click(screen.getByRole('switch', { name: '頁尾顯示標題與頁碼' }));
    expect(screen.getByRole('radio', { name: 'Letter' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    await waitFor(() => expect(mocks.generateProjectPdf).toHaveBeenCalledOnce());
    expect(mocks.generateProjectPdf.mock.calls[0][2].settings).toEqual({
      paper: 'letter',
      orientation: 'landscape',
      stepLayout: 'continuous',
      showFooter: false,
    });
  });

  it('runs the whole export as one editor operation', async () => {
    let finishPdf: (blob: Blob) => void = () => {};
    mocks.generateProjectPdf.mockReturnValue(new Promise<Blob>((resolve) => { finishPdf = resolve; }));
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    const { runExport, settled } = renderPopover();

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    await waitFor(() => expect(mocks.generateProjectPdf).toHaveBeenCalledOnce());
    expect(runExport).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    finishPdf(new Blob(['pdf']));
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
  });

  it('ends the operation when the export fails', async () => {
    silenceIntentionalErrorLogs();
    mocks.generateProjectPdf.mockRejectedValue(new Error('boom'));
    const { settled } = renderPopover();

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('無法下載 PDF');
    expect(settled).toHaveBeenCalledOnce();
  });

  it('says the Project cannot be changed right now when editing is blocked', async () => {
    silenceIntentionalErrorLogs();
    const { getProjectEntries } = renderPopover({ runExport: () => Promise.reject(new EditingBlockedError()) });

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('請稍後再發佈');
    expect(getProjectEntries).not.toHaveBeenCalled();
  });

  it('keeps the panel open on outside clicks while exporting, and cancels with Escape', async () => {
    let callbackSignal: AbortSignal | undefined;
    const onExportImages = vi.fn((signal: AbortSignal) => {
      callbackSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    });
    const { settled } = renderPopover({ onExportImages });

    chooseFormat('圖片');
    fireEvent.click(screen.getByRole('button', { name: /下載圖片/ }));
    await waitFor(() => expect(onExportImages).toHaveBeenCalledOnce());
    // Progress shows once the export proves slow, not at the click.
    expect((await screen.findByRole('button', { name: /匯出中/ })).hasAttribute('disabled')).toBe(true);

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    expect(screen.getByRole('dialog', { name: '匯出' })).toBeTruthy();
    expect(callbackSignal?.aborted).toBe(false);

    fireEvent.keyDown(screen.getByRole('dialog', { name: '匯出' }), { key: 'Escape' });

    await waitFor(() => expect(callbackSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: /^下載/ })).toBeTruthy());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('dialog', { name: '匯出' })).toBeTruthy();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('cancels a running export from the Cancel button', async () => {
    let callbackSignal: AbortSignal | undefined;
    const onExportImages = vi.fn((signal: AbortSignal) => {
      callbackSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    });
    renderPopover({ onExportImages });

    chooseFormat('圖片');
    fireEvent.click(screen.getByRole('button', { name: /下載圖片/ }));
    await waitFor(() => expect(onExportImages).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));

    await waitFor(() => expect(callbackSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: /^下載/ })).toBeTruthy());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('closes on Escape when nothing is exporting', () => {
    renderPopover();

    fireEvent.keyDown(screen.getByRole('dialog', { name: '匯出' }), { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: '匯出' })).toBeNull();
  });

  it('disables the images format when no image export is wired', () => {
    renderPopover();

    expect((screen.getByRole('radio', { name: '圖片' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('downloads the HTML Blob as generated, without copying it into a string', async () => {
    const htmlBlob = new Blob(['<!doctype html>'], { type: 'text/html;charset=utf-8' });
    mocks.generateProjectHtml.mockResolvedValue(htmlBlob);
    mocks.downloadBlobViaBrowser.mockResolvedValue(undefined);
    renderPopover();

    chooseFormat('HTML');
    fireEvent.click(screen.getByRole('button', { name: /下載 HTML 網頁/ }));

    await waitFor(() => expect(mocks.downloadBlobViaBrowser).toHaveBeenCalledOnce());
    expect(mocks.downloadBlobViaBrowser.mock.calls[0][0]).toBe(htmlBlob);
    // The browser shows the download itself, so the panel adds no notice of its own.
    await waitFor(() => expect(screen.getByRole('button', { name: /^下載/ }).hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names the step whose image could not be read instead of blaming the masks', async () => {
    silenceIntentionalErrorLogs();
    mocks.generateProjectHtml.mockRejectedValue(new StepImageError(7, new Error('InvalidStateError')));
    renderPopover();

    chooseFormat('HTML');
    fireEvent.click(screen.getByRole('button', { name: /下載 HTML 網頁/ }));

    const alert = (await screen.findByRole('alert')).textContent ?? '';
    expect(alert).toContain('第 7 步的圖片無法讀取');
    expect(alert).not.toContain('遮罩後再試一次');
    expect(mocks.downloadBlobViaBrowser).not.toHaveBeenCalled();
  });

  it('lists the steps whose masks still need review', async () => {
    silenceIntentionalErrorLogs();
    mocks.generateProjectPdf.mockRejectedValue(new RedactionReviewRequiredError([2, 5]));
    renderPopover();

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('敏感資訊遮罩尚待檢查，匯出已中止：2, 5。');
  });

  it('reports a rejected browser download with its own message', async () => {
    silenceIntentionalErrorLogs();
    mocks.generateProjectPdf.mockResolvedValue(new Blob(['pdf']));
    mocks.downloadBlobViaBrowser.mockRejectedValue(new DownloadFailedError(new Error('Invalid filename')));
    renderPopover();

    fireEvent.click(screen.getByRole('button', { name: /下載 PDF/ }));

    const alert = (await screen.findByRole('alert')).textContent ?? '';
    expect(alert).toContain('瀏覽器無法開始下載檔案');
    expect(alert).not.toContain('敏感資訊遮罩');
  });

  it('tells the user nothing was exported when the image ZIP has no images', async () => {
    renderPopover({ onExportImages: vi.fn().mockResolvedValue(null) });

    chooseFormat('圖片');
    fireEvent.click(screen.getByRole('button', { name: /下載圖片/ }));

    const status = (await screen.findByRole('status')).textContent ?? '';
    expect(status).toContain('沒有可匯出的圖片');
    expect(status).not.toContain('已開始下載');
  });

  it('reports a failed export when the provider resolves no entries', async () => {
    silenceIntentionalErrorLogs();
    renderPopover({ projectEntries: [] });

    chooseFormat('Markdown');
    fireEvent.click(screen.getByRole('button', { name: /下載 Markdown/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('無法下載 Markdown');
    expect(mocks.generateProjectMarkdownArchive).not.toHaveBeenCalled();
    expect(mocks.downloadBlobViaBrowser).not.toHaveBeenCalled();
  });
});

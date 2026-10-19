// @vitest-environment jsdom

import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceIntentionalErrorLogs } from '../setup/silence-intentional-logs';
import { TooltipProvider } from '@/components/ui/tooltip';

// The library card actions use the shadcn Tooltip, which requires a
// TooltipProvider ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

const database = vi.hoisted(() => ({
  createProjectFromSteps: vi.fn(),
  deleteProjectPermanently: vi.fn(),
  duplicateProject: vi.fn(),
  getProjectSummaries: vi.fn(),
  getSteps: vi.fn(),
  updateProject: vi.fn(),
}));
const projectActions = vi.hoisted(() => ({
  clearSelectedProject: vi.fn(),
  createAndSelectProject: vi.fn(),
  openSelectedProjectInEditor: vi.fn(),
}));
const storage = vi.hoisted(() => {
  let listener: ((state: any) => void) | null = null;
  return {
    getRecordingState: vi.fn(),
    onRecordingStateChange: vi.fn((next: (state: any) => void) => {
      listener = next;
      return vi.fn();
    }),
    emit(state: any) { listener?.(state); },
  };
});
const changes = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
const downloads = vi.hoisted(() => ({ download: vi.fn() }));
const archive = vi.hoisted(() => ({
  exportProjectArchive: vi.fn(),
  importProjectArchive: vi.fn(),
  PROJECT_ARCHIVE_LIMITS: { maxArchiveBytes: 128 * 1024 * 1024 },
}));

vi.mock('@/lib/storage/project-repository', () => ({
  createProjectFromSteps: database.createProjectFromSteps,
  deleteProjectPermanently: database.deleteProjectPermanently,
  duplicateProject: database.duplicateProject,
  getProjectSummaries: database.getProjectSummaries,
  updateProject: database.updateProject,
}));
vi.mock('@/lib/storage/step-repository', () => ({ getSteps: database.getSteps }));
vi.mock('@/lib/project/project-actions', () => projectActions);
vi.mock('@/lib/storage/storage', () => storage);
vi.mock('@/lib/export/project-archive-serialize', () => ({ exportProjectArchive: archive.exportProjectArchive }));
vi.mock('@/lib/export/project-archive-import', () => ({ importProjectArchive: archive.importProjectArchive }));
vi.mock('@/lib/export/project-archive-contract', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/export/project-archive-contract')>()),
  PROJECT_ARCHIVE_LIMITS: archive.PROJECT_ARCHIVE_LIMITS,
}));
vi.mock('@/lib/storage/change-notifier', () => ({
  subscribeProjectsChanged: (listener: () => void) => {
    changes.listeners.add(listener);
    return () => changes.listeners.delete(listener);
  },
}));
vi.mock('wxt/browser', async () => {
  const { makeExtensionPageRuntimeMock } = await import('../setup/browser-mocks');
  return {
    browser: { downloads, runtime: makeExtensionPageRuntimeMock() },
  };
});

import LibraryApp from '@/entrypoints/library/App';
import { ProjectArchiveError } from '@/lib/export/project-archive-contract';

const project = {
  id: 'project-1',
  title: '安全教學',
  description: '範例',
  sections: [{ id: 'section-1', title: '準備', startEntryId: 'step-1' }],
  tags: [],
  createdAt: 1,
  updatedAt: 2,
  contentRevision: 3,
  stepCount: 2,
  entryCount: 2,
  storageBytes: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  database.getProjectSummaries.mockResolvedValue([project]);
  storage.getRecordingState.mockResolvedValue({ operation: null, isRecording: false });
  database.deleteProjectPermanently.mockResolvedValue(undefined);
  projectActions.clearSelectedProject.mockResolvedValue(undefined);
  downloads.download.mockResolvedValue(1);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('專案庫', () => {
  it('永久刪除成功後才 compare-and-clear UI selection', async () => {
    const order: string[] = [];
    database.deleteProjectPermanently.mockImplementation(async () => { order.push('delete'); });
    projectActions.clearSelectedProject.mockImplementation(async () => { order.push('clear'); });
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除' }));
    fireEvent.click(screen.getByRole('button', { name: '永久刪除' }));

    await waitFor(() => expect(database.deleteProjectPermanently).toHaveBeenCalledWith('project-1'));
    expect(projectActions.clearSelectedProject).toHaveBeenCalledWith('project-1');
    expect(order).toEqual(['delete', 'clear']);
  });

  it('刪除交易失敗時保留目前 selection', async () => {
    silenceIntentionalErrorLogs();
    database.deleteProjectPermanently.mockRejectedValue(new Error('durable delete failed'));
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除' }));
    fireEvent.click(screen.getByRole('button', { name: '永久刪除' }));

    expect(await screen.findByText('durable delete failed')).toBeTruthy();
    expect(projectActions.clearSelectedProject).not.toHaveBeenCalled();
    // Mirrors the export flow: the failure reports through the page-level
    // alert, so the modal must close instead of aria-hiding that alert.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('初次確認錄製狀態前停用新增與匯入操作', async () => {
    let resolveState!: (state: { operation: null; isRecording: false }) => void;
    storage.getRecordingState.mockReturnValueOnce(new Promise((resolve) => {
      resolveState = resolve;
    }));
    render(<LibraryApp />);

    expect((screen.getByRole('button', { name: '匯入' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '新增' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { resolveState({ operation: null, isRecording: false }); });
    await waitFor(() => expect((screen.getByRole('button', { name: '新增' }) as HTMLButtonElement).disabled).toBe(false));
  });

  // The card grid used to close with a dashed "add" tile, a third way to reach
  // the same action. The header button is the one that is always visible.
  it('專案卡片格線只保留標題列的新增入口', async () => {
    render(<LibraryApp />);
    await screen.findByDisplayValue('安全教學');

    projectActions.createAndSelectProject.mockResolvedValue({ id: 'new-project' });
    const createButtons = screen.getAllByRole('button', { name: '新增' });
    expect(createButtons).toHaveLength(1);
    fireEvent.click(createButtons[0]);

    await waitFor(() => expect(projectActions.createAndSelectProject).toHaveBeenCalledOnce());
    expect(projectActions.openSelectedProjectInEditor).toHaveBeenCalledWith('new-project', { inPlace: true });
  });

  it('專案庫只顯示必要的專案資訊', async () => {
    render(<LibraryApp />);
    await screen.findByDisplayValue('安全教學');

    expect(screen.queryByText('所有內容只保存在這個瀏覽器設定檔中。')).toBeNull();
    expect(screen.queryByText('1 個專案 · 100 B')).toBeNull();
    expect(screen.queryByText('100 B')).toBeNull();
    expect(screen.queryByText(/更新於/)).toBeNull();

    const counts = screen.getByText('2 個畫面').parentElement!;
    expect(counts.textContent).toBe('2 個畫面2 標註');
    expect(counts.getAttribute('title')).toBeNull();
  });

  it('專案沒有說明時不加入預設提示文字', async () => {
    database.getProjectSummaries.mockResolvedValue([{ ...project, description: '' }]);
    render(<LibraryApp />);

    await screen.findByDisplayValue('安全教學');
    expect(screen.queryByText('尚未加入專案說明')).toBeNull();
  });

  // Different situation: an otherwise empty page needs its own call to action.
  it('專案庫為空時額外提供空狀態的新增 CTA', async () => {
    database.getProjectSummaries.mockResolvedValue([]);
    render(<LibraryApp />);

    await screen.findByRole('heading', { name: '建立第一個專案' });
    await waitFor(() => expect(screen.getAllByRole('button', { name: '新增' })).toHaveLength(2));
  });

  it('即時訂閱全域 operation lock，避免錄製中修改專案庫', async () => {
    render(<LibraryApp />);
    const deleteButton = await screen.findByRole('button', { name: '刪除' }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(false);

    storage.emit({ operation: 'recording', isRecording: true });

    await waitFor(() => expect(deleteButton.disabled).toBe(true));
    expect(screen.getByText(/錄製或補拍進行中/)).toBeTruthy();
  });

  it('複製後在背景更新清單，不以載入畫面取代現有卡片', async () => {
    let resolveRefresh!: (projects: typeof project[]) => void;
    const pendingRefresh = new Promise<typeof project[]>((resolve) => {
      resolveRefresh = resolve;
    });
    database.getProjectSummaries
      .mockResolvedValueOnce([project])
      .mockReturnValueOnce(pendingRefresh);
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '複製' }));

    await waitFor(() => expect(database.getProjectSummaries).toHaveBeenCalledTimes(2));
    expect(screen.getByDisplayValue(project.title)).toBeTruthy();
    expect(screen.queryByText('讀取專案庫…')).toBeNull();

    await act(async () => { resolveRefresh([]); });
    await waitFor(() => expect(screen.queryByDisplayValue(project.title)).toBeNull());
  });

  it('失焦時提交重新命名的標題', async () => {
    database.updateProject.mockResolvedValue(undefined);
    render(<LibraryApp />);

    const input = await screen.findByDisplayValue('安全教學');
    input.focus();
    fireEvent.change(input, { target: { value: '更新後的標題' } });
    fireEvent.blur(input);

    await waitFor(() => expect(database.updateProject).toHaveBeenCalledWith('project-1', { title: '更新後的標題' }));
  });

  // Regression: Escape blurs synchronously before React re-renders, so the
  // blur-commit used to read the stale edited draft and save it anyway.
  it('Escape 取消重新命名而不寫入', async () => {
    render(<LibraryApp />);

    const input = await screen.findByDisplayValue('安全教學') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '不想保留的標題' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(input.value).toBe('安全教學'));
    expect(database.updateProject).not.toHaveBeenCalled();
  });

  it('視窗重新取得焦點時在背景重新整理專案庫', async () => {
    render(<LibraryApp />);
    await screen.findByDisplayValue('安全教學');
    expect(database.getProjectSummaries).toHaveBeenCalledTimes(1);

    fireEvent.focus(window);

    await waitFor(() => expect(database.getProjectSummaries).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('讀取專案庫…')).toBeNull();
  });

  it('可依多個標籤交集篩選並清除篩選', async () => {
    const taggedProject = { ...project, id: 'project-2', title: '團隊入門', tags: ['入門', '團隊'] };
    const otherProject = { ...project, id: 'project-3', title: '個人入門', tags: ['入門'] };
    database.getProjectSummaries.mockResolvedValue([taggedProject, otherProject]);
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '篩選' }));
    fireEvent.click(screen.getByRole('button', { name: '入門' }));
    expect(await screen.findByDisplayValue('團隊入門')).toBeTruthy();
    expect(screen.getByDisplayValue('個人入門')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '團隊' }));
    await waitFor(() => expect(screen.queryByDisplayValue('個人入門')).toBeNull());
    expect(screen.getByDisplayValue('團隊入門')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(await screen.findByDisplayValue('個人入門')).toBeTruthy();
  });

  it('匯出可編輯檔案時包含完整 metadata、使用安全檔名且不重新載入專案庫', async () => {
    const steps = [{ id: 'step-1' }];
    database.getSteps.mockResolvedValue(steps);
    archive.exportProjectArchive.mockResolvedValue(new Blob(['archive']));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:archive');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '匯出 安全教學' }));
    expect(screen.getByText(/安全教學\.howbeam/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下載 .howbeam' }));

    await waitFor(() => expect(archive.exportProjectArchive).toHaveBeenCalledWith(steps, {
      metadata: {
        title: project.title,
        description: project.description,
        sections: project.sections,
        tags: project.tags,
      },
    }));
    expect(downloads.download).toHaveBeenCalledWith({
      url: 'blob:archive',
      filename: '安全教學.howbeam',
      saveAs: true,
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:archive');
    expect(await screen.findByText('「安全教學」的可編輯檔案已開始下載。')).toBeTruthy();
    expect(database.getProjectSummaries).toHaveBeenCalledOnce();
  });

  it('匯出失敗時保留專案卡片、顯示錯誤並允許重試', async () => {
    silenceIntentionalErrorLogs();
    database.getSteps.mockResolvedValue([{ id: 'step-1' }]);
    archive.exportProjectArchive.mockRejectedValueOnce(new Error('匯出空間不足'));
    render(<LibraryApp />);

    fireEvent.click(await screen.findByRole('button', { name: '匯出 安全教學' }));
    fireEvent.click(screen.getByRole('button', { name: '下載 .howbeam' }));

    expect((await screen.findByRole('alert')).textContent).toContain('匯出空間不足');
    expect(screen.getByDisplayValue(project.title)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByRole('button', { name: '匯出 安全教學' }) as HTMLButtonElement).disabled).toBe(false);
    expect(database.getProjectSummaries).toHaveBeenCalledOnce();
  });

  it('匯入失敗時保留專案卡片並以 alert 公告錯誤', async () => {
    silenceIntentionalErrorLogs();
    archive.importProjectArchive.mockRejectedValue(new Error('檔案內容損毀'));
    render(<LibraryApp />);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    await waitFor(() => expect((screen.getByRole('button', { name: '匯入' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(input!, {
      target: { files: [new File(['broken'], 'broken.howbeam')] },
    });

    expect((await screen.findByRole('alert')).textContent).toContain('檔案內容損毀');
    expect(screen.getByDisplayValue(project.title)).toBeTruthy();
    expect(database.createProjectFromSteps).not.toHaveBeenCalled();
    expect(database.getProjectSummaries).toHaveBeenCalledOnce();
  });

  it('匯入的 .howbeam 錯誤依 code 顯示在地化訊息，而不是英文原文', async () => {
    silenceIntentionalErrorLogs();
    archive.importProjectArchive.mockRejectedValue(
      new ProjectArchiveError('INVALID_JSON', 'The project archive is not valid JSON.'),
    );
    render(<LibraryApp />);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    await waitFor(() => expect((screen.getByRole('button', { name: '匯入' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(input!, { target: { files: [new File(['broken'], 'broken.howbeam')] } });

    const alert = (await screen.findByRole('alert')).textContent ?? '';
    expect(alert).toContain('專案檔案的內容無法讀取');
    expect(alert).not.toContain('not valid JSON');
  });

  it('隱藏的檔案輸入不在 Tab 順序也不在無障礙樹中', async () => {
    render(<LibraryApp />);
    await screen.findByDisplayValue(project.title);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.tabIndex).toBe(-1);
    expect(input.getAttribute('aria-hidden')).toBe('true');
  });

  it('其他頁面寫入專案後即時更新專案庫（例如錄製後的畫面數）', async () => {
    render(<LibraryApp />);
    await screen.findByDisplayValue(project.title);
    expect(screen.getByText('2 個畫面', { exact: false })).toBeTruthy();
    expect(changes.listeners.size).toBeGreaterThan(0);

    database.getProjectSummaries.mockResolvedValue([{ ...project, entryCount: 5, stepCount: 5 }]);
    act(() => changes.listeners.forEach((listener) => listener()));

    await waitFor(() => expect(screen.getByText('5 個畫面', { exact: false })).toBeTruthy());
  });

  it('同一事件迴圈內不會啟動兩個重疊的專案庫寫入', async () => {
    let resolveDuplicate!: () => void;
    database.duplicateProject.mockReturnValue(new Promise<void>((resolve) => {
      resolveDuplicate = resolve;
    }));
    render(<LibraryApp />);

    const duplicate = await screen.findByRole('button', { name: '複製' });
    fireEvent.click(duplicate);
    fireEvent.click(duplicate);

    expect(database.duplicateProject).toHaveBeenCalledOnce();
    await act(async () => { resolveDuplicate(); });
  });

  it('匯入 v2 可編輯檔案時由 DB 用同一份 ID map 複製章節 boundary', async () => {
    const imported = {
      version: 2,
      steps: [{ id: 'new-step' }],
      metadata: {
        title: '匯入標題',
        description: '匯入說明',
        tags: ['匯入'],
        sections: [{ id: 'new-section', title: '第一章', startEntryId: 'new-step' }],
      },
    };
    archive.importProjectArchive.mockResolvedValue(imported);
    database.createProjectFromSteps.mockResolvedValue({ id: 'imported-project' });
    render(<LibraryApp />);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: '匯入' }) as HTMLButtonElement).disabled).toBe(false));
    const file = new File(['archive'], 'fallback.howbeam', { type: 'application/vnd.howbeam.project+zip' });
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => expect(archive.importProjectArchive).toHaveBeenCalledWith(file));
    expect(database.createProjectFromSteps).toHaveBeenCalledWith(
      imported.steps,
      { title: '匯入標題', description: '匯入說明', tags: ['匯入'] },
      { sections: imported.metadata.sections },
    );
    expect(projectActions.openSelectedProjectInEditor).toHaveBeenCalledWith('imported-project', { inPlace: true });
  });

});

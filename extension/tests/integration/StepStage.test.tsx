// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ScreenshotStep, type Step, type StepEntry } from '@/lib/storage/models';
import { TooltipProvider } from '@/components/ui/tooltip';

// StepStage's action buttons use the shadcn Tooltip, which requires a
// TooltipProvider ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}
vi.mock('@/lib/export/entry-render', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/export/entry-render')>(),
  renderEntryRaster: vi.fn(async () => new Blob(['preview'], { type: 'image/jpeg' })),
}));
vi.mock('@/components/editor/DescriptionField', () => ({ default: () => null }));
vi.mock('@/components/editor/StepTitleField', () => ({ default: () => null }));
vi.mock('@/components/editor/AnnotationList', () => ({ default: () => null }));
vi.mock('@/components/editor/StepActions', () => ({ default: () => null }));

const database = vi.hoisted(() => ({ getProjectSummaries: vi.fn() }));
vi.mock('@/lib/storage/project-repository', () => ({ getProjectSummaries: database.getProjectSummaries }));

import StepStage from '@/components/editor/StepStage';

interface StageOptions {
  entry?: StepEntry;
  editingDisabled?: boolean;
  onZoom?: () => void;
  section?: { id: string; title: string; startStep: number };
  onStartSection?: () => void;
  onRenameSection?: (sectionId: string) => void;
  onDeleteSection?: (sectionId: string) => Promise<void>;
}

function makeStep(changes: Partial<Step> = {}): Step {
  return {
    id: 'annotation-1',
    sessionId: 'session-1',
    order: 1,
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 1,
    title: '',
    description: '',
    url: 'https://example.test',
    timestamp: 0,
    groupId: 'group-1',
    ...changes,
  };
}

function groupEntry(anchorChanges: Partial<ScreenshotStep> = {}): StepEntry {
  return {
    kind: 'group',
    anchor: {
      ...makeStep({ id: 'group-1', order: 0, bounds: null }),
      screenshotBlob: new Blob(['image']),
      ...anchorChanges,
    } as ScreenshotStep,
    annotations: [makeStep()],
  };
}

function singleEntry(stepChanges: Partial<ScreenshotStep> = {}): StepEntry {
  return {
    kind: 'single',
    step: {
      ...makeStep(),
      screenshotBlob: new Blob(['image']),
      ...stepChanges,
    } as ScreenshotStep,
  };
}

function stage({
  entry = groupEntry(),
  editingDisabled = false,
  onZoom = vi.fn(),
  section,
  onStartSection,
  onRenameSection,
  onDeleteSection,
}: StageOptions = {}) {
  return (
    <StepStage
      entry={entry}
      index={0}
      section={section}
      onStartSection={onStartSection}
      onRenameSection={onRenameSection}
      onDeleteSection={onDeleteSection}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onDeleteAnnotation={vi.fn().mockResolvedValue(undefined)}
      onZoom={onZoom}
      onReorderAnnotations={vi.fn().mockResolvedValue(undefined)}
      onRecapture={vi.fn().mockResolvedValue(undefined)}
      editingDisabled={editingDisabled}
    />
  );
}

function renderStage(options: StageOptions = {}) {
  return render(stage(options));
}

beforeEach(() => {
  database.getProjectSummaries.mockResolvedValue([]);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stage');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('StepStage snapshots', () => {
  it('puts the zoom target, hint included, over the shown image in both modes', async () => {
    for (const entry of [groupEntry(), singleEntry()]) {
      const onZoom = vi.fn();
      const { container, unmount } = renderStage({ entry, onZoom });
      const image = await waitFor(() => {
        const shown = container.querySelector('img');
        if (!shown) throw new Error('the preview image is not shown yet');
        return shown;
      });
      Object.defineProperties(image, { naturalWidth: { value: 1280 }, naturalHeight: { value: 720 } });
      fireEvent.load(image);
      const zoom = await screen.findByRole('button', { name: '放大圖片' });

      expect(zoom.closest('[data-howbeam-image-content-frame]')).not.toBeNull();
      expect(zoom.contains(screen.getByText('點擊放大'))).toBe(true);
      fireEvent.click(zoom);
      expect(onZoom).toHaveBeenCalledTimes(1);
      unmount();
    }
  });
});

describe('StepStage image editing', () => {
  it('opens the image editor normally, and as the way to check masks while a review is pending', () => {
    const { unmount } = renderStage({ entry: singleEntry() });
    expect(screen.getByRole('button', { name: '編輯圖片' })).toBeTruthy();
    unmount();

    // After a retake of a masked image the review must be reachable, not a dead end.
    renderStage({ entry: singleEntry({ redactionReviewRequired: true }) });
    expect(screen.getByText(/請按「檢查遮罩」確認遮罩/)).toBeTruthy();
    const check = screen.getByRole('button', { name: '檢查遮罩' }) as HTMLButtonElement;
    expect(check.disabled).toBe(false);
  });
});

describe('StepStage sections', () => {
  afterEach(cleanup);

  const registration = { id: 'section-1', title: '條目頁面', startStep: 1 };

  it('shows nothing when the step has no section and cannot start one', () => {
    renderStage({ entry: singleEntry() });
    expect(screen.queryByRole('button', { name: /章節/ })).toBeNull();
  });

  it('labels a step before any section and offers only to start one', async () => {
    const onStartSection = vi.fn();
    renderStage({ entry: singleEntry(), onStartSection });
    fireEvent.click(screen.getByRole('button', { name: '未分章節' }));
    expect(await screen.findByText('前面還沒有章節，可以從這一步開始一個。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新命名章節' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '從第 1 步開始新章節' }));
    expect(onStartSection).toHaveBeenCalledOnce();
  });

  it('on the first step of a section, offers rename and delete but not another start', async () => {
    const onRenameSection = vi.fn();
    const onDeleteSection = vi.fn().mockResolvedValue(undefined);
    renderStage({ entry: singleEntry(), section: registration, onRenameSection, onDeleteSection });
    fireEvent.click(screen.getByRole('button', { name: '所屬章節：條目頁面' }));
    expect(await screen.findByText('從這一步開始')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /開始新章節/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新命名章節' }));
    expect(onRenameSection).toHaveBeenCalledWith('section-1');

    fireEvent.click(screen.getByRole('button', { name: '所屬章節：條目頁面' }));
    fireEvent.click(await screen.findByRole('button', { name: '刪除章節' }));
    await waitFor(() => expect(onDeleteSection).toHaveBeenCalledWith('section-1'));
  });

  it('inside a section, can split it at this step and says where it began', async () => {
    const onStartSection = vi.fn();
    renderStage({
      entry: singleEntry(),
      section: { ...registration, startStep: 0 },
      onStartSection,
      onRenameSection: vi.fn(),
      onDeleteSection: vi.fn().mockResolvedValue(undefined),
    });
    fireEvent.click(screen.getByRole('button', { name: '所屬章節：條目頁面' }));
    expect(await screen.findByText('從第 0 步開始')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '從第 1 步開始新章節' }));
    expect(onStartSection).toHaveBeenCalledOnce();
  });

  it('keeps the section readable but closed while editing is disabled', () => {
    renderStage({ entry: singleEntry(), section: registration, onRenameSection: vi.fn(), onDeleteSection: vi.fn(), editingDisabled: true });
    const chip = screen.getByRole('button', { name: '所屬章節：條目頁面' }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.textContent).toContain('條目頁面');
  });
});

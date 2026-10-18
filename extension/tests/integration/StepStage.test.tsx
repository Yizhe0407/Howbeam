// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { type ScreenshotStep, type Step, type StepEntry } from '@/lib/storage/models';
import { TooltipProvider } from '@/components/ui/tooltip';

// StepStage's "add tag" control uses the shadcn Tooltip, which requires a
// TooltipProvider ancestor — wrap every render() the same way the app roots do.
function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}
vi.mock('@/components/editor/HighlightThumbnail', () => ({
  default: ({ overlay }: { overlay?: ReactNode }) => <div data-testid="single-image-frame">{overlay}</div>,
}));
vi.mock('@/components/editor/MultiHighlightThumbnail', () => ({
  default: ({ overlay }: { overlay?: ReactNode }) => <div data-testid="group-image-frame">{overlay}</div>,
}));
vi.mock('@/components/editor/DescriptionField', () => ({ default: () => null }));
vi.mock('@/components/editor/AnnotationList', () => ({
  default: ({
    numbered,
    onSetNumbered,
    numberingPending,
    editingDisabled,
  }: {
    numbered: boolean;
    onSetNumbered: (next: boolean) => void;
    numberingPending: boolean;
    editingDisabled: boolean;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label="顯示編號"
      aria-checked={numbered}
      disabled={numberingPending || editingDisabled}
      onClick={() => onSetNumbered(!numbered)}
    />
  ),
}));
vi.mock('@/components/editor/StepActions', () => ({ default: () => null }));

const database = vi.hoisted(() => ({ getProjectSummaries: vi.fn() }));
vi.mock('@/lib/storage/project-repository', () => ({ getProjectSummaries: database.getProjectSummaries }));

import StepStage from '@/components/editor/StepStage';

interface StageOptions {
  entry?: StepEntry;
  editingDisabled?: boolean;
  onSetNumbered?: (entryId: string, next: boolean) => Promise<void>;
  onZoom?: () => void;
  projectTags?: readonly string[];
  onRemoveTag?: (tag: string) => Promise<void>;
  sectionTitle?: string;
  onStartSection?: () => void;
}

function makeStep(changes: Partial<Step> = {}): Step {
  return {
    id: 'annotation-1',
    sessionId: 'session-1',
    order: 1,
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.test',
    timestamp: 0,
    groupId: 'group-1',
    numbered: true,
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stage({
  entry = groupEntry(),
  editingDisabled = false,
  onSetNumbered = vi.fn().mockResolvedValue(undefined),
  onZoom = vi.fn(),
  projectTags,
  onRemoveTag,
  sectionTitle,
  onStartSection,
}: StageOptions = {}) {
  return (
    <StepStage
      entry={entry}
      index={0}
      sectionTitle={sectionTitle}
      onStartSection={onStartSection}
      projectTags={projectTags}
      onRemoveTag={onRemoveTag}
      onChange={vi.fn()}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onDeleteAnnotation={vi.fn().mockResolvedValue(undefined)}
      onZoom={onZoom}
      onReorderAnnotations={vi.fn().mockResolvedValue(undefined)}
      onRecapture={vi.fn().mockResolvedValue(undefined)}
      onSetNumbered={onSetNumbered}
      editingDisabled={editingDisabled}
    />
  );
}

function renderStage(options: StageOptions = {}) {
  return render(stage(options));
}

beforeEach(() => {
  database.getProjectSummaries.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('StepStage tags', () => {
  // Adding happens via the ＋標籤 dialog; removing happens on the inline chips only.
  it('keeps the inline chip as the only way to remove a tag', async () => {
    const onRemoveTag = vi.fn().mockResolvedValue(undefined);
    renderStage({ projectTags: ['驗收', '交付'], onRemoveTag });

    fireEvent.click(screen.getByRole('button', { name: '移除 驗收 標籤' }));

    // A single remove operation, never a whole list another tab's tags could be missing from.
    await waitFor(() => expect(onRemoveTag).toHaveBeenCalledWith('驗收'));

    // The dialog behind that chip adds only; it must not offer its own remove.
    fireEvent.click(screen.getByRole('button', { name: '標籤' }));
    expect(await screen.findByPlaceholderText('輸入後按 Enter')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '移除 交付 標籤' })).toBeNull();
  });

  it('reports a refused tag write on the stage rather than losing it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onRemoveTag = vi.fn().mockRejectedValue(new Error('目前有其他操作進行中，請稍後再修改。'));
    renderStage({ projectTags: ['驗收'], onRemoveTag });

    fireEvent.click(screen.getByRole('button', { name: '移除 驗收 標籤' }));

    expect((await screen.findByRole('alert')).textContent).toContain('目前有其他操作進行中');
    // The chip is driven by the stored value, so a refused write leaves it.
    expect(screen.getByRole('button', { name: '移除 驗收 標籤' })).toBeTruthy();
  });
});

describe('StepStage numbered snapshots', () => {
  it('anchors the zoom hint to the rendered image frame in both modes', () => {
    const { unmount } = renderStage();
    const groupHint = screen.getByText('點擊放大');
    expect(groupHint.parentElement?.dataset.testid).toBe('group-image-frame');

    unmount();
    renderStage({ entry: singleEntry() });
    const singleHint = screen.getByText('點擊放大');
    expect(singleHint.parentElement?.dataset.testid).toBe('single-image-frame');
  });

  it('submits the parent atomic callback only once while the update is pending', async () => {
    const pending = deferred();
    const onSetNumbered = vi.fn().mockReturnValue(pending.promise);
    renderStage({ onSetNumbered });

    const toggle = screen.getByRole('switch', { name: '顯示編號' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(onSetNumbered).toHaveBeenCalledOnce();
    expect(onSetNumbered).toHaveBeenCalledWith('group-1', false);
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('正在儲存編號設定')).toBeTruthy();

    pending.resolve();
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  });

  it('surfaces the rejection message when the parent callback rejects with an Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onSetNumbered = vi.fn().mockRejectedValue(new Error('write failed'));
    renderStage({ onSetNumbered });

    fireEvent.click(screen.getByRole('switch', { name: '顯示編號' }));

    expect((await screen.findByRole('alert')).textContent).toContain('write failed');
    expect(onSetNumbered).toHaveBeenCalledOnce();
    expect((screen.getByRole('switch', { name: '顯示編號' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('falls back to the generic failure message for a non-Error rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onSetNumbered = vi.fn().mockRejectedValue('write failed');
    renderStage({ onSetNumbered });

    fireEvent.click(screen.getByRole('switch', { name: '顯示編號' }));

    expect((await screen.findByRole('alert')).textContent).toContain('編號設定儲存失敗，請再試一次。');
  });

  it('does not submit when editing is disabled', () => {
    const onSetNumbered = vi.fn().mockResolvedValue(undefined);
    renderStage({ onSetNumbered, editingDisabled: true });

    const toggle = screen.getByRole('switch', { name: '顯示編號' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);

    expect(onSetNumbered).not.toHaveBeenCalled();
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

  it('shows the section the step belongs to', () => {
    renderStage({ entry: singleEntry(), sectionTitle: '條目頁面' });
    expect(screen.getByText('所屬章節：條目頁面')).toBeTruthy();
  });

  it('offers to start a section here only when the owner allows it, and not while editing is disabled', () => {
    const onStartSection = vi.fn();
    const { rerender } = renderStage({ entry: singleEntry(), onStartSection });
    fireEvent.click(screen.getByRole('button', { name: '從這步開始新章節' }));
    expect(onStartSection).toHaveBeenCalledOnce();

    rerender(stage({ entry: singleEntry(), onStartSection, editingDisabled: true }));
    expect((screen.getByRole('button', { name: '從這步開始新章節' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(stage({ entry: singleEntry() }));
    expect(screen.queryByRole('button', { name: '從這步開始新章節' })).toBeNull();
  });
});

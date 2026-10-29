// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { type ScreenshotStep, type Step, type StepEntry } from '@/lib/storage/models';
import { TooltipProvider } from '@/components/ui/tooltip';

// StepStage's action buttons use the shadcn Tooltip, which requires a
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
vi.mock('@/components/editor/AnnotationList', () => ({ default: () => null }));
vi.mock('@/components/editor/StepActions', () => ({ default: () => null }));

const database = vi.hoisted(() => ({ getProjectSummaries: vi.fn() }));
vi.mock('@/lib/storage/project-repository', () => ({ getProjectSummaries: database.getProjectSummaries }));

import StepStage from '@/components/editor/StepStage';

interface StageOptions {
  entry?: StepEntry;
  editingDisabled?: boolean;
  onZoom?: () => void;
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
  sectionTitle,
  onStartSection,
}: StageOptions = {}) {
  return (
    <StepStage
      entry={entry}
      index={0}
      sectionTitle={sectionTitle}
      onStartSection={onStartSection}
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('StepStage snapshots', () => {
  it('anchors the zoom hint to the rendered image frame in both modes', () => {
    const { unmount } = renderStage();
    const groupHint = screen.getByText('點擊放大');
    expect(groupHint.parentElement?.dataset.testid).toBe('group-image-frame');

    unmount();
    renderStage({ entry: singleEntry() });
    const singleHint = screen.getByText('點擊放大');
    expect(singleHint.parentElement?.dataset.testid).toBe('single-image-frame');
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
    const button = screen.getByRole('button', { name: '新增章節' });
    expect(button.getAttribute('title')).toBe('從第 1 步開始新章節');
    fireEvent.click(button);
    expect(onStartSection).toHaveBeenCalledOnce();

    rerender(stage({ entry: singleEntry(), onStartSection, editingDisabled: true }));
    expect((screen.getByRole('button', { name: '新增章節' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(stage({ entry: singleEntry() }));
    expect(screen.queryByRole('button', { name: '新增章節' })).toBeNull();
  });
});

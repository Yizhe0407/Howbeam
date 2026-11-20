import 'fake-indexeddb/auto';
// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ScreenshotStep, type Step, type StepEntry } from '@/lib/storage/models';

vi.mock('@/lib/export/entry-render', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/export/entry-render')>(),
  renderEntryRaster: vi.fn(async () => new Blob(['preview'], { type: 'image/jpeg' })),
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children?: any }) => children,
  DialogContent: ({ children }: { children?: any }) => children,
  DialogTitle: ({ children }: { children?: any }) => children,
  DialogDescription: ({ children }: { children?: any }) => children,
}));
vi.mock('@/components/ui/button', () => ({ Button: () => null }));
vi.mock('lucide-react', () => ({ Camera: () => null, Check: () => null, ChevronLeft: () => null, ChevronRight: () => null, GripVertical: () => null, Video: () => null, X: () => null }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children?: any }) => children,
  closestCenter: () => null,
}));
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children?: any }) => children,
  horizontalListSortingStrategy: {},
  verticalListSortingStrategy: {},
}));
vi.mock('@/lib/editor/dnd', () => ({
  reorderById: () => null,
  horizontalListModifiers: [],
  verticalListModifiers: [],
  useSortableReorder: (items: unknown[], getId: (item: unknown) => unknown) => ({
    sensors: [],
    accessibility: { announcements: {}, screenReaderInstructions: { draggable: '' } },
    handlers: {},
    itemIds: items.map(getId),
    overlayHost: null,
    setOverlayHost: () => undefined,
    previewPositionOf: (id: unknown) => items.map(getId).indexOf(id) + 1,
  }),
}));
vi.mock('@/components/editor/SortableItem', () => ({
  default: ({ children }: { children: (handle: null, overlay: null) => unknown }) => children(null, null),
  SortableOverlay: () => null,
  StaticHandle: () => null,
}));

import Lightbox from '@/components/editor/Lightbox';
import { renderEntryRaster, type EntryRasterInput } from '@/lib/export/entry-render';
import StepRail from '@/components/editor/StepRail';
import { itemAt } from '../setup/item-at';

const redactions = [{ id: 'mask-1', kind: 'solid' as const, bounds: { x: 90, y: 45, width: 20, height: 10 } }];

function makeStep(changes: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: 'session-1',
    order: 0,
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    devicePixelRatio: 1,
    title: '',
    description: '',
    url: 'https://example.test',
    timestamp: 0,
    ...changes,
  };
}

function singleEntry(): StepEntry {
  return {
    kind: 'single',
    step: {
      ...makeStep({ manualBounds: { x: 40, y: 50, width: 60, height: 70 }, redactions }),
      screenshotBlob: new Blob(['image']),
    } as ScreenshotStep,
  };
}

function groupEntry(): StepEntry {
  return {
    kind: 'group',
    anchor: {
      ...makeStep({ id: 'group-1', groupId: 'group-1', bounds: null, redactions }),
      screenshotBlob: new Blob(['image']),
    } as ScreenshotStep,
    annotations: [
      makeStep({
        id: 'annotation-1',
        groupId: 'group-1',
        order: 1,
        manualBounds: { x: 40, y: 50, width: 60, height: 70 },
      }),
    ],
  };
}

/** What each preview was rendered from, in request order. */
const renderedInputs = (): EntryRasterInput[] => vi.mocked(renderEntryRaster).mock.calls.map(([input]) => input);

const singleMarks = { kind: 'single', bounds: { x: 40, y: 50, width: 60, height: 70 } };
const groupMarks = { kind: 'group', annotations: [{ bounds: { x: 40, y: 50, width: 60, height: 70 }, order: 1 }] };

describe('timeline preview propagation', () => {
  beforeEach(() => {
    vi.mocked(renderEntryRaster).mockClear();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('StepRail renders manual-effective bounds and screenshot-owner masks for single and group entries', async () => {
    const entries = [singleEntry(), groupEntry()];
    render(
      <StepRail
        entries={entries}
        selectedEntryId={null}
        onSelect={() => {}}
        onReorder={async () => {}}
      />,
    );

    await waitFor(() => expect(renderedInputs()).toHaveLength(2));
    expect(renderedInputs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ marks: singleMarks, redactions }),
      expect.objectContaining({ marks: groupMarks, redactions }),
    ]));
  });

  it('Lightbox renders manual-effective bounds and screenshot-owner masks for single and group entries', async () => {
    const single = singleEntry();
    const group = groupEntry();
    const onClose = () => {};
    const onNavigate = () => {};
    const { rerender } = render(<Lightbox entries={[single]} index={0} onClose={onClose} onNavigate={onNavigate} />);

    await waitFor(() => expect(renderedInputs()).toHaveLength(1));
    expect(itemAt(renderedInputs(), 0)).toMatchObject({ marks: singleMarks, redactions });

    rerender(<Lightbox entries={[group]} index={0} onClose={onClose} onNavigate={onNavigate} />);
    await waitFor(() => expect(renderedInputs()).toHaveLength(2));
    expect(itemAt(renderedInputs(), 1)).toMatchObject({ marks: groupMarks, redactions });
  });
});

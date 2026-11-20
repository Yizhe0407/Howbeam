import { describe, expect, it } from 'vitest';
import { MOSAIC_BRUSH_LIMITS, type Redaction } from '@/lib/storage/models';
import {
  appendItem,
  hasRoomFor,
  IMAGE_ITEM_LIMITS,
  isPlaced,
  itemRoom,
  splitItems,
  toItems,
  type ImageEditItem,
  type MosaicItem,
} from '@/lib/editor/image-edit-items';
import { isCopyable } from '@/lib/editor/image-edit-clipboard';
import { extendStroke, imageEditTool, strokePoints, toolForShortcut } from '@/lib/editor/image-edit-tools';
import { clampBrushSize, DEFAULT_IMAGE_EDIT_STYLE } from '@/lib/editor/image-edit-style';

const size = { width: 400, height: 300 };
const mosaic = (overrides: Partial<MosaicItem> = {}): MosaicItem => ({
  id: 'm',
  kind: 'mosaic',
  points: [{ x: 50, y: 60 }, { x: 150, y: 80 }],
  size: 32,
  ...overrides,
});

describe('the mosaic tool', () => {
  const tool = imageEditTool('mosaic');

  it('is picked with B and paints along the path with the remembered brush width', () => {
    expect(toolForShortcut('b')?.id).toBe('mosaic');
    expect(tool.gesture).toBe('stroke');
    const style = { ...DEFAULT_IMAGE_EDIT_STYLE, brushSize: 48 };
    const path = [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 50 }];
    const item = tool.create!({ id: 'new', from: path[0]!, to: path[2]!, path, size, style, nextNumber: 1 });
    expect(item).toMatchObject({ kind: 'mosaic', points: path, size: 48 });
  });

  it('paints a dot for a click', () => {
    const point = { x: 20, y: 30 };
    const item = tool.create!({ id: 'new', from: point, to: point, path: [point, point], size, style: DEFAULT_IMAGE_EDIT_STYLE, nextNumber: 1 });
    expect(item).toMatchObject({ kind: 'mosaic', points: [point], size: 32 });
  });
});

describe('strokePoints', () => {
  it('drops points too close to the last one kept, but always keeps where the stroke ended', () => {
    expect(strokePoints([{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 0 }, { x: 5.5, y: 0 }]))
      .toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5.5, y: 0 }]);
  });

  it('never keeps more points than storage holds, ending at the last position', () => {
    const path = Array.from({ length: MOSAIC_BRUSH_LIMITS.maxPoints + 50 }, (_, index) => ({ x: index * 3, y: 0 }));
    const points = strokePoints(path);
    expect(points).toHaveLength(MOSAIC_BRUSH_LIMITS.maxPoints);
    expect(points.at(-1)).toEqual(path.at(-1));
  });
});

describe('extendStroke', () => {
  it('only ever adds at the end while painting, so what is painted never changes', () => {
    const points = [{ x: 0, y: 0 }];
    extendStroke(points, { x: 1, y: 0 });
    expect(points).toEqual([{ x: 0, y: 0 }]);
    extendStroke(points, { x: 3, y: 0 });
    extendStroke(points, { x: 3.5, y: 0 }, true);
    expect(points).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3.5, y: 0 }]);
  });

  it('keeps a whole path the same way as painting it', () => {
    const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 4, y: 0 }, { x: 4.5, y: 0 }];
    const painted: { x: number; y: number }[] = [];
    path.forEach((point, index) => extendStroke(painted, point, index === path.length - 1));
    expect(strokePoints(path)).toEqual(painted);
  });
});

describe('mosaic items', () => {
  it('round-trip through storage as pixelate masks, in the order they were drawn among solid masks', () => {
    const redactions: Redaction[] = [
      { id: 'a', kind: 'solid', bounds: { x: 1, y: 2, width: 10, height: 10 } },
      { id: 'b', kind: 'pixelate', points: [{ x: 5, y: 6 }], size: 40 },
    ];
    const items = toItems(redactions, []);
    expect(items.map((item) => item.kind)).toEqual(['redaction', 'mosaic']);
    expect(splitItems(items).redactions).toEqual(redactions);
  });

  it('stay above every drawn edit, like solid masks', () => {
    const arrow: ImageEditItem = { id: 'arrow', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 50, y: 50 }, width: 4, color: '#ff4747' };
    const list = appendItem([mosaic()], arrow);
    expect(list.map((item) => item.id)).toEqual(['arrow', 'm']);
  });

  it('count toward the mask limit', () => {
    const full = Array.from({ length: IMAGE_ITEM_LIMITS.maxMasks }, (_, index) => mosaic({ id: `m${index}` }));
    expect(itemRoom(full).masks).toBe(false);
    expect(hasRoomFor(full.slice(1), [mosaic({ id: 'new' })])).toBe(true);
    expect(hasRoomFor(full, [mosaic({ id: 'new' })])).toBe(false);
  });

  it('are paint: never picked up, moved or copied', () => {
    expect(isPlaced(mosaic())).toBe(false);
    expect(isCopyable(mosaic())).toBe(false);
    expect(isPlaced({ id: 'r', kind: 'redaction', bounds: { x: 0, y: 0, width: 5, height: 5 } })).toBe(true);
  });
});

describe('brush width', () => {
  it('stays a whole number within what storage accepts', () => {
    expect(clampBrushSize(33.6)).toBe(34);
    expect(clampBrushSize(1)).toBe(MOSAIC_BRUSH_LIMITS.minSize);
    expect(clampBrushSize(10_000)).toBe(MOSAIC_BRUSH_LIMITS.maxSize);
    expect(DEFAULT_IMAGE_EDIT_STYLE.brushSize).toBe(32);
  });
});

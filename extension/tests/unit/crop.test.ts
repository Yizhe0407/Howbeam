import { describe, expect, it } from 'vitest';
import { cropToPixels } from '@/lib/media/crop-image';
import {
  NO_CROP_ORIGIN,
  offsetAnnotations,
  offsetBounds,
  offsetImageEdits,
  offsetRedactions,
} from '@/lib/media/crop-offset';
import { snapCrop } from '@/lib/editor/image-edit-crop';
import { CROP_ITEM_ID, appendItem, splitItems, toItems, type ImageEditItem } from '@/lib/editor/image-edit-items';
import type { ImageEdit } from '@/lib/storage/image-edit-model';
import { itemAt } from '../setup/item-at';

describe('cropToPixels', () => {
  it('snaps the crop to whole device pixels', () => {
    // 2x screenshot: 1000x600 px. A 10.3,20.2 / 100.4 x 50.2 CSS crop lands on whole pixels.
    expect(cropToPixels({ x: 10.3, y: 20.2, width: 100.4, height: 50.2 }, 2, 1000, 600)).toEqual({ sx: 21, sy: 40, sw: 200, sh: 101 });
  });

  it('keeps the rectangle inside the image', () => {
    expect(cropToPixels({ x: -50, y: 300, width: 5_000, height: 5_000 }, 1, 1000, 600)).toEqual({ sx: 0, sy: 300, sw: 1000, sh: 300 });
    expect(cropToPixels({ x: 2_000, y: 0, width: 50, height: 50 }, 1, 1000, 600)).toEqual({ sx: 999, sy: 0, sw: 1, sh: 50 });
  });

  it('has nothing to cut when the crop covers the whole image', () => {
    expect(cropToPixels({ x: 0, y: 0, width: 1000, height: 600 }, 1, 1000, 600)).toBeNull();
    expect(cropToPixels({ x: -10, y: -10, width: 5_000, height: 5_000 }, 1, 1000, 600)).toBeNull();
  });
});

describe('crop offset', () => {
  const origin = { x: 100, y: 50 };

  it('shifts bounds, annotations, masks and every kind of edit by the crop origin', () => {
    expect(offsetBounds({ x: 120, y: 70, width: 10, height: 20 }, origin)).toEqual({ x: 20, y: 20, width: 10, height: 20 });
    expect(offsetBounds(null, origin)).toBeNull();
    expect(itemAt(offsetAnnotations([{ bounds: { x: 110, y: 60, width: 5, height: 5 }, order: 1 }], origin), 0).bounds).toEqual({ x: 10, y: 10, width: 5, height: 5 });
    expect(itemAt(offsetRedactions([{ id: 'm', kind: 'solid', bounds: { x: 100, y: 50, width: 8, height: 8 } }], origin), 0).bounds).toEqual({ x: 0, y: 0, width: 8, height: 8 });

    const edits: ImageEdit[] = [
      { id: 'a', kind: 'arrow', from: { x: 110, y: 60 }, to: { x: 210, y: 160 }, width: 4, color: '#ff4747' },
      { id: 'r', kind: 'rect', bounds: { x: 150, y: 90, width: 20, height: 10 }, width: 2, fill: 'none' as const, color: '#2f6fed' },
      { id: 't', kind: 'text', bounds: { x: 120, y: 70, width: 90, height: 30 }, text: 'Hi', fontSize: 24, look: 'plain' as const, color: '#111111' },
    ];
    const shifted = offsetImageEdits(edits, origin);
    expect(shifted[0]).toMatchObject({ from: { x: 10, y: 10 }, to: { x: 110, y: 110 } });
    expect(shifted[1]).toMatchObject({ bounds: { x: 50, y: 40 } });
    expect(shifted[2]).toMatchObject({ bounds: { x: 20, y: 20 } });
    // Nothing else about the edits changes, and the inputs are untouched.
    expect(shifted[2]).toMatchObject({ text: 'Hi', fontSize: 24, color: '#111111' });
    expect(edits[0]).toMatchObject({ from: { x: 110, y: 60 } });
  });

  it('returns the very same inputs when there is no crop, so previews do not re-render', () => {
    const redactions = [{ id: 'm', kind: 'solid' as const, bounds: { x: 1, y: 2, width: 3, height: 4 } }];
    const bounds = { x: 1, y: 2, width: 3, height: 4 };
    expect(offsetRedactions(redactions, NO_CROP_ORIGIN)).toBe(redactions);
    expect(offsetBounds(bounds, NO_CROP_ORIGIN)).toBe(bounds);
  });
});

describe('snapCrop', () => {
  const size = { width: 400, height: 200 };

  it('snaps edges to device pixels and clamps to the image', () => {
    expect(snapCrop({ x: 10.3, y: 20.2, width: 100.4, height: 50.2 }, size, 2)).toEqual({ x: 10.5, y: 20, width: 100, height: 50.5 });
    expect(snapCrop({ x: -20, y: -20, width: 100, height: 100 }, size, 1)).toEqual({ x: 0, y: 0, width: 80, height: 80 });
  });

  it('drops a crop that covers the whole image or has no size', () => {
    expect(snapCrop({ x: 0, y: 0, width: 400, height: 200 }, size, 1)).toBeNull();
    expect(snapCrop({ x: -10, y: -10, width: 1_000, height: 1_000 }, size, 1)).toBeNull();
    expect(snapCrop({ x: 50, y: 50, width: 0.1, height: 20 }, size, 1)).toBeNull();
  });
});

describe('crop as an item', () => {
  const mask = { id: 'm', kind: 'solid' as const, bounds: { x: 1, y: 2, width: 3, height: 4 } };
  const crop = { x: 10, y: 20, width: 100, height: 50 };

  it('round-trips through the item list and is not mistaken for an edit', () => {
    const items = toItems([mask], [], crop);
    expect(items[0]).toMatchObject({ id: CROP_ITEM_ID, kind: 'crop', bounds: crop });
    expect(splitItems(items)).toEqual({ redactions: [mask], imageEdits: [], crop });
    expect(splitItems(toItems([mask], [], null)).crop).toBeNull();
  });

  it('keeps a single crop: a new one replaces the old', () => {
    const items = toItems([], [], crop);
    const replaced = appendItem(items, { id: CROP_ITEM_ID, kind: 'crop', bounds: { x: 0, y: 0, width: 5, height: 5 } } as ImageEditItem);
    expect(replaced.filter((item) => item.kind === 'crop')).toHaveLength(1);
    expect(splitItems(replaced).crop).toEqual({ x: 0, y: 0, width: 5, height: 5 });
  });
});

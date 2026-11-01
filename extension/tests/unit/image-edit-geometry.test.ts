import { describe, expect, it } from 'vitest';
import {
  boundsFromPoints,
  clientToImagePoint,
  isUsableItemBounds,
  MIN_ITEM_SIZE,
  moveBounds,
  resizeBounds,
} from '@/lib/editor/image-edit-geometry';
import { appendItem, itemRoom, reorderItem, splitItems, toItems, type ImageEditItem } from '@/lib/editor/image-edit-items';
import { itemBounds, translateItem } from '@/lib/editor/image-edit-item-geometry';
import { isCopyable } from '@/lib/editor/image-edit-clipboard';
import { highlightFrame } from '@/lib/media/annotation-geometry';
import { HIGHLIGHT_PADDING } from '@/lib/media/annotation-contract';
import { itemAt } from '../setup/item-at';

const size = { width: 400, height: 200 };

describe('image edit geometry', () => {
  it('maps client pixels onto image CSS pixels and clamps to the image', () => {
    const frame = { left: 100, top: 50, width: 200, height: 100 };
    expect(clientToImagePoint({ x: 200, y: 100 }, frame, size)).toEqual({ x: 200, y: 100 });
    expect(clientToImagePoint({ x: 0, y: 1_000 }, frame, size)).toEqual({ x: 0, y: 200 });
  });

  it('normalises drag corners in any direction', () => {
    expect(boundsFromPoints({ x: 50, y: 60 }, { x: 10, y: 20 }, size)).toEqual({ x: 10, y: 20, width: 40, height: 40 });
    expect(boundsFromPoints({ x: -20, y: 10 }, { x: 500, y: 30 }, size)).toEqual({ x: 0, y: 10, width: 400, height: 20 });
  });

  it('treats tiny drags as unusable', () => {
    expect(isUsableItemBounds({ x: 0, y: 0, width: MIN_ITEM_SIZE - 1, height: 50 })).toBe(false);
    expect(isUsableItemBounds({ x: 0, y: 0, width: MIN_ITEM_SIZE, height: MIN_ITEM_SIZE })).toBe(true);
  });

  it('moves without leaving the image', () => {
    const bounds = { x: 350, y: 10, width: 40, height: 20 };
    expect(moveBounds(bounds, 100, -50, size)).toEqual({ x: 360, y: 0, width: 40, height: 20 });
  });

  it('resizes from a handle keeping the opposite edges fixed', () => {
    const bounds = { x: 100, y: 100, width: 100, height: 50 };
    expect(resizeBounds(bounds, 'se', 20, 10, size)).toEqual({ x: 100, y: 100, width: 120, height: 60 });
    expect(resizeBounds(bounds, 'nw', -30, -20, size)).toEqual({ x: 70, y: 80, width: 130, height: 70 });
  });

  it('never collapses or escapes when resizing', () => {
    const bounds = { x: 100, y: 100, width: 100, height: 50 };
    expect(resizeBounds(bounds, 'e', -500, 0, size).width).toBe(MIN_ITEM_SIZE);
    expect(resizeBounds(bounds, 'se', 5_000, 5_000, size)).toEqual({ x: 100, y: 100, width: 300, height: 100 });
  });
});

describe('image edit items', () => {
  const mask = { id: 'm', kind: 'solid' as const, bounds: { x: 1, y: 2, width: 30, height: 40 } };
  const rect = { id: 'r', kind: 'rect' as const, bounds: { x: 5, y: 6, width: 7, height: 8 }, width: 2, fill: 'none' as const, color: '#ff4747' };
  const arrow = { id: 'a', kind: 'arrow' as const, from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, width: 4, color: '#2f6fed' };

  it('round-trips both stored fields through the flat item list, masks last', () => {
    const items = toItems([mask], [rect, arrow]);
    expect(items.map((item) => item.id)).toEqual(['r', 'a', 'm']);
    expect(splitItems(items)).toEqual({ redactions: [mask], imageEdits: [rect, arrow], crop: null, highlights: [] });
  });

  it('keeps masks last when something is added', () => {
    const items = toItems([mask], [rect]);
    const added: ImageEditItem = { ...rect, id: 'r2' };
    expect(appendItem(items, added).map((item) => item.id)).toEqual(['r', 'r2', 'm']);
    expect(appendItem(items, { id: 'm2', kind: 'redaction', bounds: mask.bounds }).map((item) => item.id)).toEqual(['r', 'm', 'm2']);
  });
});

describe('recorded boxes as items', () => {
  const recorded = { id: 'step', bounds: { x: 20, y: 30, width: 40, height: 20 } };
  const rect = { id: 'r', kind: 'rect' as const, bounds: { x: 5, y: 6, width: 7, height: 8 }, width: 2, fill: 'none' as const, color: '#ff4747' };

  it('sit under the drawings, round-trip on their own, and never count against the drawing limit', () => {
    const items = toItems([], [rect], null, [recorded]);
    expect(items.map((item) => item.id)).toEqual(['step', 'r']);
    expect(splitItems(items)).toEqual({ redactions: [], imageEdits: [rect], crop: null, highlights: [recorded] });
    expect(itemRoom(items)).toEqual({ masks: true, edits: true });
    expect(reorderItem(items, 'r', 'back').map((item) => item.id)).toEqual(['step', 'r']);
    expect(isCopyable(itemAt(items, 0))).toBe(false);
  });

  it('are framed and kept inside the image where they are drawn, padded out from their target', () => {
    const item = itemAt(toItems([], [], null, [recorded]), 0);
    expect(itemBounds(item)).toEqual(highlightFrame(recorded.bounds));
    const pushed = translateItem(item, -100, 0, size);
    expect(itemBounds(pushed).x).toBe(0);
    expect(pushed.kind === 'highlight' && pushed.bounds).toEqual({ ...recorded.bounds, x: HIGHLIGHT_PADDING });
  });
});

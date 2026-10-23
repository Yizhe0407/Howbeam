import { describe, expect, it } from 'vitest';
import { constrainToSquare, snapToAngle } from '@/lib/editor/image-edit-geometry';
import { isCopyable, pasteItems } from '@/lib/editor/image-edit-clipboard';
import { hasRoomFor, IMAGE_ITEM_LIMITS, itemRoom, nextStepNumber, reorderItem, roomForKind, type ImageEditItem } from '@/lib/editor/image-edit-items';
import { applyStylePatch, DEFAULT_IMAGE_EDIT_STYLE, STYLE_FIELDS, styleOfItem } from '@/lib/editor/image-edit-style';
import { constrainDragEnd, imageEditTool, IMAGE_EDIT_TOOLS, toolForShortcut } from '@/lib/editor/image-edit-tools';
import { isValidImageEdit } from '@/lib/storage/image-edit-model';
import { itemAt } from '../setup/item-at';

const size = { width: 400, height: 300 };

const rect: ImageEditItem = { id: 'r', kind: 'rect', bounds: { x: 10, y: 10, width: 50, height: 30 }, width: 2, color: '#ff4747', fill: 'none' };
const text: ImageEditItem = { id: 't', kind: 'text', bounds: { x: 20, y: 20, width: 120, height: 30 }, text: 'Hi', fontSize: 24, color: '#111111', look: 'plain' };
const marker = (id: string, number: number): ImageEditItem => ({ id, kind: 'step', center: { x: 50, y: 50 }, radius: 16, number, color: '#ff4747' });
const mask: ImageEditItem = { id: 'm', kind: 'redaction', bounds: { x: 0, y: 0, width: 10, height: 10 } };

describe('Shift constraints', () => {
  it('makes a drag square, staying inside the image', () => {
    expect(constrainToSquare({ x: 10, y: 10 }, { x: 60, y: 30 }, size)).toEqual({ x: 60, y: 60 });
    expect(constrainToSquare({ x: 10, y: 10 }, { x: -50, y: 30 }, size)).toEqual({ x: 0, y: 20 });
    const clamped = constrainToSquare({ x: 380, y: 10 }, { x: 500, y: 30 }, size);
    expect(clamped.x).toBeLessThanOrEqual(size.width);
    expect(Math.abs(clamped.x - 380)).toBe(Math.abs(clamped.y - 10));
  });

  it('snaps an arrow to the nearest 45 degrees and keeps its length', () => {
    const snapped = snapToAngle({ x: 100, y: 100 }, { x: 200, y: 110 }, size);
    expect(snapped.y).toBe(100);
    expect(snapped.x).toBeCloseTo(100 + Math.hypot(100, 10), 1);
    const diagonal = snapToAngle({ x: 100, y: 100 }, { x: 160, y: 150 }, size);
    expect(diagonal.x - 100).toBeCloseTo(diagonal.y - 100, 1);
  });

  it('is requested per tool: boxes and ellipses square, arrows angle, pointer and text free', () => {
    expect(imageEditTool('rect').constraint).toBe('square');
    expect(imageEditTool('ellipse').constraint).toBe('square');
    expect(imageEditTool('arrow').constraint).toBe('angle');
    expect(imageEditTool('text').constraint).toBeUndefined();
    const to = { x: 90, y: 30 };
    expect(constrainDragEnd(imageEditTool('text'), { x: 10, y: 10 }, to, size)).toBe(to);
  });
});

describe('tool registry', () => {
  it('gives every tool a unique single-key shortcut', () => {
    const keys = IMAGE_EDIT_TOOLS.map((tool) => tool.shortcut);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.length === 1)).toBe(true);
    expect(toolForShortcut('O')?.id).toBe('ellipse');
    expect(toolForShortcut('z')).toBeUndefined();
  });

  it('draws an ellipse and a numbered marker', () => {
    const input = { from: { x: 10, y: 10 }, to: { x: 80, y: 50 }, size, style: DEFAULT_IMAGE_EDIT_STYLE, nextNumber: 3 };
    expect(imageEditTool('ellipse').create!(input)).toMatchObject({ kind: 'ellipse', bounds: { x: 10, y: 10, width: 70, height: 40 }, fill: 'none' });
    expect(imageEditTool('step').create!(input)).toMatchObject({ kind: 'step', center: { x: 80, y: 50 }, number: 3, radius: 16 });
  });

  it('starts text with the chosen look', () => {
    const created = imageEditTool('text').create!({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, size, style: { ...DEFAULT_IMAGE_EDIT_STYLE, look: 'outline' }, nextNumber: 1 });
    expect(created).toMatchObject({ kind: 'text', look: 'outline', text: '' });
  });
});

describe('style', () => {
  it('only applies the parts an item has', () => {
    expect(applyStylePatch(rect as never, { color: '#22a559', fontSize: 56, look: 'outline', fill: 'tint', strokeWidth: 6 })).toMatchObject({
      color: '#22a559', fill: 'tint', width: 6,
    });
    const restyled = applyStylePatch(text as never, { look: 'outline', fontSize: 56, strokeWidth: 6 }) as Extract<ImageEditItem, { kind: 'text' }>;
    expect(restyled).toMatchObject({ look: 'outline', fontSize: 56 });
    expect('width' in restyled).toBe(false);
    expect(applyStylePatch(marker('s', 1) as never, { markerRadius: 22, number: 7 })).toMatchObject({ radius: 22, number: 7 });
  });

  it('reads an item back as a style, falling back for what it lacks', () => {
    expect(styleOfItem(text as never, DEFAULT_IMAGE_EDIT_STYLE)).toMatchObject({ look: 'plain', fontSize: 24, color: '#111111', strokeWidth: 4 });
  });

  it('offers marker numbering only once a marker exists', () => {
    expect(STYLE_FIELDS.step).toContain('number');
    expect(imageEditTool('step').styleFields).not.toContain('number');
  });

  it('accepts custom hex colours only', () => {
    expect(isValidImageEdit({ ...rect, color: '#a1b2c3' })).toBe(true);
    for (const bad of ['red', '#fff', '#GGGGGG', 'url(x)']) expect(isValidImageEdit({ ...rect, color: bad })).toBe(false);
    expect(isValidImageEdit({ ...text, look: 'neon' })).toBe(false);
    expect(isValidImageEdit({ ...rect, fill: 'gradient' })).toBe(false);
  });
});

describe('clipboard and layer order', () => {
  it('pastes copies with new ids, offset, inside the image, and the next marker number', () => {
    const { items, pasted } = pasteItems([marker('a', 1), marker('b', 2)], [marker('a', 1)], 16, size);
    expect(pasted).toHaveLength(1);
    expect(itemAt(pasted, 0).id).not.toBe('a');
    expect(pasted[0]).toMatchObject({ kind: 'step', number: 3, center: { x: 66, y: 66 } });
    expect(items).toHaveLength(3);
    const edge = itemAt(pasteItems([], [{ ...rect, bounds: { x: 390, y: 290, width: 10, height: 10 } } as ImageEditItem], 16, size).pasted, 0);
    expect(edge.kind === 'rect' && edge.bounds.x + edge.bounds.width).toBeLessThanOrEqual(size.width);
  });

  it('never copies the crop, and keeps pasted edits under masks', () => {
    expect(isCopyable({ id: 'crop', kind: 'crop', bounds: { x: 0, y: 0, width: 10, height: 10 } })).toBe(false);
    const { items } = pasteItems([rect, mask], [rect], 16, size);
    expect(items.map((item) => item.kind)).toEqual(['rect', 'rect', 'redaction']);
  });

  it('moves an item to the front or back of its own group; masks stay on top', () => {
    const list = [rect, text, marker('s', 1), mask];
    expect(reorderItem(list, 'r', 'front').map((item) => item.id)).toEqual(['t', 's', 'r', 'm']);
    expect(reorderItem(list, 's', 'back').map((item) => item.id)).toEqual(['s', 'r', 't', 'm']);
    expect(reorderItem(list, 'm', 'back').map((item) => item.id)).toEqual(['r', 't', 's', 'm']);
  });

  it('numbers the next marker after the highest in use', () => {
    expect(nextStepNumber([])).toBe(1);
    expect(nextStepNumber([marker('a', 1), marker('b', 5), rect])).toBe(6);
  });
});

describe('storage limits', () => {
  const masks = (count: number): ImageEditItem[] =>
    Array.from({ length: count }, (_, index) => ({ ...mask, id: `m${index}` }));
  const rects = (count: number): ImageEditItem[] =>
    Array.from({ length: count }, (_, index) => ({ ...rect, id: `r${index}` }));
  const crop: ImageEditItem = { id: 'crop', kind: 'crop', bounds: { x: 0, y: 0, width: 10, height: 10 } };

  it('counts masks and drawings against their own limits; the crop never counts', () => {
    const fullEdits = [...rects(IMAGE_ITEM_LIMITS.maxEdits), crop];
    expect(itemRoom(fullEdits)).toEqual({ masks: true, edits: false });
    expect(hasRoomFor(fullEdits, [text])).toBe(false);
    expect(hasRoomFor(fullEdits, [mask])).toBe(true);
    expect(hasRoomFor(fullEdits, [crop])).toBe(true);
    expect(roomForKind('crop', itemRoom(fullEdits))).toBe(true);
    expect(roomForKind('arrow', itemRoom(fullEdits))).toBe(false);

    const fullMasks = masks(IMAGE_ITEM_LIMITS.maxMasks);
    expect(itemRoom(fullMasks)).toEqual({ masks: false, edits: true });
    expect(hasRoomFor(fullMasks, [mask])).toBe(false);
  });

  it('refuses a paste that would go past a limit as a whole', () => {
    const almost = rects(IMAGE_ITEM_LIMITS.maxEdits - 1);
    expect(hasRoomFor(almost, [rect])).toBe(true);
    expect(hasRoomFor(almost, [rect, text])).toBe(false);
  });
});

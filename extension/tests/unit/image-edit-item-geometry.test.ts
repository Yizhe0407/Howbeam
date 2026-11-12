import { describe, expect, it } from 'vitest';
import {
  fitTextHeight,
  itemBounds,
  itemHandles,
  MIN_TEXT_WIDTH,
  resizeItem,
  translateItem,
} from '@/lib/editor/image-edit-item-geometry';
import { DEFAULT_IMAGE_EDIT_STYLE } from '@/lib/editor/image-edit-style';
import { imageEditTool } from '@/lib/editor/image-edit-tools';
import type { ImageEditItem } from '@/lib/editor/image-edit-items';
import type { TextMeasure } from '@/lib/media/image-edit-render';

const size = { width: 400, height: 200 };
const measure: TextMeasure = (text, fontSize) => text.length * fontSize * 0.5;
const arrow: ImageEditItem = {
  id: 'a',
  kind: 'arrow',
  from: { x: 10, y: 20 },
  to: { x: 110, y: 70 },
  width: 4,
  color: '#ff4747',
};
const rect: ImageEditItem = {
  id: 'r',
  kind: 'rect',
  bounds: { x: 50, y: 50, width: 100, height: 40 },
  width: 2,
  fill: 'none' as const,
  color: '#2f6fed',
};
const text: ImageEditItem = {
  id: 't',
  kind: 'text',
  bounds: { x: 20, y: 20, width: 100, height: 30 },
  text: 'hello world',
  fontSize: 20,
  look: 'plain' as const,
  color: '#111111',
};

describe('item handles and bounds', () => {
  it('gives each kind the handles that make sense for it', () => {
    expect(itemHandles(arrow)).toEqual(['from', 'to']);
    expect(itemHandles(text)).toEqual(['w', 'e']);
    expect(itemHandles(rect)).toHaveLength(8);
  });

  it('boxes an arrow by its end points', () => {
    expect(itemBounds(arrow)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(itemBounds({ ...arrow, from: { x: 110, y: 70 }, to: { x: 10, y: 20 } })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });
});

describe('translateItem', () => {
  it('moves both ends of an arrow together and keeps them inside the image', () => {
    const moved = translateItem(arrow, 30, 10, size) as typeof arrow;
    expect(moved.from).toEqual({ x: 40, y: 30 });
    expect(moved.to).toEqual({ x: 140, y: 80 });
    const clamped = translateItem(arrow, 1_000, -1_000, size) as typeof arrow;
    expect(clamped.to.x).toBe(400);
    expect(clamped.from.y).toBe(0);
    expect(clamped.to.x - clamped.from.x).toBe(100);
  });

  it('moves boxes within the image', () => {
    expect(translateItem(rect, -500, 500, size)).toMatchObject({ bounds: { x: 0, y: 160, width: 100, height: 40 } });
  });
});

describe('resizeItem', () => {
  it('drags one end of an arrow and leaves the other', () => {
    const resized = resizeItem(arrow, 'to', 20, -10, size) as typeof arrow;
    expect(resized.to).toEqual({ x: 130, y: 60 });
    expect(resized.from).toEqual(arrow.kind === 'arrow' ? arrow.from : undefined);
    expect((resizeItem(arrow, 'from', -1_000, 0, size) as typeof arrow).from.x).toBe(0);
  });

  it('resizes a box from a corner', () => {
    expect(resizeItem(rect, 'se', 10, 10, size)).toMatchObject({ bounds: { x: 50, y: 50, width: 110, height: 50 } });
  });

  it('resizes text by width only, never below the minimum, and refits its height', () => {
    const wider = resizeItem(text, 'e', 100, 999, size, { measure });
    expect(wider.kind === 'text' && wider.bounds.width).toBe(200);
    expect(wider.kind === 'text' && wider.bounds.y).toBe(20);
    const narrow = resizeItem(text, 'e', -1_000, 0, size, { measure });
    expect(narrow.kind === 'text' && narrow.bounds.width).toBe(MIN_TEXT_WIDTH);
    // 11 chars * 10px = 110px of text: one line at 200px wide, but several in a 24px box.
    expect(narrow.kind === 'text' && narrow.bounds.height).toBeGreaterThan(
      wider.kind === 'text' ? wider.bounds.height : 0,
    );
  });

  it('refits a text box height to its content', () => {
    const fitted = fitTextHeight(
      { ...(text as Extract<ImageEditItem, { kind: 'text' }>), bounds: { x: 0, y: 0, width: 60, height: 1 } },
      measure,
    );
    // 60px fits 6 chars at 10px: "hello " / "world" = 2 lines of 26px.
    expect(fitted.bounds.height).toBeCloseTo(52);
  });
});

describe('creating items from a drag', () => {
  const input = (from: { x: number; y: number }, to: { x: number; y: number }) => ({
    from,
    to,
    size,
    style: DEFAULT_IMAGE_EDIT_STYLE,
    nextNumber: 1,
  });

  it('makes a box from a usable drag and nothing from a stray click', () => {
    expect(imageEditTool('rect').create!(input({ x: 10, y: 10 }, { x: 60, y: 40 }))).toMatchObject({
      kind: 'rect',
      bounds: { x: 10, y: 10, width: 50, height: 30 },
      fill: 'none' as const,
      color: '#ff4747',
      width: 4,
    });
    expect(imageEditTool('rect').create!(input({ x: 10, y: 10 }, { x: 11, y: 11 }))).toBeNull();
    expect(imageEditTool('redact').create!(input({ x: 10, y: 10 }, { x: 60, y: 40 }))).toMatchObject({
      kind: 'redaction',
    });
  });

  it('makes an arrow from start to end, and none for a stray click', () => {
    expect(imageEditTool('arrow').create!(input({ x: 10, y: 10 }, { x: 100, y: 80 }))).toMatchObject({
      kind: 'arrow',
      from: { x: 10, y: 10 },
      to: { x: 100, y: 80 },
    });
    expect(imageEditTool('arrow').create!(input({ x: 10, y: 10 }, { x: 12, y: 12 }))).toBeNull();
  });

  it('makes a default-width text box from a click and a dragged-width one from a drag, inside the image', () => {
    const clicked = imageEditTool('text').create!(input({ x: 390, y: 50 }, { x: 390, y: 50 }));
    expect(clicked).toMatchObject({ kind: 'text', text: '' });
    expect(clicked!.kind === 'text' && clicked!.bounds.x + clicked!.bounds.width).toBeLessThanOrEqual(400);
    const dragged = imageEditTool('text').create!(input({ x: 20, y: 30 }, { x: 220, y: 90 }));
    expect(dragged).toMatchObject({ kind: 'text', bounds: { x: 20, y: 30, width: 200 } });
  });
});

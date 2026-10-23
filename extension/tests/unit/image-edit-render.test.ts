import { describe, expect, it, vi } from 'vitest';
import {
  arrowShape,
  drawImageEdits,
  layoutTextLines,
  measureTextEditHeight,
  placeText,
  textBaselineOffset,
  textLineHeight,
  type TextMeasure,
} from '@/lib/media/image-edit-render';
import type { ArrowEdit, ImageEdit, TextEdit } from '@/lib/storage/image-edit-model';
import { itemAt } from '../setup/item-at';

/** Every character is exactly half the font size wide, so wrapping is easy to predict. */
const measure: TextMeasure = (text, fontSize) => text.length * fontSize * 0.5;

describe('layoutTextLines', () => {
  it('wraps at spaces and never splits a word that fits', () => {
    // 10px font: 5px per char; 50px box fits 10 chars.
    expect(layoutTextLines('hello brave new world', 10, 50, measure)).toEqual(['hello', 'brave new', 'world']);
  });

  it('breaks between characters when there are no spaces, as CJK text needs', () => {
    expect(layoutTextLines('點這裡開始設定帳號', 10, 20, measure)).toEqual(['點這裡開', '始設定帳', '號']);
  });

  it('keeps explicit line breaks and blank lines', () => {
    expect(layoutTextLines('a\n\nb', 10, 100, measure)).toEqual(['a', '', 'b']);
  });

  it('gives an over-wide character its own line instead of looping', () => {
    expect(layoutTextLines('WW', 10, 2, measure)).toEqual(['W', 'W']);
  });

  it('breaks a long unbroken word that exceeds the width', () => {
    expect(layoutTextLines('abcdefghijkl', 10, 30, measure)).toEqual(['abcdef', 'ghijkl']);
  });
});

describe('text placement', () => {
  const edit: TextEdit = { id: 't', kind: 'text', bounds: { x: 10, y: 20, width: 50, height: 40 }, text: 'hello brave new', fontSize: 10, look: 'plain' as const, color: '#ff4747' };

  it('puts each line on its own baseline inside the box', () => {
    const placement = placeText(edit, measure);
    expect(placement.lines.map((line) => line.text)).toEqual(['hello', 'brave new']);
    const step = textLineHeight(10);
    expect(itemAt(placement.lines, 0).baselineY).toBeCloseTo(20 + textBaselineOffset(10));
    expect(itemAt(placement.lines, 1).baselineY - itemAt(placement.lines, 0).baselineY).toBeCloseTo(step);
    expect(placement.x).toBe(10);
  });

  it('measures the height a box needs for its content', () => {
    expect(measureTextEditHeight({ text: 'hello brave new', fontSize: 10, width: 50 }, measure)).toBeCloseTo(2 * textLineHeight(10));
  });
});

describe('arrowShape', () => {
  const arrow = (to: { x: number; y: number }, width = 4): Pick<ArrowEdit, 'from' | 'to' | 'width'> => ({ from: { x: 0, y: 0 }, to, width });

  it('puts the tip at the end point with the shaft tucked under the head', () => {
    const shape = arrowShape(arrow({ x: 100, y: 0 }))!;
    expect(shape.head[0]).toEqual({ x: 100, y: 0 });
    // Head length = 8 + 4*3 = 20, so the base is at x=80 and the shaft stops 40% into the head.
    expect(shape.head[1].x).toBeCloseTo(80);
    expect(shape.head[2].x).toBeCloseTo(80);
    expect(shape.head[1].y).toBeCloseTo(-shape.head[2].y);
    expect(shape.shaftEnd.x).toBeCloseTo(88);
  });

  it('has no shape for a zero-length arrow and never outgrows a short one', () => {
    expect(arrowShape(arrow({ x: 0.2, y: 0.2 }))).toBeNull();
    const short = arrowShape(arrow({ x: 6, y: 0 }))!;
    expect(short.head[1].x).toBeGreaterThanOrEqual(0);
  });

  it('points along any direction', () => {
    const shape = arrowShape(arrow({ x: 0, y: 100 }))!;
    expect(shape.head[0]).toEqual({ x: 0, y: 100 });
    expect(shape.head[1].y).toBeCloseTo(80);
    expect(shape.head[1].x).toBeCloseTo(-shape.head[2].x);
  });
});

describe('drawImageEdits', () => {
  function fakeContext() {
    const calls: string[] = [];
    const record = (name: string) => (...args: unknown[]) => void calls.push(`${name}(${args.join(',')})`);
    const target = new Proxy({}, {
      get: (_t, property: string) => (['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'stroke', 'fill', 'fillText', 'strokeText', 'roundRect', 'ellipse', 'arc'].includes(property) ? record(property) : undefined),
      set: (_t, property: string, value) => { calls.push(`${property}=${String(value)}`); return true; },
    });
    return { ctx: target as unknown as OffscreenCanvasRenderingContext2D, calls };
  }

  it('paints edits in order at device pixel scale, each inside save/restore', () => {
    const { ctx, calls } = fakeContext();
    const edits: ImageEdit[] = [
      { id: 'r', kind: 'rect', bounds: { x: 1, y: 2, width: 3, height: 4 }, width: 2, fill: 'none' as const, color: '#ff4747' },
      { id: 't', kind: 'text', bounds: { x: 5, y: 6, width: 100, height: 20 }, text: 'Hi', fontSize: 10, look: 'plain' as const, color: '#111111' },
    ];
    drawImageEdits(ctx, edits, 2, measure);

    const rectCall = calls.find((call) => call.startsWith('roundRect(2,4,6,8,'))!;
    expect(rectCall).toBeDefined();
    expect(calls).toContain('lineWidth=4');
    expect(calls).toContain('strokeStyle=#ff4747');
    const textCall = calls.find((call) => call.startsWith('fillText('))!;
    expect(textCall.startsWith('fillText(Hi,10,')).toBe(true);
    expect(calls.indexOf(rectCall)).toBeLessThan(calls.indexOf(textCall));
    expect(calls.filter((call) => call === 'save()')).toHaveLength(2);
    expect(calls.filter((call) => call === 'restore()')).toHaveLength(2);
  });

  it('skips a degenerate arrow without throwing', () => {
    const { ctx, calls } = fakeContext();
    expect(() => drawImageEdits(ctx, [{ id: 'a', kind: 'arrow', from: { x: 1, y: 1 }, to: { x: 1, y: 1 }, width: 2, color: '#ff4747' }], 1, vi.fn())).not.toThrow();
    expect(calls.some((call) => call.startsWith('fill'))).toBe(false);
  });
});

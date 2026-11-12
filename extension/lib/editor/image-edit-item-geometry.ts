import type { Bounds } from '@/lib/storage/models';
import type { TextEdit } from '@/lib/storage/image-edit-model';
import { measureTextEditHeight, measureTextWidth, type TextMeasure } from '@/lib/media/image-edit-render';
import { highlightFrame } from '@/lib/media/annotation-geometry';
import { moveBounds, resizeBounds, resizeBoundsKeepRatio, snapToAngle, type ResizeHandle } from './image-edit-geometry';
import type { ImageEditItem } from './image-edit-items';
import { clamp, roundHundredths, type Point, type Size } from '@/lib/shared/geometry';

/** Per-kind move/resize rules, so the edit layer treats every item the same way. */

/** A text box never gets narrower than this many CSS px (a few characters). */
export const MIN_TEXT_WIDTH = 24;
/** Shortest arrow worth keeping; anything shorter is a stray click. */
export const MIN_ARROW_LENGTH = 8;

/** An arrow's two ends are its handles; boxes use the eight edge handles; text only resizes its width; markers have none. */
export type ItemHandle = ResizeHandle | 'from' | 'to';

const BOX_HANDLES: readonly ItemHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const TEXT_HANDLES: readonly ItemHandle[] = ['w', 'e'];
const ARROW_HANDLES: readonly ItemHandle[] = ['from', 'to'];
const NO_HANDLES: readonly ItemHandle[] = [];

export function itemHandles(item: ImageEditItem): readonly ItemHandle[] {
  if (item.kind === 'arrow') return ARROW_HANDLES;
  if (item.kind === 'text') return TEXT_HANDLES;
  if (item.kind === 'step') return NO_HANDLES;
  return BOX_HANDLES;
}

/** The box an item occupies, for its selection frame and for keeping it inside the image.
 * A recorded box is stored around its target and drawn padded out from it, so it is framed where it is drawn. */
export function itemBounds(item: ImageEditItem): Bounds {
  if (item.kind === 'highlight') return highlightFrame(item.bounds);
  if (item.kind === 'arrow') {
    const x = Math.min(item.from.x, item.to.x);
    const y = Math.min(item.from.y, item.to.y);
    return {
      x,
      y,
      width: Math.max(Math.abs(item.to.x - item.from.x), 1),
      height: Math.max(Math.abs(item.to.y - item.from.y), 1),
    };
  }
  if (item.kind === 'step') {
    return {
      x: item.center.x - item.radius,
      y: item.center.y - item.radius,
      width: item.radius * 2,
      height: item.radius * 2,
    };
  }
  return item.bounds;
}

/** The text box height that fits its content at the current width and size. */
export function fitTextHeight<T extends TextEdit>(edit: T, measure: TextMeasure = measureTextWidth): T {
  const height = roundHundredths(
    Math.max(
      measureTextEditHeight({ text: edit.text || ' ', fontSize: edit.fontSize, width: edit.bounds.width }, measure),
      edit.fontSize,
    ),
  );
  return height === edit.bounds.height ? edit : { ...edit, bounds: { ...edit.bounds, height } };
}

/** Moves an item, keeping all of it inside the image. */
export function translateItem(item: ImageEditItem, dx: number, dy: number, size: Size): ImageEditItem {
  const box = itemBounds(item);
  const moveX = roundHundredths(clamp(dx, -box.x, Math.max(size.width - (box.x + box.width), -box.x)));
  const moveY = roundHundredths(clamp(dy, -box.y, Math.max(size.height - (box.y + box.height), -box.y)));
  if (item.kind === 'arrow') {
    return {
      ...item,
      from: { x: roundHundredths(item.from.x + moveX), y: roundHundredths(item.from.y + moveY) },
      to: { x: roundHundredths(item.to.x + moveX), y: roundHundredths(item.to.y + moveY) },
    };
  }
  if (item.kind === 'step')
    return {
      ...item,
      center: { x: roundHundredths(item.center.x + moveX), y: roundHundredths(item.center.y + moveY) },
    };
  if (item.kind === 'highlight') {
    return {
      ...item,
      bounds: { ...item.bounds, x: roundHundredths(item.bounds.x + moveX), y: roundHundredths(item.bounds.y + moveY) },
    };
  }
  return { ...item, bounds: moveBounds(item.bounds, dx, dy, size) };
}

function movePoint(point: Point, dx: number, dy: number, size: Size): Point {
  return {
    x: roundHundredths(clamp(point.x + dx, 0, size.width)),
    y: roundHundredths(clamp(point.y + dy, 0, size.height)),
  };
}

function resizeTextWidth(edit: TextEdit, handle: ItemHandle, dx: number, size: Size, measure: TextMeasure): TextEdit {
  let left = edit.bounds.x;
  let right = edit.bounds.x + edit.bounds.width;
  if (handle === 'w') left = clamp(left + dx, 0, right - MIN_TEXT_WIDTH);
  if (handle === 'e') right = clamp(right + dx, left + MIN_TEXT_WIDTH, size.width);
  return fitTextHeight(
    { ...edit, bounds: { ...edit.bounds, x: roundHundredths(left), width: roundHundredths(right - left) } },
    measure,
  );
}

export interface ResizeOptions {
  /** Shift: corner drags keep the box's proportions, arrow ends snap to 45 degrees. */
  constrain?: boolean;
  measure?: TextMeasure;
}

/** Drags one handle by (dx, dy) from the item's state when the drag began. */
export function resizeItem(
  item: ImageEditItem,
  handle: ItemHandle,
  dx: number,
  dy: number,
  size: Size,
  { constrain = false, measure = measureTextWidth }: ResizeOptions = {},
): ImageEditItem {
  if (item.kind === 'arrow') {
    if (handle !== 'from' && handle !== 'to') return item;
    const moved = movePoint(handle === 'from' ? item.from : item.to, dx, dy, size);
    const fixed = handle === 'from' ? item.to : item.from;
    const end = constrain ? snapToAngle(fixed, moved, size) : moved;
    return handle === 'from' ? { ...item, from: end } : { ...item, to: end };
  }
  if (handle === 'from' || handle === 'to' || item.kind === 'step') return item;
  if (item.kind === 'text') return resizeTextWidth(item, handle, dx, size, measure);
  const bounds = constrain
    ? resizeBoundsKeepRatio(item.bounds, handle, dx, dy, size)
    : resizeBounds(item.bounds, handle, dx, dy, size);
  return { ...item, bounds };
}

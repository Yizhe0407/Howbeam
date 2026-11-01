import type { ImageCssSize } from './image-edit-geometry';
import { translateItem } from './image-edit-item-geometry';
import { appendItem, newItemId, nextStepNumber, type ImageEditItem } from './image-edit-items';

/** How far a pasted or duplicated copy is offset from its original, so it doesn't hide it. */
export const PASTE_OFFSET = 16;

/** Items that can be copied: everything except the crop, of which there is only one, and recorded boxes, which belong to their steps. */
export const isCopyable = (item: ImageEditItem): boolean => item.kind !== 'crop' && item.kind !== 'highlight';

/**
 * Adds copies of `source` to the item list: new ids, shifted by `offset`
 * (kept inside the image), numbered markers taking the next free numbers.
 * Returns the new list and the copies, so the caller can select them.
 */
export function pasteItems(
  items: readonly ImageEditItem[],
  source: readonly ImageEditItem[],
  offset: number,
  size: ImageCssSize,
): { items: ImageEditItem[]; pasted: ImageEditItem[] } {
  let next = [...items];
  const pasted: ImageEditItem[] = [];
  for (const original of source.filter(isCopyable)) {
    const moved = translateItem({ ...original, id: newItemId() } as ImageEditItem, offset, offset, size);
    const copy = moved.kind === 'step' ? { ...moved, number: nextStepNumber(next) } : moved;
    next = appendItem(next, copy);
    pasted.push(copy);
  }
  return { items: next, pasted };
}

import type { Bounds, Redaction } from '@/lib/storage/models';
import type { ImageEdit } from '@/lib/storage/image-edit-model';
import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';

/**
 * Everything the image editor can place on a screenshot, as one list. Privacy
 * masks are stored in their own field (they have their own review rules and
 * always paint last); text, arrows and rectangles are `ImageEdit`s; the boxes
 * recorded with the screenshot live on their steps. This module
 * is the only place that converts between that storage and the flat list the
 * edit layer works with, so a new tool adds a kind here, a tool in
 * `image-edit-tools`, and geometry in `image-edit-item-geometry`.
 */
interface RedactionItem {
  id: string;
  kind: 'redaction';
  bounds: Bounds;
}

/** The crop, as an item so it shares selection, handles, undo and redo with everything else.
 * There is at most one, and it is stored in its own field rather than with the edits. */
export const CROP_ITEM_ID = 'crop';

interface CropItem {
  id: typeof CROP_ITEM_ID;
  kind: 'crop';
  bounds: Bounds;
}

/** A box recorded with the screenshot: an ordinary step's one box, or one per snapshot
 * annotation, numbered by position. Its id is the step that stores it. */
export interface HighlightItem {
  id: string;
  kind: 'highlight';
  bounds: Bounds;
}

export type Highlight = Pick<HighlightItem, 'id' | 'bounds'>;

export type ImageEditItem = RedactionItem | CropItem | HighlightItem | ImageEdit;
export type ImageEditItemKind = ImageEditItem['kind'];

/** Items in the order they are drawn: recorded boxes first, then the person's edits, masks last (always on top). */
export function toItems(
  redactions: readonly Redaction[],
  edits: readonly ImageEdit[],
  crop: Bounds | null = null,
  highlights: readonly Highlight[] = [],
): ImageEditItem[] {
  const cropItems: CropItem[] = crop ? [{ id: CROP_ITEM_ID, kind: 'crop', bounds: crop }] : [];
  return [
    ...cropItems,
    ...highlights.map(
      (highlight): HighlightItem => ({ id: highlight.id, kind: 'highlight', bounds: highlight.bounds }),
    ),
    ...edits,
    ...redactions.map(
      (redaction): RedactionItem => ({ id: redaction.id, kind: 'redaction', bounds: redaction.bounds }),
    ),
  ];
}

export interface SplitItems {
  redactions: Redaction[];
  imageEdits: ImageEdit[];
  crop: Bounds | null;
  /** The recorded boxes left, in numbering order. */
  highlights: Highlight[];
}

/** The inverse of `toItems`: items back into their stored fields, keeping relative order. */
export function splitItems(items: readonly ImageEditItem[]): SplitItems {
  const redactions: Redaction[] = [];
  const imageEdits: ImageEdit[] = [];
  const highlights: Highlight[] = [];
  let crop: Bounds | null = null;
  for (const item of items) {
    if (item.kind === 'redaction') redactions.push({ id: item.id, kind: 'solid', bounds: { ...item.bounds } });
    else if (item.kind === 'crop') crop = { ...item.bounds };
    else if (item.kind === 'highlight') highlights.push({ id: item.id, bounds: { ...item.bounds } });
    else imageEdits.push(item);
  }
  return { redactions, imageEdits, crop, highlights };
}

/** Drawn edits: everything the person added, as opposed to masks, the crop and recorded boxes. */
const isDrawnEdit = (item: ImageEditItem): boolean =>
  item.kind !== 'redaction' && item.kind !== 'crop' && item.kind !== 'highlight';

/** Keeps the draw order rule when something is added: masks stay last. A new crop replaces the old one. */
export function appendItem(items: readonly ImageEditItem[], item: ImageEditItem): ImageEditItem[] {
  if (item.kind === 'crop') return [item, ...items.filter((existing) => existing.kind !== 'crop')];
  if (item.kind === 'redaction') return [...items, item];
  const firstMask = items.findIndex((existing) => existing.kind === 'redaction');
  if (firstMask === -1) return [...items, item];
  return [...items.slice(0, firstMask), item, ...items.slice(firstMask)];
}

export function newItemId(): string {
  return crypto.randomUUID();
}

/** The number the next marker gets: one past the highest in use. */
export function nextStepNumber(items: readonly ImageEditItem[]): number {
  let highest = 0;
  for (const item of items) if (item.kind === 'step') highest = Math.max(highest, item.number);
  return Math.min(highest + 1, 999);
}

/** Moves an item to the front or back of its drawing group. Masks stay above every edit; the crop and recorded boxes never move. */
export function reorderItem(items: readonly ImageEditItem[], id: string, to: 'front' | 'back'): ImageEditItem[] {
  const item = items.find((candidate) => candidate.id === id);
  if (!item || item.kind === 'crop' || item.kind === 'highlight') return [...items];
  const group = (candidate: ImageEditItem): boolean =>
    candidate.kind !== 'highlight' &&
    candidate.kind !== 'crop' &&
    (candidate.kind === 'redaction') === (item.kind === 'redaction');
  const others = items.filter((candidate) => candidate.id !== id);
  const members = others.filter(group);
  const anchor = to === 'front' ? members.at(-1) : members[0];
  if (!anchor) return [...items];
  const at = others.indexOf(anchor);
  return [...others.slice(0, to === 'front' ? at + 1 : at), item, ...others.slice(to === 'front' ? at + 1 : at)];
}

/** What storage keeps per image: masks and drawn edits are limited separately, and there is only ever one crop. */
export const IMAGE_ITEM_LIMITS = Object.freeze({
  maxMasks: PERSISTED_STEP_LIMITS.maxRedactionsPerStep,
  maxEdits: PERSISTED_STEP_LIMITS.maxImageEditsPerStep,
});

export interface ItemRoom {
  /** More masks can be added. */
  masks: boolean;
  /** More text, arrows, boxes, ellipses or markers can be added. */
  edits: boolean;
}

/** Whether there is room for one more mask and one more drawn edit. */
export function itemRoom(items: readonly ImageEditItem[]): ItemRoom {
  let masks = 0;
  let edits = 0;
  for (const item of items) {
    if (item.kind === 'redaction') masks += 1;
    else if (isDrawnEdit(item)) edits += 1;
  }
  return { masks: masks < IMAGE_ITEM_LIMITS.maxMasks, edits: edits < IMAGE_ITEM_LIMITS.maxEdits };
}

/** Whether `added` fit next to `items` without going past a storage limit. A crop always fits: it replaces the old one. */
export function hasRoomFor(items: readonly ImageEditItem[], added: readonly ImageEditItem[]): boolean {
  const masks =
    items.filter((item) => item.kind === 'redaction').length + added.filter((item) => item.kind === 'redaction').length;
  const edits = items.filter(isDrawnEdit).length + added.filter(isDrawnEdit).length;
  return masks <= IMAGE_ITEM_LIMITS.maxMasks && edits <= IMAGE_ITEM_LIMITS.maxEdits;
}

/** Whether one more item of `kind` fits. */
export function roomForKind(kind: ImageEditItemKind, room: ItemRoom): boolean {
  if (kind === 'redaction') return room.masks;
  if (kind === 'crop' || kind === 'highlight') return true;
  return room.edits;
}

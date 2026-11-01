import type { ImageEdit, ImageEditColor, ShapeFill, TextLook } from '@/lib/storage/image-edit-model';
import { fitTextHeight } from './image-edit-item-geometry';
import type { ImageEditItem } from './image-edit-items';

/** How the next thing drawn will look; remembered across the session. */
export interface ImageEditStyle {
  color: ImageEditColor;
  /** Stroke of boxes, ellipses and arrows, in CSS px. */
  strokeWidth: number;
  fontSize: number;
  look: TextLook;
  fill: ShapeFill;
  /** Radius of numbered markers, in CSS px. */
  markerRadius: number;
}

export const DEFAULT_IMAGE_EDIT_STYLE: ImageEditStyle = {
  color: '#ff4747',
  strokeWidth: 4,
  fontSize: 24,
  look: 'outline',
  fill: 'none',
  markerRadius: 16,
};

/** The style controls an item offers, in the order they are shown. `number` only exists on a selected marker. */
export type StyleField = 'color' | 'width' | 'fontSize' | 'look' | 'fill' | 'radius' | 'number';

export const STYLE_FIELDS: Record<ImageEdit['kind'], readonly StyleField[]> = {
  text: ['color', 'look', 'fontSize'],
  arrow: ['color', 'width'],
  rect: ['color', 'width', 'fill'],
  ellipse: ['color', 'width', 'fill'],
  step: ['color', 'radius', 'number'],
};

/** What a patch may change on an item. `number` is per marker, so it is not part of the remembered style. */
export type StylePatch = Partial<ImageEditStyle> & { number?: number };

export function isStyledItem(item: ImageEditItem): item is ImageEdit {
  return item.kind !== 'redaction' && item.kind !== 'crop' && item.kind !== 'highlight';
}

/** Applies the parts of a patch that this kind of item has, leaving the rest alone. */
export function applyStylePatch<T extends ImageEdit>(item: T, patch: StylePatch): T {
  const next: ImageEdit = { ...item };
  if (patch.color !== undefined) next.color = patch.color;
  switch (next.kind) {
    case 'text': {
      if (patch.look !== undefined) next.look = patch.look;
      if (patch.fontSize !== undefined) next.fontSize = patch.fontSize;
      // Size and look change the laid-out height, so the box is refitted.
      return fitTextHeight(next) as unknown as T;
    }
    case 'arrow':
      if (patch.strokeWidth !== undefined) next.width = patch.strokeWidth;
      break;
    case 'rect':
    case 'ellipse':
      if (patch.strokeWidth !== undefined) next.width = patch.strokeWidth;
      if (patch.fill !== undefined) next.fill = patch.fill;
      break;
    case 'step':
      if (patch.markerRadius !== undefined) next.radius = patch.markerRadius;
      if (patch.number !== undefined) next.number = patch.number;
      break;
  }
  return next as T;
}

/** The style an item is showing, with `fallback` for the parts it does not have. */
export function styleOfItem(item: ImageEdit, fallback: ImageEditStyle): ImageEditStyle {
  switch (item.kind) {
    case 'text':
      return { ...fallback, color: item.color, fontSize: item.fontSize, look: item.look };
    case 'arrow':
      return { ...fallback, color: item.color, strokeWidth: item.width };
    case 'rect':
    case 'ellipse':
      return { ...fallback, color: item.color, strokeWidth: item.width, fill: item.fill };
    case 'step':
      return { ...fallback, color: item.color, markerRadius: item.radius };
  }
}

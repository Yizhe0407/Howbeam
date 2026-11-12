import type { Bounds, ImageEdit, Redaction } from '../storage/models';
import type { Annotation } from './annotation-contract';

/**
 * A crop does not change any stored coordinate. Everything drawn on the image
 * (highlights, masks, edits) keeps its original coordinates, and these helpers
 * express them relative to the cropped image by shifting them by the crop's
 * origin. With no crop the origin is zero and the inputs come back unchanged
 * (same identity), so previews don't re-render for nothing.
 */
export interface CropOrigin {
  x: number;
  y: number;
}

export const NO_CROP_ORIGIN: CropOrigin = Object.freeze({ x: 0, y: 0 });

const isZero = (origin: CropOrigin): boolean => origin.x === 0 && origin.y === 0;

const shiftBounds = (bounds: Bounds, origin: CropOrigin): Bounds => ({
  ...bounds,
  x: bounds.x - origin.x,
  y: bounds.y - origin.y,
});

export function offsetBounds(bounds: Bounds | null, origin: CropOrigin): Bounds | null {
  return bounds === null || isZero(origin) ? bounds : shiftBounds(bounds, origin);
}

export function offsetAnnotations(annotations: Annotation[], origin: CropOrigin): Annotation[] {
  return isZero(origin)
    ? annotations
    : annotations.map((annotation) => ({ ...annotation, bounds: shiftBounds(annotation.bounds, origin) }));
}

export function offsetRedactions(redactions: Redaction[], origin: CropOrigin): Redaction[] {
  return isZero(origin)
    ? redactions
    : redactions.map((redaction) => ({ ...redaction, bounds: shiftBounds(redaction.bounds, origin) }));
}

export function offsetImageEdits(edits: ImageEdit[], origin: CropOrigin): ImageEdit[] {
  if (isZero(origin)) return edits;
  return edits.map((edit): ImageEdit => {
    if (edit.kind === 'arrow') {
      return {
        ...edit,
        from: { x: edit.from.x - origin.x, y: edit.from.y - origin.y },
        to: { x: edit.to.x - origin.x, y: edit.to.y - origin.y },
      };
    }
    if (edit.kind === 'step') return { ...edit, center: { x: edit.center.x - origin.x, y: edit.center.y - origin.y } };
    return { ...edit, bounds: shiftBounds(edit.bounds, origin) };
  });
}

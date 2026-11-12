import { isIdentifier, isRecord } from '../shared/validation';
import { isPersistedPoint, isPersistedRect, PERSISTED_STEP_LIMITS } from './persistence-limits';
import { isStoredText } from './stored-text';
import type { Rect, Point } from '@/lib/shared/geometry';

/**
 * Things a person draws onto a screenshot in the image editor: text, arrows,
 * boxes, ellipses and numbered markers. They live on the step that owns the
 * image (the step itself, or a snapshot's shared anchor) in screenshot CSS
 * pixels, the same space as highlight bounds and privacy masks.
 *
 * Privacy masks are deliberately NOT part of this list. They have their own
 * field, their own fail-closed review state, and are always painted last so
 * nothing drawn here can ever show through a mask. The crop is separate too.
 */

/** Colours are `#rrggbb`. The editor offers a palette plus a free picker; the
 * stored value is always the plain hex, so it renders identically everywhere. */
export const IMAGE_EDIT_PRESET_COLORS = ['#ff4747', '#ffc800', '#22a559', '#2f6fed', '#111111', '#ffffff'] as const;
export type ImageEditColor = string;

/** Strokes (box and ellipse outlines, arrow shafts) in CSS px, text sizes in CSS px, marker radii in CSS px. */
export const IMAGE_EDIT_STROKE_WIDTHS = [2, 4, 6] as const;
export const IMAGE_EDIT_FONT_SIZES = [16, 24, 36, 56] as const;
export const IMAGE_EDIT_MARKER_RADII = [12, 16, 22] as const;

/** How text keeps its legibility on any background: nothing, or an outline in the contrasting colour. */
export const TEXT_LOOKS = ['plain', 'outline'] as const;
export type TextLook = (typeof TEXT_LOOKS)[number];

/** Whether a box or ellipse is just an outline or also lightly tinted inside. */
export const SHAPE_FILLS = ['none', 'tint'] as const;
export type ShapeFill = (typeof SHAPE_FILLS)[number];

export const IMAGE_EDIT_LIMITS = Object.freeze({
  minFontSize: 8,
  maxFontSize: 200,
  minStrokeWidth: 1,
  maxStrokeWidth: 40,
  minMarkerRadius: 6,
  maxMarkerRadius: 80,
  maxMarkerNumber: 999,
  maxTextLength: PERSISTED_STEP_LIMITS.maxImageEditTextLength,
  maxItems: PERSISTED_STEP_LIMITS.maxImageEditsPerStep,
  maxCoordinateMagnitude: PERSISTED_STEP_LIMITS.maxCoordinateMagnitude,
  maxBoundsDimension: PERSISTED_STEP_LIMITS.maxBoundsDimension,
  maxIdLength: PERSISTED_STEP_LIMITS.maxIdLength,
});

export interface TextEdit {
  id: string;
  kind: 'text';
  /** The text box: `width` is the wrap width, `height` the laid-out height at save time. */
  bounds: Rect;
  text: string;
  fontSize: number;
  color: ImageEditColor;
  look: TextLook;
}

export interface ArrowEdit {
  id: string;
  kind: 'arrow';
  from: Point;
  /** The arrow head is drawn here. */
  to: Point;
  width: number;
  color: ImageEditColor;
}

export interface RectEdit {
  id: string;
  kind: 'rect';
  bounds: Rect;
  width: number;
  color: ImageEditColor;
  fill: ShapeFill;
}

export interface EllipseEdit {
  id: string;
  kind: 'ellipse';
  /** The ellipse is inscribed in this box. */
  bounds: Rect;
  width: number;
  color: ImageEditColor;
  fill: ShapeFill;
}

/** A numbered marker, for walking through the steps of a screenshot. */
export interface StepMarkerEdit {
  id: string;
  kind: 'step';
  center: Point;
  radius: number;
  number: number;
  color: ImageEditColor;
}

export type ImageEdit = TextEdit | ArrowEdit | RectEdit | EllipseEdit | StepMarkerEdit;

const isEditBounds = isPersistedRect;
const isEditPoint = isPersistedPoint;

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export const isImageEditColor = (value: unknown): value is ImageEditColor =>
  typeof value === 'string' && HEX_COLOR.test(value);

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

const isStrokeWidth = (value: unknown): value is number =>
  inRange(value, IMAGE_EDIT_LIMITS.minStrokeWidth, IMAGE_EDIT_LIMITS.maxStrokeWidth);

const isFontSize = (value: unknown): value is number =>
  inRange(value, IMAGE_EDIT_LIMITS.minFontSize, IMAGE_EDIT_LIMITS.maxFontSize);

const isEditId = isIdentifier;

export const isTextLook = (value: unknown): value is TextLook =>
  typeof value === 'string' && (TEXT_LOOKS as readonly string[]).includes(value);

export const isShapeFill = (value: unknown): value is ShapeFill =>
  typeof value === 'string' && (SHAPE_FILLS as readonly string[]).includes(value);

/** Strict shape check, used on every boundary (storage, archive, render). */
export function isValidImageEdit(value: unknown): value is ImageEdit {
  if (!isRecord(value) || !isEditId(value.id) || !isImageEditColor(value.color)) return false;
  switch (value.kind) {
    case 'text':
      return (
        isEditBounds(value.bounds) &&
        typeof value.text === 'string' &&
        value.text.length > 0 &&
        value.text.length <= IMAGE_EDIT_LIMITS.maxTextLength &&
        isStoredText(value.text) &&
        isFontSize(value.fontSize) &&
        isTextLook(value.look)
      );
    case 'arrow':
      return isEditPoint(value.from) && isEditPoint(value.to) && isStrokeWidth(value.width);
    case 'rect':
    case 'ellipse':
      return isEditBounds(value.bounds) && isStrokeWidth(value.width) && isShapeFill(value.fill);
    case 'step':
      return (
        isEditPoint(value.center) &&
        inRange(value.radius, IMAGE_EDIT_LIMITS.minMarkerRadius, IMAGE_EDIT_LIMITS.maxMarkerRadius) &&
        Number.isInteger(value.number) &&
        inRange(value.number, 1, IMAGE_EDIT_LIMITS.maxMarkerNumber)
      );
    default:
      return false;
  }
}

/** Copies only the known fields, so nothing unexpected can ride along into storage or an archive. */
export function cloneImageEdit(edit: ImageEdit): ImageEdit {
  switch (edit.kind) {
    case 'text':
      return {
        id: edit.id,
        kind: 'text',
        bounds: { ...edit.bounds },
        text: edit.text,
        fontSize: edit.fontSize,
        color: edit.color,
        look: edit.look,
      };
    case 'arrow':
      return {
        id: edit.id,
        kind: 'arrow',
        from: { ...edit.from },
        to: { ...edit.to },
        width: edit.width,
        color: edit.color,
      };
    case 'rect':
      return {
        id: edit.id,
        kind: 'rect',
        bounds: { ...edit.bounds },
        width: edit.width,
        color: edit.color,
        fill: edit.fill,
      };
    case 'ellipse':
      return {
        id: edit.id,
        kind: 'ellipse',
        bounds: { ...edit.bounds },
        width: edit.width,
        color: edit.color,
        fill: edit.fill,
      };
    case 'step':
      return {
        id: edit.id,
        kind: 'step',
        center: { ...edit.center },
        radius: edit.radius,
        number: edit.number,
        color: edit.color,
      };
  }
}

/** The usable edits of a stored value: anything malformed or duplicated is left out rather than drawn. */
export function readImageEdits(raw: unknown): ImageEdit[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const edits: ImageEdit[] = [];
  for (const item of raw as unknown[]) {
    if (!isValidImageEdit(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    edits.push(cloneImageEdit(item));
    if (edits.length >= IMAGE_EDIT_LIMITS.maxItems) break;
  }
  return edits;
}

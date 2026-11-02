import {
  type ArrowEdit,
  type EditBounds,
  type EditPoint,
  type EllipseEdit,
  type ImageEdit,
  type ImageEditColor,
  type RectEdit,
  type StepMarkerEdit,
  type TextEdit,
} from '../storage/image-edit-model';
import { BADGE_FONT_FAMILY } from './annotation-contract';

/**
 * One definition of how image edits look, shared by the live preview (SVG) and
 * the exported raster (canvas). Everything that decides *where* something goes
 * or *how it is styled* (text wrapping, arrow head, rounded corners, shadows,
 * contrast colours) is computed here, in screenshot CSS pixels, so the two
 * renderers can only differ in the final draw calls.
 */

export const IMAGE_EDIT_FONT_FAMILY = BADGE_FONT_FAMILY;
export const IMAGE_EDIT_FONT_WEIGHT = 600;
const LINE_HEIGHT_RATIO = 1.3;

/** Corner radius of drawn boxes, in CSS px (never more than half the shorter side). */
const RECT_CORNER_RADIUS = 6;
/** Opacity of the tint inside a box or ellipse. */
export const TINT_ALPHA = 0.16;

/** A soft shadow under every drawn mark lifts it off any background, light or dark. */
export const EDIT_SHADOW = Object.freeze({ color: 'rgba(0, 0, 0, 0.35)', blur: 3, offsetY: 1 });

const DARK_INK = '#111111';
const LIGHT_INK = '#ffffff';

/** Relative luminance of a `#rrggbb` colour (WCAG), 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The ink that stays readable on `hex`: dark on light colours, white on dark ones. */
export function contrastColor(hex: ImageEditColor): string {
  return luminance(hex) > 0.4 ? DARK_INK : LIGHT_INK;
}

/** `#rrggbb` as an `rgba()` string. */
export function withAlpha(hex: ImageEditColor, alpha: number): string {
  const channel = (offset: number): number => parseInt(hex.slice(offset, offset + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${alpha})`;
}

export type TextMeasure = (text: string, fontSize: number) => number;

let measureContext: { font: string; measureText(text: string): { width: number } } | null | undefined;

function ensureMeasureContext() {
  if (measureContext !== undefined) return measureContext;
  measureContext = null;
  try {
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(1, 1)
      : typeof document !== 'undefined' ? document.createElement('canvas') : null;
    measureContext = (canvas?.getContext('2d') as typeof measureContext) ?? null;
  } catch {
    measureContext = null;
  }
  return measureContext;
}

/** Measures with the real canvas font engine. Where no canvas exists (some test
 * environments) it falls back to a width estimate, so layout still terminates. */
export const measureTextWidth: TextMeasure = (text, fontSize) => {
  const context = ensureMeasureContext();
  if (!context) return text.length * fontSize * 0.6;
  context.font = `${IMAGE_EDIT_FONT_WEIGHT} ${fontSize}px ${IMAGE_EDIT_FONT_FAMILY}`;
  return context.measureText(text).width;
};

export function textLineHeight(fontSize: number): number {
  return fontSize * LINE_HEIGHT_RATIO;
}

/** Distance from the top of a line box to its text baseline. */
export function textBaselineOffset(fontSize: number): number {
  return (textLineHeight(fontSize) - fontSize) / 2 + fontSize * 0.8;
}

/** Wraps `text` into lines no wider than `maxWidth`: at spaces where there are
 * any, otherwise between characters (CJK text has no spaces). Explicit line
 * breaks are kept. A single character wider than the box still gets its own line. */
export function layoutTextLines(text: string, fontSize: number, maxWidth: number, measure: TextMeasure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let line = '';
    let breakAt = -1;
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line !== '' && measure(candidate.trimEnd(), fontSize) > maxWidth) {
        if (breakAt > 0) {
          lines.push(line.slice(0, breakAt).trimEnd());
          line = line.slice(breakAt) + character;
        } else {
          lines.push(line);
          line = character;
        }
        breakAt = line.lastIndexOf(' ') + 1 || -1;
      } else {
        line = candidate;
        if (character === ' ') breakAt = line.length;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The height a text edit's box needs for its content. */
export function measureTextEditHeight(edit: Pick<TextEdit, 'text' | 'fontSize'> & { width: number }, measure: TextMeasure = measureTextWidth): number {
  return layoutTextLines(edit.text, edit.fontSize, edit.width, measure).length * textLineHeight(edit.fontSize);
}

export interface ArrowShape {
  /** Where the shaft stops, tucked under the head so there is no gap. */
  shaftEnd: EditPoint;
  /** Triangle tip, then the two base corners. */
  head: [EditPoint, EditPoint, EditPoint];
}

/** Arrow head proportions grow with the stroke so thick arrows keep a visible head. */
export function arrowShape(edit: Pick<ArrowEdit, 'from' | 'to' | 'width'>): ArrowShape | null {
  const dx = edit.to.x - edit.from.x;
  const dy = edit.to.y - edit.from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  const ux = dx / length;
  const uy = dy / length;
  const headLength = Math.min(length, 8 + edit.width * 3);
  const halfWidth = headLength * 0.45;
  const baseX = edit.to.x - ux * headLength;
  const baseY = edit.to.y - uy * headLength;
  return {
    shaftEnd: { x: baseX + ux * headLength * 0.4, y: baseY + uy * headLength * 0.4 },
    head: [
      { x: edit.to.x, y: edit.to.y },
      { x: baseX - uy * halfWidth, y: baseY + ux * halfWidth },
      { x: baseX + uy * halfWidth, y: baseY - ux * halfWidth },
    ],
  };
}

/** Corner radius for a box of this size. */
export function rectCornerRadius(bounds: Pick<EditBounds, 'width' | 'height'>): number {
  return Math.max(Math.min(RECT_CORNER_RADIUS, bounds.width / 2, bounds.height / 2), 0);
}

/** Everything needed to paint one text edit, independent of how it is painted. */
export interface TextPlacement {
  lines: { text: string; baselineY: number }[];
  x: number;
  /** Width of the outline stroke drawn behind the glyphs, or null for none. */
  outlineWidth: number | null;
  outlineColor: string;
}

export function placeText(edit: TextEdit, measure: TextMeasure = measureTextWidth): TextPlacement {
  const lineHeight = textLineHeight(edit.fontSize);
  const offset = textBaselineOffset(edit.fontSize);
  const lineTexts = layoutTextLines(edit.text, edit.fontSize, edit.bounds.width, measure);
  const ink = contrastColor(edit.color);
  return {
    x: edit.bounds.x,
    lines: lineTexts.map((text, index) => ({ text, baselineY: edit.bounds.y + index * lineHeight + offset })),
    outlineWidth: edit.look === 'outline' ? Math.max(2, edit.fontSize * 0.16) : null,
    outlineColor: ink,
  };
}

export interface MarkerGeometry {
  /** Radius of the filled disc inside the ring. */
  innerRadius: number;
  ringWidth: number;
  ringColor: string;
  digitColor: string;
  fontSize: number;
  /** Baseline that centres the digits vertically on the disc. */
  baselineY: number;
}

export function markerGeometry(edit: StepMarkerEdit): MarkerGeometry {
  const ringWidth = Math.max(2, edit.radius * 0.14);
  const fontSize = edit.radius * (edit.number > 99 ? 0.82 : edit.number > 9 ? 0.98 : 1.1);
  return {
    innerRadius: edit.radius - ringWidth,
    ringWidth,
    ringColor: contrastColor(edit.color),
    digitColor: contrastColor(edit.color),
    fontSize,
    baselineY: edit.center.y + fontSize * 0.36,
  };
}

type Canvas2D = OffscreenCanvasRenderingContext2D;

function applyShadow(ctx: Canvas2D, dpr: number) {
  ctx.shadowColor = EDIT_SHADOW.color;
  ctx.shadowBlur = EDIT_SHADOW.blur * dpr;
  ctx.shadowOffsetY = EDIT_SHADOW.offsetY * dpr;
}

function clearShadow(ctx: Canvas2D) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawRect(ctx: Canvas2D, edit: RectEdit, dpr: number) {
  const { x, y, width, height } = edit.bounds;
  applyShadow(ctx, dpr);
  ctx.beginPath();
  ctx.roundRect(x * dpr, y * dpr, width * dpr, height * dpr, rectCornerRadius(edit.bounds) * dpr);
  if (edit.fill === 'tint') {
    ctx.fillStyle = withAlpha(edit.color, TINT_ALPHA);
    ctx.fill();
  }
  ctx.strokeStyle = edit.color;
  ctx.lineWidth = edit.width * dpr;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawEllipse(ctx: Canvas2D, edit: EllipseEdit, dpr: number) {
  const { x, y, width, height } = edit.bounds;
  applyShadow(ctx, dpr);
  ctx.beginPath();
  ctx.ellipse((x + width / 2) * dpr, (y + height / 2) * dpr, (width / 2) * dpr, (height / 2) * dpr, 0, 0, Math.PI * 2);
  if (edit.fill === 'tint') {
    ctx.fillStyle = withAlpha(edit.color, TINT_ALPHA);
    ctx.fill();
  }
  ctx.strokeStyle = edit.color;
  ctx.lineWidth = edit.width * dpr;
  ctx.stroke();
}

function drawArrow(ctx: Canvas2D, edit: ArrowEdit, dpr: number) {
  const shape = arrowShape(edit);
  if (!shape) return;
  applyShadow(ctx, dpr);
  ctx.strokeStyle = edit.color;
  ctx.fillStyle = edit.color;
  ctx.lineWidth = edit.width * dpr;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(edit.from.x * dpr, edit.from.y * dpr);
  ctx.lineTo(shape.shaftEnd.x * dpr, shape.shaftEnd.y * dpr);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(shape.head[0].x * dpr, shape.head[0].y * dpr);
  ctx.lineTo(shape.head[1].x * dpr, shape.head[1].y * dpr);
  ctx.lineTo(shape.head[2].x * dpr, shape.head[2].y * dpr);
  ctx.closePath();
  ctx.fill();
}

function drawText(ctx: Canvas2D, edit: TextEdit, dpr: number, measure: TextMeasure) {
  const placement = placeText(edit, measure);
  ctx.font = `${IMAGE_EDIT_FONT_WEIGHT} ${edit.fontSize * dpr}px ${IMAGE_EDIT_FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = edit.color;
  if (placement.outlineWidth !== null) {
    // The outline silhouette carries the shadow; the glyphs on top add none, so it isn't doubled.
    applyShadow(ctx, dpr);
    ctx.lineJoin = 'round';
    ctx.lineWidth = placement.outlineWidth * dpr;
    ctx.strokeStyle = placement.outlineColor;
    for (const line of placement.lines) ctx.strokeText(line.text, placement.x * dpr, line.baselineY * dpr);
    clearShadow(ctx);
  } else {
    applyShadow(ctx, dpr);
  }
  for (const line of placement.lines) ctx.fillText(line.text, placement.x * dpr, line.baselineY * dpr);
}

function drawMarker(ctx: Canvas2D, edit: StepMarkerEdit, dpr: number) {
  const geometry = markerGeometry(edit);
  applyShadow(ctx, dpr);
  ctx.beginPath();
  ctx.arc(edit.center.x * dpr, edit.center.y * dpr, edit.radius * dpr, 0, Math.PI * 2);
  ctx.fillStyle = geometry.ringColor;
  ctx.fill();
  clearShadow(ctx);
  ctx.beginPath();
  ctx.arc(edit.center.x * dpr, edit.center.y * dpr, geometry.innerRadius * dpr, 0, Math.PI * 2);
  ctx.fillStyle = edit.color;
  ctx.fill();
  ctx.fillStyle = geometry.digitColor;
  ctx.font = `700 ${geometry.fontSize * dpr}px ${IMAGE_EDIT_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(edit.number), edit.center.x * dpr, geometry.baselineY * dpr);
}

/** Paints the edits in order (later ones on top) onto an already-drawn screenshot. */
export function drawImageEdits(
  ctx: Canvas2D,
  edits: readonly ImageEdit[],
  dpr: number,
  measure: TextMeasure = measureTextWidth,
): void {
  for (const edit of edits) {
    ctx.save();
    switch (edit.kind) {
      case 'rect': drawRect(ctx, edit, dpr); break;
      case 'ellipse': drawEllipse(ctx, edit, dpr); break;
      case 'arrow': drawArrow(ctx, edit, dpr); break;
      case 'text': drawText(ctx, edit, dpr, measure); break;
      case 'step': drawMarker(ctx, edit, dpr); break;
    }
    ctx.restore();
  }
}

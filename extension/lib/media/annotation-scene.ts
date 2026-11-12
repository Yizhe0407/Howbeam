import type { Bounds, ImageEdit, Redaction } from '../storage/models';
import { drawImageEdits, type Canvas2D } from './image-edit-render';
import { isPositiveRect } from '../shared/geometry';
import {
  BADGE_FONT_FAMILY,
  BADGE_RADIUS,
  BADGE_TEXT_COLOR,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_RADIUS,
  LEADER_LINE_WIDTH,
  MARKER_INNER_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
  REDACTION_COLOR,
  REDACTION_EXPANSION,
  isDrawableHighlightFrame,
  type Annotation,
} from './annotation-contract';
import { fitHighlightFrame, getBadgeFontSize } from './annotation-geometry';
import { layoutAnnotations } from './annotation-layout';
import type { Point } from '@/lib/shared/geometry';

/**
 * Everything drawn over a screenshot, in screenshot CSS pixels. The editor's
 * previews and every export draw it with {@link drawAnnotationScene}, so what
 * the editor shows is what an export contains.
 */
export interface AnnotationScene {
  /** A step's highlight box. */
  highlight: Bounds | null;
  /** A snapshot's numbered marks. */
  annotations: readonly Annotation[];
  /** False drops the mark numbers and their leader lines (previews too small to read them). */
  badges: boolean;
  /** The person's own text, arrows and shapes, above the automatic highlights. */
  imageEdits: readonly ImageEdit[];
  /** Opaque masks, above everything else. */
  redactions: readonly Redaction[];
  /** Privacy review pending: nothing of the screenshot may show. */
  privacyBlock: boolean;
}

export interface SceneSurface {
  /** Screenshot pixels per CSS pixel. */
  dpr: number;
  /** The screenshot's size in CSS pixels. */
  viewportWidth: number;
  viewportHeight: number;
  /**
   * How many screenshot pixels one on-screen pixel spans, for a preview shown
   * smaller than the screenshot: marks never shrink below a readable size. 0
   * (an export) draws everything at its exact size.
   */
  screenPixel?: number;
}

/** Returns a redaction's expanded CSS-pixel rect clipped to the screenshot.
 * `null` means the mask lies wholly outside the drawable bitmap. */
export function getExpandedRedactionBounds(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
): Bounds | null {
  if (
    !isPositiveRect(bounds) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return null;
  }
  const left = Math.max(0, bounds.x - REDACTION_EXPANSION);
  const top = Math.max(0, bounds.y - REDACTION_EXPANSION);
  const right = Math.min(viewportWidth, bounds.x + bounds.width + REDACTION_EXPANSION);
  const bottom = Math.min(viewportHeight, bounds.y + bounds.height + REDACTION_EXPANSION);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Sizes in screenshot pixels, never below `minimum` on-screen pixels. */
function sizer({ dpr, screenPixel = 0 }: SceneSurface) {
  return (css: number, minimum: number) => Math.max(css * dpr, minimum * screenPixel);
}

function strokeBox(ctx: Canvas2D, bounds: Bounds, surface: SceneSurface) {
  // Clamped-to-edge degenerate frames would paint a stray hairline.
  if (!isDrawableHighlightFrame(bounds)) return;
  const { dpr } = surface;
  const lineWidth = sizer(surface)(HIGHLIGHT_LINE_WIDTH, 1);
  const outerX = bounds.x * dpr;
  const outerY = bounds.y * dpr;
  const outerWidth = bounds.width * dpr;
  const outerHeight = bounds.height * dpr;
  const outerRadius = Math.max(Math.min(HIGHLIGHT_RADIUS * dpr, outerWidth / 2, outerHeight / 2), 0);

  ctx.fillStyle = HIGHLIGHT_FILL_COLOR;
  ctx.beginPath();
  ctx.roundRect(outerX, outerY, outerWidth, outerHeight, outerRadius);
  ctx.fill();

  // The stroke sits inside the frame, like a border.
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.roundRect(
    outerX + lineWidth / 2,
    outerY + lineWidth / 2,
    Math.max(outerWidth - lineWidth, 0),
    Math.max(outerHeight - lineWidth, 0),
    Math.max(outerRadius - lineWidth / 2, 0),
  );
  ctx.stroke();
}

function markerRadius(surface: SceneSurface): number {
  return sizer(surface)(MARKER_RADIUS, 5);
}

function badgeRadius(surface: SceneSurface): number {
  return sizer(surface)(BADGE_RADIUS, 7);
}

function strokeTarget(ctx: Canvas2D, anchor: Point, surface: SceneSurface) {
  const { dpr } = surface;
  const x = anchor.x * dpr;
  const y = anchor.y * dpr;
  const radius = markerRadius(surface);
  const ring = Math.max(radius * (MARKER_RING_WIDTH / MARKER_RADIUS), surface.screenPixel ?? 0);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  // The ring lies wholly inside the marker's outer edge.
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = ring;
  ctx.beginPath();
  ctx.arc(x, y, radius - ring / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = HIGHLIGHT_COLOR;
  ctx.beginPath();
  ctx.arc(x, y, radius * (MARKER_INNER_RADIUS / MARKER_RADIUS), 0, Math.PI * 2);
  ctx.fill();
}

function drawBadge(ctx: Canvas2D, point: Point, order: number, surface: SceneSurface) {
  const { dpr } = surface;
  const r = badgeRadius(surface);
  const cx = point.x * dpr;
  const cy = point.y * dpr;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
  ctx.shadowBlur = 3 * dpr;
  ctx.shadowOffsetY = 1 * dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = HIGHLIGHT_COLOR;
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.font = `600 ${getBadgeFontSize(order, (r * 2) / dpr) * dpr}px ${BADGE_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  // Centered by the digits' own glyph box, not the font's line box.
  ctx.textBaseline = 'alphabetic';
  const text = String(order);
  const metrics = ctx.measureText(text);
  ctx.fillText(text, cx, cy + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
}

/** The leader runs between the marker's and the badge's edges. */
function drawLeader(ctx: Canvas2D, from: Point, to: Point, surface: SceneSurface) {
  const { dpr } = surface;
  const dx = (to.x - from.x) * dpr;
  const dy = (to.y - from.y) * dpr;
  const length = Math.hypot(dx, dy);
  const start = markerRadius(surface);
  const end = badgeRadius(surface);
  if (length <= start + end) return;
  const ux = dx / length;
  const uy = dy / length;
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = sizer(surface)(LEADER_LINE_WIDTH, 1);
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(from.x * dpr + ux * start, from.y * dpr + uy * start);
  ctx.lineTo(to.x * dpr - ux * end, to.y * dpr - uy * end);
  ctx.stroke();
}

function drawAnnotations(ctx: Canvas2D, annotations: readonly Annotation[], badges: boolean, surface: SceneSurface) {
  for (const layout of layoutAnnotations([...annotations], surface.viewportWidth, surface.viewportHeight)) {
    if (layout.markerOnly) strokeTarget(ctx, layout.anchor, surface);
    else strokeBox(ctx, layout.frame, surface);
    if (!badges) continue;
    if (layout.callout) drawLeader(ctx, layout.anchor, layout.callout, surface);
    drawBadge(ctx, layout.callout ?? layout.badgeAnchor, layout.order, surface);
  }
}

/**
 * Draws a scene over a screenshot already painted at (0, 0), in this strict
 * order: highlights, the person's drawings, masks. Masks come last because
 * they are privacy-critical and must cover everything beneath them.
 */
export function drawAnnotationScene(ctx: Canvas2D, scene: AnnotationScene, surface: SceneSurface): void {
  const { dpr, viewportWidth, viewportHeight } = surface;
  if (scene.privacyBlock) {
    ctx.fillStyle = REDACTION_COLOR;
    ctx.fillRect(0, 0, viewportWidth * dpr, viewportHeight * dpr);
    return;
  }
  if (scene.highlight) strokeBox(ctx, fitHighlightFrame(scene.highlight, viewportWidth, viewportHeight), surface);
  if (scene.annotations.length > 0) drawAnnotations(ctx, scene.annotations, scene.badges, surface);
  drawImageEdits(ctx, scene.imageEdits, dpr);
  ctx.fillStyle = REDACTION_COLOR;
  for (const redaction of scene.redactions) {
    const bounds = getExpandedRedactionBounds(redaction.bounds, viewportWidth, viewportHeight);
    if (bounds) ctx.fillRect(bounds.x * dpr, bounds.y * dpr, bounds.width * dpr, bounds.height * dpr);
  }
}

/** Whether drawing the scene would change any pixel. */
export function isEmptyScene(scene: AnnotationScene): boolean {
  return (
    !scene.privacyBlock &&
    !scene.highlight &&
    scene.annotations.length === 0 &&
    scene.imageEdits.length === 0 &&
    scene.redactions.length === 0
  );
}

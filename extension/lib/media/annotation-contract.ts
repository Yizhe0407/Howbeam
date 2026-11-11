import type { Bounds } from '../storage/models';
import { palette } from '../shared/design-tokens';

export const HIGHLIGHT_PADDING = 8;
export const HIGHLIGHT_RADIUS = 8;
export const HIGHLIGHT_LINE_WIDTH = 4;
export const HIGHLIGHT_COLOR = palette.mark;
export const HIGHLIGHT_FILL_COLOR = palette.markFill;
export const HIGHLIGHT_PREVIEW_FILL_COLOR = palette.markPreviewFill;
export const REDACTION_EXPANSION = 2;
export const REDACTION_COLOR = palette.mask;
export const BADGE_RADIUS = 11;
/** Center-to-center distance between adjacent lane badges. Lane-capacity math
 * and the callout candidate grid both assume this exact value. */
export const CALLOUT_SPACING = BADGE_RADIUS * 2 + 6;
export const BADGE_FONT_RATIO = 0.55;
export const BADGE_TEXT_COLOR = '#ffffff';
export const BADGE_FONT_FAMILY =
  'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
export const LEADER_LINE_WIDTH = 1.5;
export const MARKER_RADIUS = 6;
export const MARKER_RING_WIDTH = 2;
export const MARKER_INNER_RADIUS = MARKER_RADIUS * 0.4;

/**
 * Whether a highlight frame is worth stroking at all. fitBoundsInViewport
 * legitimately clamps out-of-viewport bounds to a zero or sliver-sized frame
 * at the screenshot edge; stroking those paints a stray red hairline, and
 * frames narrower than the stroke would give the inner roundRect negative
 * dimensions. Real frames are always well above this after highlight padding
 * inflation, so only clamped-to-edge degenerates are skipped.
 */
export function isDrawableHighlightFrame(frame: { width: number; height: number }): boolean {
  return frame.width >= HIGHLIGHT_LINE_WIDTH && frame.height >= HIGHLIGHT_LINE_WIDTH;
}

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface Annotation {
  bounds: Bounds;
  /** 1-based order number shown in the badge when numbered=true. */
  order: number;
}

export interface AnnotationLayout {
  order: number;
  frame: Bounds;
  anchor: AnnotationPoint;
  markerOnly: boolean;
  badgeAnchor: AnnotationPoint;
  callout: AnnotationPoint | null;
  leader: AnnotationPoint[];
}

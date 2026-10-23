import type { Bounds } from '../storage/models';
import {
  BADGE_FONT_RATIO,
  BADGE_RADIUS,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_PADDING,
  type AnnotationPoint,
} from './annotation-contract';

const MERGE_OVERLAP_RATIO = 0.4;

interface SidePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function getBadgeFontSize(order: number, diameter = BADGE_RADIUS * 2): number {
  const characters = String(Math.max(order, 1)).length;
  const base = diameter * BADGE_FONT_RATIO;
  const horizontalFit = (diameter - 4) / (characters * 0.62);
  return Math.max(Math.min(base, horizontalFit), Math.min(7, base));
}

/** Scalar inflate, kept for callers that never collide — group-member frames
 * (rendered as marker dots) and {@link compositeHighlight}'s lone box. */
function inflateBounds(bounds: Bounds, padding: number): Bounds {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

function inflateBoundsPerSide(bounds: Bounds, padding: SidePadding): Bounds {
  return {
    x: bounds.x - padding.left,
    y: bounds.y - padding.top,
    width: bounds.width + padding.left + padding.right,
    height: bounds.height + padding.top + padding.bottom,
  };
}

/** Fits the final drawable frame inside the screenshot. Browser hit bounds are
 * already viewport-clipped, but highlight padding can push the outer border
 * beyond an edge and make that side disappear during canvas/SVG clipping. */
export function fitBoundsInViewport(bounds: Bounds, viewportWidth: number, viewportHeight: number): Bounds {
  const width = Math.max(Number.isFinite(viewportWidth) ? viewportWidth : 0, 0);
  const height = Math.max(Number.isFinite(viewportHeight) ? viewportHeight : 0, 0);
  const left = Math.min(Math.max(bounds.x, 0), width);
  const top = Math.min(Math.max(bounds.y, 0), height);
  const right = Math.min(Math.max(bounds.x + Math.max(bounds.width, 0), left), width);
  const bottom = Math.min(Math.max(bounds.y + Math.max(bounds.height, 0), top), height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Returns the final single-target highlight frame in screenshot CSS pixels.
 * All single-image renderers use this helper so padding and edge clipping stay
 * identical in previews, thumbnails and exported images. */
export function fitHighlightFrame(bounds: Bounds, viewportWidth: number, viewportHeight: number): Bounds {
  return fitBoundsInViewport(inflateBounds(bounds, HIGHLIGHT_PADDING), viewportWidth, viewportHeight);
}

export function fitPointInViewport(
  point: AnnotationPoint,
  radius: number,
  viewportWidth: number,
  viewportHeight: number,
): AnnotationPoint {
  const fitAxis = (value: number, extent: number) => {
    const safeExtent = Math.max(Number.isFinite(extent) ? extent : 0, 0);
    return safeExtent <= radius * 2
      ? safeExtent / 2
      : Math.min(Math.max(value, radius), safeExtent - radius);
  };
  return {
    x: fitAxis(point.x, viewportWidth),
    y: fitAxis(point.y, viewportHeight),
  };
}

/** True when `outer`'s raw bounds fully enclose `inner`'s. */
function contains(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

/**
 * Visits every pair of items whose bounds are within `maxGap` on both axes,
 * sweeping along the less-congested axis so a long single-column list stays
 * near-linear instead of degenerating to O(n²).
 */
export function forEachNearbyPair<T>(
  items: T[],
  boundsOf: (item: T) => Bounds,
  maxGap: number,
  visit: (first: T, second: T) => void,
): void {
  if (items.length < 2) return;

  const bounds = items.map(boundsOf);
  const minX = Math.min(...bounds.map((rect) => rect.x));
  const minY = Math.min(...bounds.map((rect) => rect.y));
  const maxX = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...bounds.map((rect) => rect.y + rect.height));
  const xSpan = Math.max(maxX - minX, 1);
  const ySpan = Math.max(maxY - minY, 1);
  const xCongestion = bounds.reduce((sum, rect) => sum + Math.max(rect.width, 0), 0) / xSpan;
  const yCongestion = bounds.reduce((sum, rect) => sum + Math.max(rect.height, 0), 0) / ySpan;
  const primaryIsX = xCongestion <= yCongestion;
  const primaryStart = (rect: Bounds) => (primaryIsX ? rect.x : rect.y);
  const primaryEnd = (rect: Bounds) => primaryStart(rect) + (primaryIsX ? rect.width : rect.height);
  const secondaryGap = (a: Bounds, b: Bounds) =>
    primaryIsX
      ? Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height))
      : Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));

  interface Node {
    item: T;
    rect: Bounds;
    next?: Node;
  }
  const ordered: Node[] = items
    .map((item) => ({ item, rect: boundsOf(item) }))
    .sort((a, b) => primaryStart(a.rect) - primaryStart(b.rect));
  ordered.reduceRight<Node | undefined>((next, node) => {
    node.next = next;
    return node;
  }, undefined);
  for (const a of ordered) {
    const maxPrimary = primaryEnd(a.rect) + maxGap;
    for (let b = a.next; b && primaryStart(b.rect) <= maxPrimary; b = b.next) {
      if (secondaryGap(a.rect, b.rect) <= maxGap) visit(a.item, b.item);
    }
  }
}

/** Pads each item's bounds per side so frames of nearby items never visually
 * cross. */
export function padApart<T extends { bounds: Bounds }>(items: T[]): (T & { frame: Bounds })[] {
  const nodes = items.map((item) => ({
    item,
    padding: {
      top: HIGHLIGHT_PADDING,
      right: HIGHLIGHT_PADDING,
      bottom: HIGHLIGHT_PADDING,
      left: HIGHLIGHT_PADDING,
    },
  }));
  forEachNearbyPair(nodes, (node) => node.item.bounds, HIGHLIGHT_PADDING * 2 + 2, (first, second) => {
    const a = first.item.bounds;
    const b = second.item.bounds;
    const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
    const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));

    if (dx > 0 || dy > 0) {
      const cap = Math.max(dx, dy) / 2 - 1;
      if (dx >= dy) {
        const [left, right] = a.x < b.x ? [first, second] : [second, first];
        left.padding.right = Math.min(left.padding.right, cap);
        right.padding.left = Math.min(right.padding.left, cap);
      } else {
        const [top, bottom] = a.y < b.y ? [first, second] : [second, first];
        top.padding.bottom = Math.min(top.padding.bottom, cap);
        bottom.padding.top = Math.min(bottom.padding.top, cap);
      }
      return;
    }

    const aInB = contains(b, a);
    const bInA = contains(a, b);
    if (aInB || bInA) {
      const inner = bInA ? second.padding : first.padding;
      const io = bInA ? b : a;
      const oo = bInA ? a : b;
      inner.left = Math.min(inner.left, io.x - oo.x - 1);
      inner.top = Math.min(inner.top, io.y - oo.y - 1);
      inner.right = Math.min(inner.right, oo.x + oo.width - (io.x + io.width) - 1);
      inner.bottom = Math.min(inner.bottom, oo.y + oo.height - (io.y + io.height) - 1);
      return;
    }

    const centerAX = a.x + a.width / 2;
    const centerAY = a.y + a.height / 2;
    const centerBX = b.x + b.width / 2;
    const centerBY = b.y + b.height / 2;
    const normalizedX = Math.abs(centerAX - centerBX) / Math.max((a.width + b.width) / 2, 1);
    const normalizedY = Math.abs(centerAY - centerBY) / Math.max((a.height + b.height) / 2, 1);
    const halfClearance = HIGHLIGHT_LINE_WIDTH / 2;

    if (normalizedX >= normalizedY && centerAX !== centerBX) {
      const divider = (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2;
      const [left, right] = centerAX < centerBX ? [first, second] : [second, first];
      const leftBounds = left.item.bounds;
      left.padding.right = Math.min(left.padding.right, divider - halfClearance - (leftBounds.x + leftBounds.width));
      right.padding.left = Math.min(right.padding.left, right.item.bounds.x - divider - halfClearance);
    } else if (centerAY !== centerBY) {
      const divider = (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2;
      const [top, bottom] = centerAY < centerBY ? [first, second] : [second, first];
      const topBounds = top.item.bounds;
      top.padding.bottom = Math.min(top.padding.bottom, divider - halfClearance - (topBounds.y + topBounds.height));
      bottom.padding.top = Math.min(bottom.padding.top, bottom.item.bounds.y - divider - halfClearance);
    }
  });

  const clamp = (value: number) => Math.min(HIGHLIGHT_PADDING, value);
  return nodes.map(({ item, padding }) => ({
    ...item,
    frame: inflateBoundsPerSide(item.bounds, {
      top: clamp(padding.top),
      right: clamp(padding.right),
      bottom: clamp(padding.bottom),
      left: clamp(padding.left),
    }),
  }));
}

export function pointBounds(point: AnnotationPoint, radius: number): Bounds {
  return { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
}

function intersectionArea(a: Bounds, b: Bounds): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

export function coincident(a: Bounds, b: Bounds): boolean {
  const inter = intersectionArea(a, b);
  if (inter === 0) return false;
  const maxArea = Math.max(a.width * a.height, b.width * b.height);
  return maxArea > 0 && inter / maxArea > MERGE_OVERLAP_RATIO;
}

export function unionBounds(bounds: Bounds[]): Bounds {
  const left = Math.min(...bounds.map((rect) => rect.x));
  const top = Math.min(...bounds.map((rect) => rect.y));
  const right = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...bounds.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function distanceToBounds(point: AnnotationPoint, bounds: Bounds): number {
  const x = Math.max(bounds.x, Math.min(point.x, bounds.x + bounds.width));
  const y = Math.max(bounds.y, Math.min(point.y, bounds.y + bounds.height));
  return Math.hypot(point.x - x, point.y - y);
}

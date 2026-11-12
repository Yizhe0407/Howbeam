import { getComposedParent } from './element-availability';
import { intersectBounds } from '../bounds-geometry';
import { resolveImageMapAreaBounds } from '../image-map-geometry';
import { type Bounds } from '../../storage/models';

interface HighlightGeometry {
  bounds: Bounds;
  /** The rendered element whose composed ancestors clip these bounds. */
  paintElement: Element;
}

function resolveHighlightGeometry(el: Element, clientX: number, clientY: number): HighlightGeometry | null {
  if (el instanceof HTMLAreaElement) {
    const resolved = resolveImageMapAreaBounds(el, clientX, clientY);
    return resolved ? { bounds: resolved.bounds, paintElement: resolved.image } : null;
  }

  const rects = Array.from(el.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return null;

  const containingRects = rects.filter(
    (rect) => clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom,
  );
  const rect = (containingRects.length > 0 ? containingRects : rects).reduce((smallest, candidate) =>
    candidate.width * candidate.height < smallest.width * smallest.height ? candidate : smallest,
  );

  return {
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    paintElement: el,
  };
}

/**
 * Returns the precise painted fragment clicked by the user. A multiline inline
 * element uses its smallest relevant client rect; an image-map <area> uses its
 * region projected through the associated image because the area itself has no
 * layout box.
 */
export function getHighlightBounds(el: Element, clientX: number, clientY: number): Bounds | null {
  return resolveHighlightGeometry(el, clientX, clientY)?.bounds ?? null;
}

function overflowClipBounds(el: Element, viewport: { width: number; height: number }): Bounds {
  // Client coordinates are viewport-relative. Root boxes, especially <body>
  // on pages that set overflow themselves, move to -scrollX/-scrollY in
  // getBoundingClientRect() as the document scrolls; using that moving rect as
  // a clip would incorrectly hide every target revealed below the fold.
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  }
  const rect = el.getBoundingClientRect();
  if (!(el instanceof HTMLElement) || el.clientWidth <= 0 || el.clientHeight <= 0) {
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }
  const scaleX = rect.width / (el.offsetWidth || rect.width || 1);
  const scaleY = rect.height / (el.offsetHeight || rect.height || 1);
  return {
    x: rect.left + el.clientLeft * scaleX,
    y: rect.top + el.clientTop * scaleY,
    width: el.clientWidth * scaleX,
    height: el.clientHeight * scaleY,
  };
}

export function clipsPaint(style: CSSStyleDeclaration): boolean {
  const containment = style.contain.split(/\s+/);
  return (
    Boolean(style.clipPath && style.clipPath !== 'none') ||
    containment.includes('paint') ||
    containment.includes('content') ||
    containment.includes('strict')
  );
}

/** Returns only the rectangular portion a user can actually see and click.
 * It accounts for the viewport and clipping/scrolling ancestors. Arbitrary
 * non-rectangular clip paths still resolve to their element's bounding box,
 * which is the closest representation supported by the Bounds data model. */
export function getVisibleHighlightBounds(
  el: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): Bounds | null {
  const geometry = resolveHighlightGeometry(el, clientX, clientY);
  if (!geometry) return null;
  let visible: Bounds | null = geometry.bounds;
  visible = intersectBounds(visible, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  if (!visible) return null;

  let ancestor = getComposedParent(geometry.paintElement);
  while (ancestor) {
    const style = getComputedStyle(ancestor);
    const overflowX = style.overflowX || style.overflow;
    const overflowY = style.overflowY || style.overflow;
    const clipsX = Boolean(overflowX && overflowX !== 'visible');
    const clipsY = Boolean(overflowY && overflowY !== 'visible');
    const paintClip = clipsPaint(style);
    if (clipsX || clipsY) {
      const rect = overflowClipBounds(ancestor, viewport);
      const clip = {
        x: clipsX ? rect.x : visible.x,
        y: clipsY ? rect.y : visible.y,
        width: clipsX ? rect.width : visible.width,
        height: clipsY ? rect.height : visible.height,
      };
      visible = intersectBounds(visible, clip);
      if (!visible) return null;
    }
    if (paintClip) {
      const rect = ancestor.getBoundingClientRect();
      visible = intersectBounds(visible, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      if (!visible) return null;
    }
    ancestor = getComposedParent(ancestor);
  }
  return visible;
}

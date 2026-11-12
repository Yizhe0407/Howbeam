import { findImageMapAreaAtPoint } from '../capture/image-map-geometry';
import { isElementVisuallyUnavailable } from '../capture/selector/element-availability';
import { getVisibleHighlightBounds } from '../capture/selector/highlight-bounds';
import { isInteractiveElement } from '../capture/selector/interactive-element';

export { findImageForArea, findMapForImage, parseImageMapCoordinates } from '../capture/image-map-geometry';

export interface ResolvedImageMapTarget {
  area: HTMLAreaElement;
  image: HTMLImageElement;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Resolves the first actionable area containing a viewport point for one image. */
export function resolveImageMapTargetAtPoint(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
): ResolvedImageMapTarget | null {
  if (isElementVisuallyUnavailable(image)) return null;

  const area = findImageMapAreaAtPoint(image, clientX, clientY);
  if (!area || !isInteractiveElement(area)) return null;

  const bounds = getVisibleHighlightBounds(area, clientX, clientY);
  return bounds ? { area, image, bounds } : null;
}

import type { Bounds } from '../storage/models';
import { createImageCoordinateMapper } from './image-geometry';
import { intersectBounds } from './bounds-geometry';

const ASCII_WHITESPACE = new Set(['\t', '\n', '\f', '\r', ' ']);
const COORDINATE_DELIMITERS = new Set([...ASCII_WHITESPACE, ',', ';']);

interface ImageMapRegion {
  bounds: Bounds;
  contains(x: number, y: number): boolean;
}

export interface ResolvedImageMapAreaBounds {
  image: HTMLImageElement;
  bounds: Bounds;
}

function isCoordinateDelimiter(character: string): boolean {
  return COORDINATE_DELIMITERS.has(character);
}

function canStartCoordinateNumber(character: string): boolean {
  return (character >= '0' && character <= '9') || character === '.' || character === '-';
}

/** Implements HTML's list-of-floating-point-numbers tokenization used by coords. */
export function parseImageMapCoordinates(input: string): number[] {
  const numbers: number[] = [];
  let position = 0;

  const skipDelimiters = () => {
    while (position < input.length && isCoordinateDelimiter(input.charAt(position))) position += 1;
  };

  skipDelimiters();
  while (position < input.length) {
    while (
      position < input.length &&
      !isCoordinateDelimiter(input.charAt(position)) &&
      !canStartCoordinateNumber(input.charAt(position))
    ) {
      position += 1;
    }

    const start = position;
    while (position < input.length && !isCoordinateDelimiter(input.charAt(position))) position += 1;
    const parsed = Number.parseFloat(input.slice(start, position));
    numbers.push(Number.isFinite(parsed) && !Object.is(parsed, -0) ? parsed : 0);
    skipDelimiters();
  }

  return numbers;
}

function normalizedShape(area: HTMLAreaElement): 'default' | 'rect' | 'circle' | 'poly' {
  switch ((area.getAttribute('shape') ?? '').toLowerCase()) {
    case 'default':
      return 'default';
    case 'circle':
    case 'circ':
      return 'circle';
    case 'poly':
    case 'polygon':
      return 'poly';
    case 'rect':
    case 'rectangle':
      return 'rect';
    default:
      return 'rect';
  }
}

function pointOnSegment(
  x: number,
  y: number,
  start: readonly [number, number],
  end: readonly [number, number],
): boolean {
  const [startX, startY] = start;
  const [endX, endY] = end;
  const cross = (endX - startX) * (y - startY) - (endY - startY) * (x - startX);
  const scale = Math.max(
    1,
    Math.abs(endX - startX),
    Math.abs(endY - startY),
    Math.abs(x - startX),
    Math.abs(y - startY),
  );
  if (Math.abs(cross) > Number.EPSILON * scale * scale * 16) return false;
  return (
    x >= Math.min(startX, endX) &&
    x <= Math.max(startX, endX) &&
    y >= Math.min(startY, endY) &&
    y <= Math.max(startY, endY)
  );
}

/** HTML image-map polygons use the even-odd rule and include polygon edges. */
function pointInPolygon(x: number, y: number, points: Array<readonly [number, number]>): boolean {
  let start = points.at(-1);
  if (!start) return false;
  let inside = false;
  for (const end of points) {
    if (pointOnSegment(x, y, start, end)) return true;

    const crossesScanline = (start[1] > y) !== (end[1] > y);
    if (crossesScanline) {
      const intersectionX = start[0] + ((y - start[1]) * (end[0] - start[0])) / (end[1] - start[1]);
      if (x < intersectionX) inside = !inside;
    }
    start = end;
  }
  return inside;
}

function regionForArea(area: HTMLAreaElement, imageBounds: Bounds): ImageMapRegion | null {
  const shape = normalizedShape(area);
  if (shape === 'default') {
    return { bounds: imageBounds, contains: () => true };
  }

  const coords = parseImageMapCoordinates(area.coords);
  if (shape === 'rect') {
    const [x1, y1, x2, y2] = coords;
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    return {
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
      contains: (x, y) => x >= left && x <= right && y >= top && y <= bottom,
    };
  }

  if (shape === 'circle') {
    const [centerX, centerY, radius] = coords;
    if (centerX === undefined || centerY === undefined || radius === undefined || radius <= 0) return null;
    return {
      bounds: {
        x: centerX - radius,
        y: centerY - radius,
        width: radius * 2,
        height: radius * 2,
      },
      contains: (x, y) => Math.hypot(x - centerX, y - centerY) <= radius,
    };
  }

  // An odd trailing coordinate is dropped.
  const points: Array<readonly [number, number]> = [];
  let pendingX: number | undefined;
  for (const value of coords) {
    if (pendingX === undefined) {
      pendingX = value;
    } else {
      points.push([pendingX, value]);
      pendingX = undefined;
    }
  }
  if (points.length <= 2) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    bounds: {
      x: left,
      y: top,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top,
    },
    contains: (x, y) => pointInPolygon(x, y, points),
  };
}

function imageMapNameReference(image: HTMLImageElement): string | null {
  const useMap = image.getAttribute('usemap') ?? '';
  const hashIndex = useMap.indexOf('#');
  return hashIndex >= 0 && hashIndex < useMap.length - 1 ? useMap.slice(hashIndex + 1) : null;
}

function queryTree(node: Node, selector: string): Element[] {
  const root = node.getRootNode();
  const matchesRoot = root instanceof Element && root.matches(selector) ? [root] : [];
  if (!('querySelectorAll' in root)) return matchesRoot;
  return [...matchesRoot, ...Array.from((root as ParentNode).querySelectorAll(selector))];
}

/** Resolves the first map whose id or name exactly matches the hash-name reference. */
export function findMapForImage(image: HTMLImageElement): HTMLMapElement | null {
  const mapName = imageMapNameReference(image);
  if (!mapName) return null;
  return (
    queryTree(image, 'map').find(
      (candidate): candidate is HTMLMapElement =>
        candidate instanceof HTMLMapElement && (candidate.id === mapName || candidate.name === mapName),
    ) ?? null
  );
}

function containsBoundsPoint(bounds: Bounds, x: number, y: number): boolean {
  return (
    x >= bounds.x &&
    y >= bounds.y &&
    x <= bounds.x + bounds.width &&
    y <= bounds.y + bounds.height
  );
}

/** Finds an image that actually resolves to the area element's containing map. */
export function findImageForArea(
  area: HTMLAreaElement,
  clientX?: number,
  clientY?: number,
): HTMLImageElement | null {
  const map = area.closest('map');
  if (!(map instanceof HTMLMapElement)) return null;
  const images = queryTree(area, 'img').filter(
    (candidate): candidate is HTMLImageElement =>
      candidate instanceof HTMLImageElement && findMapForImage(candidate) === map,
  );

  if (
    typeof clientX === 'number' &&
    typeof clientY === 'number' &&
    Number.isFinite(clientX) &&
    Number.isFinite(clientY)
  ) {
    const root = area.getRootNode() as Node & {
      elementsFromPoint?: (x: number, y: number) => Element[];
    };
    const stackedImage = root
      .elementsFromPoint?.(clientX, clientY)
      .find((candidate) => candidate instanceof HTMLImageElement && images.includes(candidate));
    if (stackedImage instanceof HTMLImageElement) return stackedImage;

    const containingImage = images.find((image) => {
      const mapper = createImageCoordinateMapper(image);
      if (!mapper) return false;
      const point = mapper.toImagePoint(clientX, clientY);
      return containsBoundsPoint(mapper.coordinateBounds, point.x, point.y);
    });
    if (containingImage) return containingImage;
  }

  return images[0] ?? null;
}

/** Returns the first image-map area whose region contains the viewport point. */
export function findImageMapAreaAtPoint(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
): HTMLAreaElement | null {
  const map = findMapForImage(image);
  if (!map) return null;

  const mapper = createImageCoordinateMapper(image);
  if (!mapper) return null;
  const point = mapper.toImagePoint(clientX, clientY);
  if (!containsBoundsPoint(mapper.coordinateBounds, point.x, point.y)) return null;

  for (const area of Array.from(map.areas) as HTMLAreaElement[]) {
    const region = regionForArea(area, mapper.coordinateBounds);
    if (region?.contains(point.x, point.y)) return area;
  }
  return null;
}

/**
 * Resolves an area's image-clipped viewport bounds. Visibility clipping is
 * deliberately left to highlight-bounds so it follows the image's paint tree.
 */
export function resolveImageMapAreaBounds(
  area: HTMLAreaElement,
  clientX: number,
  clientY: number,
): ResolvedImageMapAreaBounds | null {
  const image = findImageForArea(area, clientX, clientY);
  if (!image) return null;

  const mapper = createImageCoordinateMapper(image);
  if (!mapper) return null;
  const region = regionForArea(area, mapper.coordinateBounds);
  if (!region) return null;
  const localBounds = intersectBounds(region.bounds, mapper.coordinateBounds);
  if (!localBounds) return null;

  return { image, bounds: mapper.toViewportBounds(localBounds) };
}

import { deepElementFromPoint, getComposedParent } from './selector/element-availability';
import type { ScrollSnapshot } from './step-capture';
import type { Rect } from '@/lib/shared/geometry';

export function isOutOfViewport(rect: Rect): boolean {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return rect.y < 0 || rect.x < 0 || bottom > window.innerHeight || right > window.innerWidth;
}

function isScrollableElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const overflowX = style.overflowX || style.overflow;
  const overflowY = style.overflowY || style.overflow;
  return (
    (['auto', 'scroll', 'overlay'].includes(overflowX) && element.scrollWidth > element.clientWidth) ||
    (['auto', 'scroll', 'overlay'].includes(overflowY) && element.scrollHeight > element.clientHeight)
  );
}

function getScrollableAncestors(target: Element): Element[] {
  const ancestors: Element[] = [];
  let ancestor = getComposedParent(target);
  while (ancestor) {
    if (isScrollableElement(ancestor)) ancestors.push(ancestor);
    ancestor = getComposedParent(ancestor);
  }
  return ancestors;
}

export function readScrollSnapshot(target: Element): ScrollSnapshot {
  return {
    x: window.scrollX,
    y: window.scrollY,
    containers: getScrollableAncestors(target).map((element) => ({
      element,
      x: element.scrollLeft,
      y: element.scrollTop,
    })),
  };
}

/**
 * Pins every scrollable container that intersects a user-selected region so a
 * programmatic scroll in a nested scroller cannot shift pixels out from under
 * the region rect while its screenshot is in flight. Mirrors the element
 * capture path, which pins the target's scrollable ancestors.
 */
export function readRegionScrollSnapshot(rect: Rect): ScrollSnapshot {
  const insetX = Math.min(4, rect.width / 4);
  const insetY = Math.min(4, rect.height / 4);
  const samplePoints: Array<[number, number]> = [
    [rect.x + rect.width / 2, rect.y + rect.height / 2],
    [rect.x + insetX, rect.y + insetY],
    [rect.x + rect.width - insetX, rect.y + insetY],
    [rect.x + insetX, rect.y + rect.height - insetY],
    [rect.x + rect.width - insetX, rect.y + rect.height - insetY],
  ];
  const containers = new Map<Element, { x: number; y: number }>();
  for (const [clientX, clientY] of samplePoints) {
    const hit = deepElementFromPoint(clientX, clientY);
    if (!hit) continue;
    let node: Element | null = hit;
    while (node) {
      if (!containers.has(node) && isScrollableElement(node)) {
        containers.set(node, { x: node.scrollLeft, y: node.scrollTop });
      }
      node = getComposedParent(node);
    }
  }
  return {
    x: window.scrollX,
    y: window.scrollY,
    containers: Array.from(containers, ([element, scroll]) => ({ element, x: scroll.x, y: scroll.y })),
  };
}

import { vi } from 'vitest';

/**
 * jsdom performs no layout, so the selector suites have to declare the geometry
 * their hit-tests read. Shared by the four selector/* suites, which build real
 * DOM trees and stub globals per case.
 */
export function makeVisible(element: Element, rect = { x: 20, y: 20, width: 120, height: 40 }): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      top: rect.y,
      left: rect.x,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      toJSON: () => rect,
    }),
  });
  Object.defineProperty(element, 'getClientRects', {
    configurable: true,
    value: () => [
      {
        ...rect,
        top: rect.y,
        left: rect.x,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
      },
    ],
  });
}

/** Per-file cleanup for the selector suites. */
export function resetSelectorDom(): void {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

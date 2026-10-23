import { hasComputedVisibilityUnavailable, hasOwnInteractionDisabledState, hasOwnSubtreeVisualUnavailableState } from './element-availability';
import { type Bounds } from '../../storage/models';
import { type InteractionKind, interactionKind } from './interactive-element';

export interface AnalyzedElement {
  element: Element;
  style: CSSStyleDeclaration;
  kind: InteractionKind | null;
  interactionUnavailable: boolean;
  visuallyUnavailable: boolean;
  boundingRect?: DOMRect;
  highlightBounds?: Bounds | null;
}

/** Builds the composed ancestor chain and all inherited state once per hit-test.
 * Entries remain deepest-first, which is the order the candidate chain and its
 * `defaultIndex` are expressed in. */
export function analyzeElements(nodes: Iterable<unknown>): AnalyzedElement[] {
  const elements: Element[] = [];
  const seen = new Set<Element>();
  for (const node of nodes) {
    if (!(node instanceof Element) || seen.has(node)) continue;
    seen.add(node);
    elements.push(node);
  }

  // Ancestor state flows down, so walk from the outermost element inward.
  const entries: AnalyzedElement[] = [];
  let interactionUnavailable = false;
  let subtreeVisuallyUnavailable = false;
  for (const element of elements.toReversed()) {
    const style = getComputedStyle(element);
    interactionUnavailable ||= hasOwnInteractionDisabledState(element);
    subtreeVisuallyUnavailable ||= hasOwnSubtreeVisualUnavailableState(style);
    entries.push({
      element,
      style,
      kind: interactionKind(element, style),
      interactionUnavailable,
      // Image-map areas intentionally inherit their rendered state from the
      // associated image rather than their non-rendered <map> ancestry.
      visuallyUnavailable: element instanceof HTMLAreaElement
        ? false
        : subtreeVisuallyUnavailable ||
          hasComputedVisibilityUnavailable(style) ||
          style.display === 'contents',
    });
  }
  return entries.reverse();
}

export function boundingRect(entry: AnalyzedElement): DOMRect {
  entry.boundingRect ??= entry.element.getBoundingClientRect();
  return entry.boundingRect;
}

export function visibleArea(entry: AnalyzedElement): number {
  const rect = boundingRect(entry);
  return Number.isFinite(rect.width) && Number.isFinite(rect.height)
    ? Math.max(rect.width, 0) * Math.max(rect.height, 0)
    : 0;
}

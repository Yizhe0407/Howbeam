import { DECORATIVE_SVG_TAGS, NON_SELECTABLE_VISUAL_TAGS, deepElementFromPoint, descendShadowRoots, elementAndComposedAncestors } from './element-availability';
import { OCCLUDER_STACK_LIMIT, hasOnlyBlankExclusiveOccluders } from './element-paint';
import { clipsPaint, getHighlightBounds, getVisibleHighlightBounds } from './highlight-bounds';
import { intersectBounds } from '../bounds-geometry';
import { isExtensionOverlay } from '../viewport-overlay-host';
import { type AnalyzedElement, analyzeElements, boundingRect, visibleArea } from './analyzed-element';
import { type Bounds } from '../../storage/models';
import { type InteractionKind, isDecorativeLeaf } from './interactive-element';

/** Wrappers in component trees frequently differ by a one-pixel inset even
 * though users perceive one boundary. The candidate chain should hold visually
 * distinct boxes, not every implementation wrapper. */
const VISUAL_EDGE_MERGE_TOLERANCE = 2;

/**
 * Chooses the element users perceive as the control. Native/ARIA controls
 * outrank cursor-only descendants; this prevents an icon or text node inside
 * a button-like surface from producing a tiny, inconsistent annotation box.
 */
function findInteractiveTargetFromEntries(entries: AnalyzedElement[]): Element | null {
  const kindScore: Record<InteractionKind, number> = {
    native: 5,
    role: 4,
    handler: 3,
    focusable: 2,
    cursor: 1,
  };

  let best: { entry: AnalyzedElement; cursorScore: number } | null = null;
  for (const entry of entries) {
    if (entry.element === document.body || entry.element === document.documentElement) break;
    const kind = entry.kind;
    if (
      !kind ||
      isDecorativeLeaf(entry.element, kind) ||
      entry.interactionUnavailable ||
      entry.visuallyUnavailable ||
      visibleArea(entry) === 0
    ) {
      continue;
    }

    const rect = boundingRect(entry);
    const cursorScore = kind === 'cursor'
      ? Math.min(Math.min(rect.width, rect.height), 44) * 100 - Math.min(visibleArea(entry), 40_000) / 100
      : 0;
    if (
      !best ||
      kindScore[kind] > kindScore[best.entry.kind!] ||
      (kind === best.entry.kind && kind === 'cursor' && cursorScore > best.cursorScore)
    ) {
      best = { entry, cursorScore };
    }
  }
  return best?.entry.element ?? null;
}

export interface VisualTargetCandidate {
  element: Element;
  bounds: Bounds;
}

export interface VisualTargetCandidates {
  candidates: VisualTargetCandidate[];
  defaultIndex: number;
}

/**
 * Browser recording has two different targeting contracts:
 *
 * - annotation: choose the visible UI surface, optionally looking through a
 *   completely blank hit-test shim (the browser equivalent of an accessibility
 *   API omitting a non-semantic overlay);
 * - activation: preserve the page's actual top hit surface, because replaying a
 *   click on an element hidden underneath an overlay changes page behaviour.
 */
export interface VisualTargetPolicy {
  pierceTransparentOccluders: boolean;
  preserveHitSurface: boolean;
}

const ANNOTATION_TARGETING_POLICY: Readonly<VisualTargetPolicy> = Object.freeze({
  pierceTransparentOccluders: true,
  preserveHitSurface: false,
});

export const ACTIVATION_TARGETING_POLICY: Readonly<VisualTargetPolicy> = Object.freeze({
  pierceTransparentOccluders: false,
  preserveHitSurface: true,
});

function visualBoundsKey(bounds: Bounds): string {
  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .map((value) => Math.round(value * 2))
    .join(':');
}

/** Collapses tiny layout insets while retaining genuinely different parent
 * levels. Comparing edges rather than width/height avoids treating translated
 * sibling boxes as equivalent. */
function hasSamePerceivedBoundary(a: Bounds, b: Bounds): boolean {
  const close = (first: number, second: number) => Math.abs(first - second) <= VISUAL_EDGE_MERGE_TOLERANCE;
  return (
    close(a.x, b.x) &&
    close(a.y, b.y) &&
    close(a.x + a.width, b.x + b.width) &&
    close(a.y + a.height, b.y + b.height)
  );
}

function isVisuallySelectableEntry(
  entry: AnalyzedElement,
  isHit: boolean,
  policy: Readonly<VisualTargetPolicy>,
): boolean {
  const tag = entry.element.tagName.toLowerCase();
  return (
    !NON_SELECTABLE_VISUAL_TAGS.has(tag) &&
    (!DECORATIVE_SVG_TAGS.has(tag) || (entry.kind !== null && entry.kind !== 'cursor')) &&
    (!entry.visuallyUnavailable || (isHit && policy.preserveHitSurface))
  );
}

/** Memoized per hit-test so a candidate chain measures each element once. */
function highlightBounds(entry: AnalyzedElement, clientX: number, clientY: number): Bounds | null {
  // Not `??=`: a cached null is a real answer (the element has no painted
  // box), and recomputing it would re-measure on every lookup.
  if (entry.highlightBounds === undefined) {
    entry.highlightBounds = getHighlightBounds(entry.element, clientX, clientY);
  }
  return entry.highlightBounds;
}

function overflowClipBoundsFromEntry(
  entry: AnalyzedElement,
  viewport: { width: number; height: number },
): Bounds {
  const el = entry.element;
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  }
  const rect = boundingRect(entry);
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

/** Candidate-chain variant of `getVisibleHighlightBounds`. It reuses the
 * styles and rectangles already measured for this hit test, which lets visual
 * dedup compare the actual on-screen boxes without multiplying layout reads. */
function visibleHighlightBoundsFromEntries(
  entry: AnalyzedElement,
  ancestors: AnalyzedElement[],
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): Bounds | null {
  // An <area> paints through its associated <img>, not through its <map>
  // ancestry. Use the canonical path so clipping starts at the image tree.
  if (entry.element instanceof HTMLAreaElement) {
    return getVisibleHighlightBounds(entry.element, clientX, clientY, viewport);
  }

  let visible = highlightBounds(entry, clientX, clientY);
  if (!visible) return null;
  visible = intersectBounds(visible, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  if (!visible) return null;

  for (const ancestor of ancestors) {
    const style = ancestor.style;
    const overflowX = style.overflowX || style.overflow;
    const overflowY = style.overflowY || style.overflow;
    const clipsX = Boolean(overflowX && overflowX !== 'visible');
    const clipsY = Boolean(overflowY && overflowY !== 'visible');
    if (clipsX || clipsY) {
      const rect = overflowClipBoundsFromEntry(ancestor, viewport);
      visible = intersectBounds(visible, {
        x: clipsX ? rect.x : visible.x,
        y: clipsY ? rect.y : visible.y,
        width: clipsX ? rect.width : visible.width,
        height: clipsY ? rect.height : visible.height,
      });
      if (!visible) return null;
    }
    if (clipsPaint(style)) {
      const rect = boundingRect(ancestor);
      visible = intersectBounds(visible, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
      if (!visible) return null;
    }
  }
  return visible;
}

interface ChainAnalysis {
  targets: VisualTargetCandidates;
  /** The control the chain resolves to, or null when it holds none. */
  interactive: Element | null;
  /** Deepest-first composed branch, retained so occlusion fallback can inspect
   * only the part that sits above a deeper target. Shared app/body ancestors do
   * not occlude one sibling branch with another and must not block piercing. */
  entries: AnalyzedElement[];
}

/** Builds the visually distinct target chain under a point, from the deepest
 * rendered element toward its composed ancestors. Semantic controls remain
 * the default even when the pointer lands on a nested label or icon. */
function analyzeChain(
  hit: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
  policy: Readonly<VisualTargetPolicy>,
): ChainAnalysis {
  const entries = analyzeElements(elementAndComposedAncestors(hit));
  const interactive = findInteractiveTargetFromEntries(entries);
  const candidates: VisualTargetCandidate[] = [];
  const indexByBounds = new Map<string, number>();

  for (const [index, entry] of entries.entries()) {
    const element = entry.element;
    if (!isVisuallySelectableEntry(entry, index === 0, policy)) continue;
    const bounds = visibleHighlightBoundsFromEntries(entry, entries.slice(index + 1), clientX, clientY, viewport);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;

    const key = visualBoundsKey(bounds);
    const exactIndex = indexByBounds.get(key);
    if (exactIndex !== undefined) {
      if (element === interactive) candidates[exactIndex] = { element, bounds };
      continue;
    }

    // Component libraries often nest icon/label/surface wrappers whose boxes
    // differ by only one or two CSS pixels. Keeping all of them would make one
    // visible boundary occupy several chain entries. Ancestors are visited in
    // visual depth order, so the immediately preceding distinct box is the only
    // fuzzy comparison needed; exact non-adjacent repeats still use the map.
    const previousIndex = candidates.length - 1;
    const previous = candidates[previousIndex];
    if (previous && hasSamePerceivedBoundary(previous.bounds, bounds)) {
      if (element === interactive) candidates[previousIndex] = { element, bounds };
      indexByBounds.set(key, previousIndex);
      continue;
    }

    indexByBounds.set(key, candidates.length);
    candidates.push({ element, bounds });
  }

  const interactiveIndex = interactive
    ? candidates.findIndex((candidate) => candidate.element === interactive)
    : -1;
  return {
    targets: { candidates, defaultIndex: interactiveIndex >= 0 ? interactiveIndex : 0 },
    interactive,
    entries,
  };
}

/**
 * Resolves the candidate chain for a point, looking past a blank overlay that
 * covers the control the user is aiming at. The topmost chain wins whenever it
 * holds a control of its own, so the extra paint-stack walk only runs for the
 * hit tests that would otherwise return nothing actionable.
 */
export function findVisualTargetCandidatesAtPoint(
  hit: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
  policy: Readonly<VisualTargetPolicy> = ANNOTATION_TARGETING_POLICY,
): VisualTargetCandidates {
  const top = analyzeChain(hit, clientX, clientY, viewport, policy);
  if (
    !policy.pierceTransparentOccluders ||
    top.interactive ||
    typeof document.elementsFromPoint !== 'function'
  ) {
    return top.targets;
  }

  const occludingBranches: AnalyzedElement[][] = [top.entries];
  const analyzed = new Set(top.entries.map((entry) => entry.element));
  for (const occluded of document.elementsFromPoint(clientX, clientY).slice(0, OCCLUDER_STACK_LIMIT)) {
    if (analyzed.has(occluded) || isExtensionOverlay(occluded)) continue;
    const deeper = analyzeChain(
      descendShadowRoots(occluded, clientX, clientY),
      clientX,
      clientY,
      viewport,
      policy,
    );
    for (const entry of deeper.entries) analyzed.add(entry.element);
    if (deeper.interactive) {
      const targetElements = new Set(deeper.entries.map((entry) => entry.element));
      return occludingBranches.every((branch) =>
        hasOnlyBlankExclusiveOccluders(branch, targetElements, clientX, clientY, viewport)
      )
        ? deeper.targets
        : top.targets;
    }
    occludingBranches.push(deeper.entries);
  }
  return top.targets;
}

/** Picks the chain's default candidate — the one box a point resolves to.
 * `defaultIndex` is where the policy landed, so this is the single place that
 * knows how to read a candidate list. */
export function selectVisualTargetCandidate(
  targets: VisualTargetCandidates,
): VisualTargetCandidate | null {
  return targets.candidates[targets.defaultIndex] ?? null;
}

/** Hit-tests a viewport point and resolves the candidate it selects there.
 * Shared by the top-frame step recorder and the child-frame relay so both
 * frames pick identical targets. */
export function resolveVisualTargetAtPoint(
  clientX: number,
  clientY: number,
  policy: Readonly<VisualTargetPolicy> = ANNOTATION_TARGETING_POLICY,
): VisualTargetCandidate | null {
  const hit = deepElementFromPoint(clientX, clientY);
  if (!hit) return null;
  return selectVisualTargetCandidate(
    findVisualTargetCandidatesAtPoint(
      hit,
      clientX,
      clientY,
      { width: window.innerWidth, height: window.innerHeight },
      policy,
    ),
  );
}

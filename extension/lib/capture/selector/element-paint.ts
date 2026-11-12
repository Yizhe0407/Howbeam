import { SELF_PAINTING_TAGS, composedElementChildren, getComposedParent, hasComputedVisibilityUnavailable, hasOwnSubtreeVisualUnavailableState } from './element-availability';
import { interactionKind } from './interactive-element';
import { type AnalyzedElement } from './analyzed-element';
import { type Bounds } from '../../storage/models';

/** How far down the paint stack a blank occluder is searched past. */
export const OCCLUDER_STACK_LIMIT = 8;
/** A hostile or unusually large component tree must not turn one pointer move
 * into an unbounded DOM walk. Reaching the cap means the branch cannot be
 * proven blank, so targeting conservatively keeps the upper surface. */
const OCCLUDER_SUBTREE_SCAN_LIMIT = 256;
/** Containing-block discovery is repeated inside the bounded subtree scan, so
 * cap each ancestor walk as well. Exceeding it leaves the pseudo unproven. */
const PSEUDO_CONTAINING_BLOCK_SCAN_LIMIT = 64;

const GENERATED_PSEUDO_ELEMENTS = ['::before', '::after'] as const;

function cssColorIsTransparent(color: string): boolean {
  const normalized = color.replace(/\s+/g, '').toLowerCase();
  if (!normalized || normalized === 'transparent') return true;
  const rgba = normalized.match(/^rgba\([^,]+,[^,]+,[^,]+,([\d.]+)\)$/);
  if (rgba) return Number(rgba[1]) === 0;
  const modernRgb = normalized.match(/^rgb\([^/]+\/([\d.]+)%?\)$/);
  if (!modernRgb) return false;
  return Number(modernRgb[1]) === 0;
}

function cssPaintIsAbsent(value: string | undefined): boolean {
  return !value || value === 'none' || value === 'normal';
}

/**
 * Whether the hit element itself contributes visible pixels. This deliberately
 * stays conservative: unknown paint (images, pseudo-like filters, borders) is
 * considered real, because selecting the top visual object is safer than
 * clicking through it.
 */
function hasNoOwnVisualPaint(el: Element, style: CSSStyleDeclaration): boolean {
  if (SELF_PAINTING_TAGS.has(el.tagName.toLowerCase())) return false;
  // Disabled/inert controls are intentionally still selectable in snapshot
  // mode. interactionKind describes their own semantics before inherited
  // disabled state is applied, so they never become accidental pass-throughs.
  if (interactionKind(el, style) !== null) return false;
  const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
  if (role && role !== 'none' && role !== 'presentation' && role !== 'generic') return false;
  if (Number(style.opacity) === 0) return true;
  if (!cssColorIsTransparent(style.backgroundColor) || !cssPaintIsAbsent(style.backgroundImage)) return false;
  if (
    !cssPaintIsAbsent(style.boxShadow) ||
    !cssPaintIsAbsent(style.outlineStyle) ||
    !cssPaintIsAbsent(style.filter)
  ) {
    return false;
  }

  const extended = style as CSSStyleDeclaration & {
    backdropFilter?: string;
    maskImage?: string;
    webkitBackdropFilter?: string;
    webkitMaskImage?: string;
  };
  if (
    !cssPaintIsAbsent(extended.backdropFilter) ||
    !cssPaintIsAbsent(extended.webkitBackdropFilter) ||
    !cssPaintIsAbsent(extended.maskImage) ||
    !cssPaintIsAbsent(extended.webkitMaskImage)
  ) {
    return false;
  }

  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const width = Number.parseFloat(style[`border${side}Width`]);
    const borderStyle = style[`border${side}Style`];
    const color = style[`border${side}Color`];
    if (width > 0 && borderStyle !== 'none' && !cssColorIsTransparent(color)) return false;
  }
  return true;
}

function hasSurfaceDescription(el: Element): boolean {
  return (
    (el.textContent ?? '').trim().length > 0 ||
    (el.getAttribute('aria-label') ?? '').trim().length > 0 ||
    (el.getAttribute('aria-labelledby') ?? '').trim().length > 0 ||
    (el.getAttribute('title') ?? '').trim().length > 0
  );
}

/**
 * A transparent shim or drag layer can swallow hit testing without being the
 * thing users see. Annotation targeting follows visible UI boundaries, so a
 * small transparent layer is just as pass-through as a full-viewport one.
 * Text, accessible semantics and any painted surface — notably a modal
 * backdrop — stay real targets regardless of their size.
 */
function looksLikeBlankOccluder(entry: AnalyzedElement): boolean {
  return !hasSurfaceDescription(entry.element) && hasNoOwnVisualPaint(entry.element, entry.style);
}

function rectContainsPoint(rect: DOMRect, clientX: number, clientY: number): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

function elementHasBoxAtPoint(el: Element, clientX: number, clientY: number): boolean {
  try {
    return Array.from(el.getClientRects()).some((rect) => rectContainsPoint(rect, clientX, clientY));
  } catch {
    // A layout read that cannot be completed means the branch is not safely
    // classifiable as blank. The caller treats this sentinel as painted.
    return true;
  }
}

function browserSupportsPseudoComputedStyle(): boolean {
  try {
    return (
      CSS.supports('selector(::before)')
    );
  } catch {
    return false;
  }
}

function generatedContentPaints(style: CSSStyleDeclaration): boolean {
  if (hasOwnSubtreeVisualUnavailableState(style) || hasComputedVisibilityUnavailable(style)) {
    return false;
  }

  const content = style.content.trim();
  const hasVisibleTextContent =
    content !== '' && content !== 'none' && content !== 'normal' && content !== '""' && content !== "''";
  if (hasVisibleTextContent) return true;

  if (!cssColorIsTransparent(style.backgroundColor) || !cssPaintIsAbsent(style.backgroundImage)) return true;
  if (
    !cssPaintIsAbsent(style.boxShadow) ||
    !cssPaintIsAbsent(style.outlineStyle) ||
    !cssPaintIsAbsent(style.filter)
  ) {
    return true;
  }

  const extended = style as CSSStyleDeclaration & {
    backdropFilter?: string;
    maskImage?: string;
    webkitBackdropFilter?: string;
    webkitMaskImage?: string;
  };
  if (
    !cssPaintIsAbsent(extended.backdropFilter) ||
    !cssPaintIsAbsent(extended.webkitBackdropFilter) ||
    !cssPaintIsAbsent(extended.maskImage) ||
    !cssPaintIsAbsent(extended.webkitMaskImage)
  ) {
    return true;
  }

  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const width = Number.parseFloat(style[`border${side}Width`]);
    const borderStyle = style[`border${side}Style`];
    const color = style[`border${side}Color`];
    if (width > 0 && borderStyle !== 'none' && !cssColorIsTransparent(color)) return true;
  }
  return false;
}

function computedPixelLength(value: string | undefined): number | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === '0') return 0;
  if (!normalized.endsWith('px')) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function elementPaddingBounds(el: Element): Bounds | null {
  try {
    const rect = el.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
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
  } catch {
    return null;
  }
}

function establishesAbsoluteContainingBlock(style: CSSStyleDeclaration): boolean {
  const containment = style.contain.split(/\s+/);
  return (
    (style.position !== '' && style.position !== 'static') ||
    (style.transform !== '' && style.transform !== 'none') ||
    (style.perspective !== '' && style.perspective !== 'none') ||
    containment.some((value) => value === 'layout' || value === 'paint' || value === 'content' || value === 'strict')
  );
}

function positionedPseudoContainingBounds(
  el: Element,
  position: string,
  viewport: { width: number; height: number },
): Bounds | null {
  if (position === 'fixed') return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  if (position !== 'absolute') return null;

  let ancestor: Element | null = el;
  let scanned = 0;
  while (ancestor) {
    scanned += 1;
    if (scanned > PSEUDO_CONTAINING_BLOCK_SCAN_LIMIT) return null;
    try {
      if (establishesAbsoluteContainingBlock(getComputedStyle(ancestor))) {
        return elementPaddingBounds(ancestor);
      }
    } catch {
      return null;
    }
    ancestor = getComposedParent(ancestor);
  }

  // With no positioned ancestor, an absolutely positioned pseudo uses the
  // initial containing block. Client coordinates make the visible viewport the
  // useful, bounded approximation for deciding whether the pointer can be hit.
  return { x: 0, y: 0, width: viewport.width, height: viewport.height };
}

function pseudoOuterSize(style: CSSStyleDeclaration, axis: 'horizontal' | 'vertical'): number | null {
  const size = computedPixelLength(axis === 'horizontal' ? style.width : style.height);
  if (size === null) return null;
  if (style.boxSizing === 'border-box') return Math.max(0, size);

  const sides = axis === 'horizontal' ? (['Left', 'Right'] as const) : (['Top', 'Bottom'] as const);
  let outerSize = size;
  for (const side of sides) {
    outerSize += computedPixelLength(style[`padding${side}`]) ?? 0;
    outerSize += computedPixelLength(style[`border${side}Width`]) ?? 0;
  }
  return Math.max(0, outerSize);
}

function positionedPseudoAxisRange(
  containingStart: number,
  containingSize: number,
  startValue: string,
  endValue: string,
  outerSize: number | null,
): [number, number] | null {
  const start = computedPixelLength(startValue);
  const end = computedPixelLength(endValue);
  if (start !== null && end !== null) {
    const lower = containingStart + start;
    const upper = containingStart + containingSize - end;
    return upper >= lower ? [lower, upper] : null;
  }
  if (outerSize === null) return null;
  if (start !== null) {
    const lower = containingStart + start;
    return [lower, lower + outerSize];
  }
  if (end !== null) {
    const upper = containingStart + containingSize - end;
    return [upper - outerSize, upper];
  }
  return null;
}

/**
 * Pseudo-elements expose computed styles but no DOM geometry. For paint outside
 * the originating box, accept only positioned boxes whose used pixel insets or
 * size produce a finite axis-aligned bound. This catches common fixed/absolute
 * backdrops without treating unrelated generated text elsewhere as if it
 * covered every pointer position. Unsupported transforms or intrinsic sizing
 * remain non-evidence rather than causing an unbounded DOM/style search.
 */
function positionedPseudoMayCoverPoint(
  el: Element,
  style: CSSStyleDeclaration,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): boolean {
  if (style.transform && style.transform !== 'none') return false;
  const containing = positionedPseudoContainingBounds(el, style.position, viewport);
  if (!containing) return false;

  const horizontal = positionedPseudoAxisRange(
    containing.x,
    containing.width,
    style.left,
    style.right,
    pseudoOuterSize(style, 'horizontal'),
  );
  const vertical = positionedPseudoAxisRange(
    containing.y,
    containing.height,
    style.top,
    style.bottom,
    pseudoOuterSize(style, 'vertical'),
  );
  return Boolean(
    horizontal &&
      vertical &&
      clientX >= horizontal[0] &&
      clientX <= horizontal[1] &&
      clientY >= vertical[0] &&
      clientY <= vertical[1],
  );
}

function elementHasGeneratedPaintAtPoint(
  el: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): boolean {
  if (!browserSupportsPseudoComputedStyle()) return false;
  const hostCoversPoint = elementHasBoxAtPoint(el, clientX, clientY);

  for (const pseudo of GENERATED_PSEUDO_ELEMENTS) {
    try {
      const style = getComputedStyle(el, pseudo);
      if (
        generatedContentPaints(style) &&
        (hostCoversPoint || positionedPseudoMayCoverPoint(el, style, clientX, clientY, viewport))
      ) {
        return true;
      }
    } catch {
      // Modern target browsers expose pseudo-element computed style. If a page
      // makes that inspection fail, piercing would no longer be evidence-based.
      return true;
    }
  }
  return false;
}

/**
 * `elementsFromPoint()` cannot report a painted descendant with
 * `pointer-events:none`, and it reports the originating element rather than a
 * `::before`/`::after` box. Before piercing an otherwise blank branch, inspect
 * its composed subtree for pixels or semantics at the pointer. The scan is
 * deliberately conservative: an incomplete style/layout read, or a tree over
 * the bounded budget, means the branch is kept rather than clicked through.
 */
function branchOwnsPaintAtPoint(
  branchRoot: Element,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
  analyzedStyles: ReadonlyMap<Element, CSSStyleDeclaration>,
): boolean {
  const pending = [branchRoot];
  const visited = new Set<Element>();
  let scanned = 0;

  while (pending.length > 0) {
    const element = pending.pop()!;
    if (visited.has(element)) continue;
    visited.add(element);
    scanned += 1;
    if (scanned > OCCLUDER_SUBTREE_SCAN_LIMIT) return true;

    let style = analyzedStyles.get(element);
    if (!style) {
      try {
        style = getComputedStyle(element);
      } catch {
        return true;
      }
    }
    if (hasOwnSubtreeVisualUnavailableState(style)) continue;

    const coversPoint = elementHasBoxAtPoint(element, clientX, clientY);
    if (
      coversPoint &&
      !hasComputedVisibilityUnavailable(style) &&
      (hasSurfaceDescription(element) || !hasNoOwnVisualPaint(element, style))
    ) {
      return true;
    }
    if (elementHasGeneratedPaintAtPoint(element, clientX, clientY, viewport)) return true;

    pending.push(...composedElementChildren(element));
  }
  return false;
}

/**
 * Whether every element unique to an upper paint-stack branch is a genuinely
 * blank hit-test shim. The first composed ancestor shared with the target
 * branch is structural context (for example a painted application root), not
 * an intervening surface, so it and the rest of the shared ancestry are
 * deliberately excluded.
 */
export function hasOnlyBlankExclusiveOccluders(
  occludingEntries: AnalyzedElement[],
  targetElements: ReadonlySet<Element>,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): boolean {
  const exclusiveEntries: AnalyzedElement[] = [];
  for (const entry of occludingEntries) {
    if (targetElements.has(entry.element)) break;
    if (!looksLikeBlankOccluder(entry)) return false;
    exclusiveEntries.push(entry);
  }

  // The last exclusive entry is the branch root immediately below the first
  // shared composed ancestor, so one bounded subtree walk covers all paint the
  // upper branch owns without inspecting unrelated siblings or the app root.
  const branchRoot = exclusiveEntries.at(-1)?.element;
  const analyzedStyles = new Map(exclusiveEntries.map((entry) => [entry.element, entry.style]));
  return branchRoot
    ? !branchOwnsPaintAtPoint(branchRoot, clientX, clientY, viewport, analyzedStyles)
    : true;
}

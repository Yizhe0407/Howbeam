import type { ResolvedSnapshotTarget } from './snapshot-targeting';
import { snapshotRectKey } from './snapshot-shield-protocol';
import type { Rect } from '@/lib/shared/geometry';

export interface SnapshotSelectionSet {
  /** True when the target (by live element, stable identity, or rect key) is already a mark. */
  isSelected(target: ResolvedSnapshotTarget): boolean;
  /** The mark `target` duplicates, or null. */
  match(target: ResolvedSnapshotTarget): ResolvedSnapshotTarget | null;
  /** Rect-only membership, for region marks that carry no element. */
  hasRect(rect: Rect): boolean;
  /** A mark this page just committed, counted at once (before the background's list arrives). */
  add(target: ResolvedSnapshotTarget): void;
  /** Takes the background's list of marks as the truth: marks not on it are
   * forgotten, and marks on it this page never saw count by their rect. */
  sync(marks: readonly Rect[]): void;
}

/**
 * Which snapshot targets are already marks, so a second click on one is not
 * recorded twice. A target matches by live element (survives text changes),
 * string identity (survives element replacement), or rect key (dedups
 * region/element overlap). Composite targets may opt out of the live-element
 * dimension while keeping their identity and rect.
 *
 * The background owns the list of marks; this set only remembers, per mark,
 * the element and identity this page resolved it from.
 */
export function createSnapshotSelectionSet(): SnapshotSelectionSet {
  /** Every target this page resolved a mark from, by rect key; kept so an undone
   * and then restored mark matches its element again. */
  const seen = new Map<string, ResolvedSnapshotTarget>();
  let identities = new Map<string, ResolvedSnapshotTarget>();
  let elements = new WeakMap<Element, ResolvedSnapshotTarget>();
  let rectKeys = new Map<string, ResolvedSnapshotTarget>();

  const dedupeElementFor = (target: ResolvedSnapshotTarget): Element | null =>
    target.dedupeElement === undefined ? (target.element ?? null) : target.dedupeElement;

  const index = (target: ResolvedSnapshotTarget) => {
    identities.set(target.identity, target);
    const dedupeElement = dedupeElementFor(target);
    if (dedupeElement) elements.set(dedupeElement, target);
    rectKeys.set(snapshotRectKey(target.rect), target);
  };

  const match = (target: ResolvedSnapshotTarget): ResolvedSnapshotTarget | null => {
    const dedupeElement = dedupeElementFor(target);
    return (
      (dedupeElement ? elements.get(dedupeElement) : undefined) ??
      identities.get(target.identity) ??
      rectKeys.get(snapshotRectKey(target.rect)) ??
      null
    );
  };

  return {
    isSelected: (target) => match(target) !== null,
    match,
    hasRect: (rect) => rectKeys.has(snapshotRectKey(rect)),
    add(target) {
      seen.set(snapshotRectKey(target.rect), target);
      index(target);
    },
    sync(marks) {
      identities = new Map();
      elements = new WeakMap();
      rectKeys = new Map();
      for (const rect of marks) {
        const key = snapshotRectKey(rect);
        index(seen.get(key) ?? { rect, identity: `mark:${key}`, text: '', tagName: 'mark' });
      }
    },
  };
}

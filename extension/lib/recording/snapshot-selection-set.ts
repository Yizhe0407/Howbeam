import type { ResolvedSnapshotTarget } from './snapshot-targeting';
import { snapshotRectKey } from './snapshot-shield-protocol';
import type { Rect } from '@/lib/shared/geometry';

export interface SnapshotSelectionSet {
  /** True when the target (by live element, stable identity, or rect key) was
   * already annotated on the current snapshot. */
  isSelected(target: ResolvedSnapshotTarget): boolean;
  /** The annotated target `target` duplicates, or null. */
  match(target: ResolvedSnapshotTarget): ResolvedSnapshotTarget | null;
  /** Rect-only membership, for region annotations that carry no element. */
  hasRect(rect: Rect): boolean;
  /** Records a committed annotation and invalidates any pending redo. */
  add(target: ResolvedSnapshotTarget): void;
  /** Removes the most recent annotation and parks it for a single restore. */
  undoLast(): ResolvedSnapshotTarget | null;
  /** Re-adds the last undone annotation, if any. */
  restoreUndone(): ResolvedSnapshotTarget | null;
}

/**
 * Pure bookkeeping for which snapshot targets are already annotated. Ordinary
 * targets are tracked by live element (survives text changes), string identity
 * (survives element replacement), and rect key (dedups region/element overlap).
 * Composite targets may opt out of the live-element dimension while retaining
 * their composite identity and rect membership.
 */
export function createSnapshotSelectionSet(): SnapshotSelectionSet {
  const identities = new Map<string, ResolvedSnapshotTarget>();
  const elements = new WeakMap<Element, ResolvedSnapshotTarget>();
  const rectKeys = new Map<string, ResolvedSnapshotTarget>();
  const history: ResolvedSnapshotTarget[] = [];
  let undoneTarget: ResolvedSnapshotTarget | null = null;

  const dedupeElementFor = (target: ResolvedSnapshotTarget): Element | null =>
    target.dedupeElement === undefined ? (target.element ?? null) : target.dedupeElement;

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
    hasRect(rect) {
      return rectKeys.has(snapshotRectKey(rect));
    },
    add(target) {
      const dedupeElement = dedupeElementFor(target);
      identities.set(target.identity, target);
      if (dedupeElement) elements.set(dedupeElement, target);
      rectKeys.set(snapshotRectKey(target.rect), target);
      history.push(target);
      undoneTarget = null;
    },
    undoLast() {
      const target = history.pop() ?? null;
      if (target) {
        const dedupeElement = dedupeElementFor(target);
        identities.delete(target.identity);
        if (dedupeElement) elements.delete(dedupeElement);
        rectKeys.delete(snapshotRectKey(target.rect));
        undoneTarget = target;
      }
      return target;
    },
    restoreUndone() {
      if (!undoneTarget) return null;
      const target = undoneTarget;
      const dedupeElement = dedupeElementFor(target);
      identities.set(target.identity, target);
      if (dedupeElement) elements.set(dedupeElement, target);
      rectKeys.set(snapshotRectKey(target.rect), target);
      history.push(target);
      undoneTarget = null;
      return target;
    },
  };
}

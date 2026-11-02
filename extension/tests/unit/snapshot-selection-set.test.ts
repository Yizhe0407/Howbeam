// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { buildSnapshotTargetIdentity } from '@/lib/capture/selector/snapshot-identity';
import { createSnapshotSelectionSet } from '@/lib/recording/snapshot-selection-set';
import type { SnapshotShieldRect } from '@/lib/recording/snapshot-shield-protocol';
import type { ResolvedSnapshotTarget } from '@/lib/recording/snapshot-targeting';

function createTarget(
  identity: string,
  rect: SnapshotShieldRect,
  element?: Element,
  dedupeElement?: Element | null,
): ResolvedSnapshotTarget {
  return {
    element,
    dedupeElement,
    identity,
    rect,
    text: '',
    tagName: element?.tagName.toLowerCase() ?? 'region',
  };
}

function createSharedMapTargets(): {
  first: ResolvedSnapshotTarget;
  second: ResolvedSnapshotTarget;
} {
  const firstImage = document.createElement('img');
  const secondImage = document.createElement('img');
  const map = document.createElement('map');
  const area = document.createElement('area');
  firstImage.useMap = '#shared-map';
  secondImage.useMap = '#shared-map';
  map.name = 'shared-map';
  map.append(area);
  document.body.append(firstImage, secondImage, map);

  const areaIdentity = buildSnapshotTargetIdentity(area);
  return {
    first: createTarget(
      `${areaIdentity}::image-map::${buildSnapshotTargetIdentity(firstImage)}`,
      { x: 10, y: 20, width: 100, height: 50 },
      area,
      null,
    ),
    second: createTarget(
      `${areaIdentity}::image-map::${buildSnapshotTargetIdentity(secondImage)}`,
      { x: 210, y: 20, width: 100, height: 50 },
      area,
      null,
    ),
  };
}

afterEach(() => document.body.replaceChildren());

describe('createSnapshotSelectionSet', () => {
  it('allows distinct images sharing one map while deduping the same area+image target', () => {
    const selection = createSnapshotSelectionSet();
    const { first, second } = createSharedMapTargets();

    selection.add(first);

    expect(selection.isSelected({ ...first, rect: { x: 400, y: 20, width: 100, height: 50 } })).toBe(true);
    expect(selection.isSelected(second)).toBe(false);

    selection.add(second);

    expect(selection.isSelected(first)).toBe(true);
    expect(selection.isSelected(second)).toBe(true);
  });

  it('keeps live Element dedup as the default for ordinary targets', () => {
    const selection = createSnapshotSelectionSet();
    const button = document.createElement('button');
    document.body.append(button);
    const original = createTarget('button:original', { x: 10, y: 10, width: 80, height: 30 }, button);
    const moved = createTarget('button:moved', { x: 200, y: 100, width: 80, height: 30 }, button);

    selection.add(original);

    expect(selection.isSelected(moved)).toBe(true);
  });

  it('names the annotated target a click duplicates, until it is undone', () => {
    const selection = createSnapshotSelectionSet();
    const button = document.createElement('button');
    document.body.append(button);
    const original = createTarget('button:original', { x: 10, y: 10, width: 80, height: 30 }, button);
    const other = createTarget('region:other', { x: 300, y: 300, width: 40, height: 40 });

    selection.add(original);
    selection.add(other);

    expect(selection.match(createTarget('button:moved', { x: 200, y: 100, width: 80, height: 30 }, button))).toBe(original);
    expect(selection.match(createTarget('region:other', { x: 0, y: 0, width: 1, height: 1 }))).toBe(other);
    expect(selection.match(createTarget('region:new', { x: 500, y: 500, width: 10, height: 10 }))).toBeNull();

    selection.undoLast();
    expect(selection.match(other)).toBeNull();
  });

  it('removes and restores every dedup dimension for composite targets', () => {
    const selection = createSnapshotSelectionSet();
    const { first, second } = createSharedMapTargets();
    selection.add(first);
    selection.add(second);

    expect(selection.undoLast()).toBe(second);
    expect(selection.isSelected(first)).toBe(true);
    expect(selection.isSelected(second)).toBe(false);

    expect(selection.restoreUndone()).toBe(second);
    expect(selection.isSelected(first)).toBe(true);
    expect(selection.isSelected(second)).toBe(true);
    expect(selection.restoreUndone()).toBeNull();
  });
});
